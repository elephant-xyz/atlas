#!/usr/bin/env node
// The pull-request gate for every group whose cid, schema, or tables changed relative to
// origin/main (or every group with --all). Nothing is resolved by path: public gateways do not
// resolve paths reliably for content they do not pin.
//   1. The archive is downloaded by root (`/ipfs/<cid>?format=car`) from the first gateway that
//      answers with a CAR whose root block is the cid and hashes to it (an empty or root-less
//      2xx counts as that gateway failing), streamed to disk, and `elephant-cli validate` runs on it: every block must hash
//      to its CID and all six checks (integrity, root, index, graph, lexicon, orphans) must be
//      clean. The error CSV is left at ATLAS_VALIDATION_CSV for the workflow to upload.
//   2. From that local CAR: the root block hashes to the cid and is a CountyIndex with shards,
//      shard 0 has properties, property 0 decodes with a label, and the page's schema CID is a
//      key of property 0's data_groups.
//   3. The schema block is fetched by CID, hashed, and must be a data-group JSON Schema.
//   4. The tables block is fetched by CID, hashed, must be a CountyTables whose county_root is
//      the cid, and every part of every table must serve its root block by its own CID (`?format=raw`, hashed).
//      An archive with several shards is downloaded faster: its root block by CID (hashed), then
//      every shard's subtree (`/ipfs/<shard cid>?format=car`, root checked and hashed) with
//      ATLAS_FETCH_PARALLEL requests at a time (default 32), written into one CAR rooted at the
//      cid. Gateways walk a DAG block by block, so one stream per archive is the bottleneck for
//      archives of millions of small blocks; parallel shard requests add up. The CLI then checks
//      every block of the assembled CAR exactly as before.
//      Fastest: when `<cid>.car` exists in a mirror bucket (see car-mirror.mjs), it is read over
//      S3 instead of the gateways, then checked exactly like a gateway download.
//      The record checks run as ATLAS_CLI_PARALLEL CLI processes (default: one per CPU) over
//      slices of the archive: each slice is a CAR holding a subset of the shards under its own
//      CountyIndex root (property count summed from those shards); together the slices hold
//      every shard of the real index, and the real root is checked in step 2.
// Gateways: first that answers wins, a 429 puts a gateway on cooldown, the gateway that served
// the CAR is preferred afterwards, one deadline (ATLAS_GATEWAY_DEADLINE_MINUTES) per group.
// The CAR is deleted after the checks. The CLI comes from ELEPHANT_CLI (default: elephant-cli).
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { CarBlockIterator, CarIndexedReader, CarWriter } from '@ipld/car';
import * as dagJson from '@ipld/dag-json';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { fetchMirrorCar } from './car-mirror.mjs';
import { gatewayClient, gatewayList, withGatewayToken } from './gateways.mjs';
import { changedGroups, pagesAt, readPages } from './lib.mjs';

const CLI = process.env.ELEPHANT_CLI ?? 'elephant-cli';
const CSV = process.env.ATLAS_VALIDATION_CSV ?? 'validation-errors.csv';
const DEADLINE_MS = Number(process.env.ATLAS_GATEWAY_DEADLINE_MINUTES ?? 20) * 60_000;
const PARALLEL = Number(process.env.ATLAS_FETCH_PARALLEL ?? 32);
const ROOT_PROBE_MS = 2 * 60_000;
const CLI_PARALLEL = Number(process.env.ATLAS_CLI_PARALLEL ?? availableParallelism());

/** Run the CLI on a CAR; returns { ok, report } where report is the CLI's stdout/stderr. */
export function validateCar(file, csv, cli = CLI, run = spawnSync) {
  const r = run(cli, ['validate', file, '--output-csv', csv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const report = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => l && !/browserslist|update-browserslist-db|unknown format/i.test(l)).join('\n');
  return { ok: r.status === 0, report: r.error ? `${r.error.message}\n${report}` : report };
}

/** The same, without blocking, so several slices validate at once. */
export function validateCarAsync(file, csv, cli = CLI, run = spawn) {
  return new Promise((resolve) => {
    const child = run(cli, ['validate', file, '--output-csv', csv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('error', (e) => resolve({ ok: false, report: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, report: out.split('\n').filter((l) => l && !/browserslist|update-browserslist-db|unknown format/i.test(l)).join('\n') }));
  });
}

async function verified(what, bytes, expectCid) {
  const digest = await sha256.digest(bytes);
  if (Buffer.compare(digest.bytes, CID.parse(expectCid).multihash.bytes) !== 0) throw new Error(`${what}: bytes do not hash to ${expectCid}`);
  return bytes;
}

function asNode(what, bytes) {
  try {
    return decode(bytes);
  } catch (e) {
    throw new Error(`${what}: not dag-json (${e.message})`);
  }
}

function require_(cond, what, msg) {
  if (!cond) throw new Error(`${what}: ${msg}`);
}

/** Stream `<cid>?format=car` to `file` from a gateway whose CAR actually carries the hashed root; loop until one does or the deadline passes. */
async function downloadCar(gw, cid, file, d) {
  for (;;) {
    const { res, url } = await gw.get(`${cid}?format=car`, { headers: { accept: 'application/vnd.ipld.car' }, requestMs: 60 * 60_000 });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    const size = statSync(file).size;
    const problem = await carProblem(file, cid, url);
    if (!problem) return { url, size };
    d.log(`${url}: ${problem} (${size} bytes)`);
    gw.reject(url);
  }
}

/** Why `file` is not a CAR rooted at `cid` whose root block hashes to it; undefined when it is. */
async function carProblem(file, cid, url) {
  if (!statSync(file).size) return 'empty body';
  try {
    const reader = await CarIndexedReader.fromFile(file);
    try {
      const roots = (await reader.getRoots()).map(String);
      const block = await reader.get(CID.parse(cid));
      if (!roots.includes(cid)) return `CAR roots are [${roots.join(', ')}]`;
      if (!block) return 'root block missing from the CAR';
      await verified(url, block.bytes, cid);
      return undefined;
    } finally {
      await reader.close();
    }
  } catch (e) {
    return e.message.startsWith(url) ? e.message.slice(url.length + 2) : `not a CAR (${e.message})`;
  }
}

/**
 * The archive's root block, hashed and decoded; undefined when no gateway serves it within
 * ROOT_PROBE_MS. Retried with the gateway client, so a 429 cools a gateway down instead of
 * sending a large archive to the single-stream download.
 */
async function rootIndex(cid, d) {
  try {
    const probe = gatewayClient({ gateways: d.gateways, fetch: d.fetch, deadlineMs: Math.min(d.deadlineMs, ROOT_PROBE_MS), sleep: d.sleep, now: d.now, log: d.log });
    const { res, url } = await probe.get(`${cid}?format=raw`, { headers: { accept: 'application/vnd.ipld.raw' } });
    const bytes = await verified(url, new Uint8Array(await res.arrayBuffer()), cid);
    return { bytes, node: decode(bytes) };
  } catch {
    return undefined;
  }
}

/**
 * Download every shard's subtree as its own CAR, `d.parallel` at a time, then write one CAR rooted
 * at `cid`: the root block, then each shard CAR's blocks in shard order. A block two shards share
 * appears twice, which a CAR allows. The CLI hashes every block of the result.
 */
async function downloadByShard(gw, cid, index, file, d) {
  const shards = index.node.shards.map(String);
  const dir = dirname(file);
  const parts = new Array(shards.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= shards.length) return;
      parts[i] = join(dir, `shard-${i}.car`);
      // Each shard gets its own gateway client, so the retry deadline bounds one shard, not the whole archive.
      await downloadCar(d.shardClient ? d.shardClient() : gw, shards[i], parts[i], d);
      if (++done % 25 === 0 || done === shards.length) d.log(`downloaded ${done}/${shards.length} shard CARs`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(d.parallel, shards.length) }, worker));
  const root = CID.parse(cid);
  const { writer, out } = CarWriter.create([root]);
  const written = pipeline(Readable.from(out), createWriteStream(file));
  await writer.put({ cid: root, bytes: index.bytes });
  for (const part of parts) {
    for await (const blk of await CarBlockIterator.fromIterable(createReadStream(part))) await writer.put(blk);
    await rm(part, { force: true });
  }
  await writer.close();
  await written;
  return { url: `${d.gateways[0]}/ipfs/${cid} (root block + ${shards.length} shard CARs, ${Math.min(d.parallel, shards.length)} at a time)`, size: statSync(file).size };
}

/** Shard by shard when the root is a CountyIndex with several shards and parallel fetches are enabled; else the whole CAR by root. */
async function downloadArchive(gw, cid, file, d) {
  const mirror = d.mirror ? await d.mirror(cid, file) : undefined;
  if (mirror) {
    const problem = await carProblem(file, cid, mirror.url);
    if (!problem) return { url: mirror.url, size: statSync(file).size };
    d.log(`${mirror.url}: ${problem}; using the gateways`);
  }
  if (d.parallel > 1) {
    const index = await rootIndex(cid, d);
    if (index?.node?.label === 'CountyIndex' && Array.isArray(index.node.shards) && index.node.shards.length > 1) return downloadByShard(gw, cid, index, file, d);
    d.log(index ? `archive ${cid}: root is not a multi-shard CountyIndex; downloading the whole CAR` : `archive ${cid}: root block not served within ${ROOT_PROBE_MS / 60_000} min; downloading the whole CAR`);
  }
  return downloadCar(gw, cid, file, d);
}

/**
 * Write slice CARs of the archive at `file`: each holds a contiguous run of the real index's
 * shards, every block reachable from them, and its own CountyIndex root declaring the summed
 * property count. Together the slices cover every shard exactly once.
 */
async function writeSlices(file, cid, k, dir) {
  const reader = await CarIndexedReader.fromFile(file);
  const isLink = (v) => v && typeof v === 'object' && v.asCID === v;
  const links = (v, out) => {
    if (isLink(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => links(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => links(x, out));
    return out;
  };
  try {
    const index = decode((await reader.get(CID.parse(cid))).bytes);
    const size = Math.ceil(index.shards.length / k);
    const files = [];
    for (let s = 0; s < index.shards.length; s += size) {
      const part = index.shards.slice(s, s + size);
      const shardKeys = new Set(part.map(String));
      const order = [];
      const seen = new Set();
      const stack = [...part];
      let properties = 0;
      // The root needs the property count, so walk first and stream the blocks afterwards.
      while (stack.length) {
        const c = stack.pop();
        const key = c.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        order.push(c);
        if (c.code === dagJson.code) {
          const node = decode((await reader.get(c)).bytes);
          if (shardKeys.has(key)) properties += Array.isArray(node.properties) ? node.properties.length : 0;
          links(node, stack);
        }
      }
      const rootBytes = dagJson.encode({ label: 'CountyIndex', properties, shards: part, version: index.version });
      const rootCid = CID.create(1, dagJson.code, await sha256.digest(rootBytes));
      const out = join(dir, `slice-${files.length}.car`);
      const { writer, out: stream } = CarWriter.create([rootCid]);
      const written = pipeline(Readable.from(stream), createWriteStream(out));
      await writer.put({ cid: rootCid, bytes: rootBytes });
      for (const c of order) await writer.put(await reader.get(c));
      await writer.close();
      await written;
      files.push(out);
    }
    return files;
  } finally {
    await reader.close();
  }
}

/** The CLI over the whole archive, or over slices in parallel when it has several shards and ATLAS_CLI_PARALLEL > 1. */
async function validateArchive(file, cid, d) {
  if (d.cliParallel > 1 && d.validateCarAsync) {
    const reader = await CarIndexedReader.fromFile(file);
    let shards = 0;
    try {
      const node = decode((await reader.get(CID.parse(cid))).bytes);
      shards = node?.label === 'CountyIndex' && Array.isArray(node.shards) ? node.shards.length : 0;
    } finally {
      await reader.close();
    }
    if (shards > 1) {
      const slices = await writeSlices(file, cid, Math.min(d.cliParallel, shards), dirname(file));
      d.log(`archive ${cid}: validating ${shards} shards as ${slices.length} slices in parallel`);
      const results = await Promise.all(slices.map((f, i) => d.validateCarAsync(f, `${d.csv}.${i}`)));
      const rows = [];
      for (let i = 0; i < slices.length; i++) {
        try {
          const lines = readFileSync(`${d.csv}.${i}`, 'utf8').split('\n').filter(Boolean);
          if (!rows.length && lines.length) rows.push(lines[0]);
          rows.push(...lines.slice(1));
        } catch {}
        await rm(slices[i], { force: true });
        await rm(`${d.csv}.${i}`, { force: true });
      }
      if (rows.length) writeFileSync(d.csv, rows.join('\n') + '\n');
      return { ok: results.every((r) => r.ok), report: results.map((r, i) => `slice ${i}: ${r.report}`).join('\n') };
    }
  }
  return d.validateCar(file);
}

/** A hashed, decoded block out of the local CAR. */
async function carNode(reader, cid, what) {
  const block = await reader.get(CID.parse(cid));
  require_(block, what, `block ${cid} is not in the CAR`);
  return asNode(what, await verified(what, block.bytes, cid));
}

/** A raw block by CID from the gateways, hashed. */
async function fetchBlock(gw, cid) {
  const { res, url } = await gw.get(`${cid}?format=raw`, { headers: { accept: 'application/vnd.ipld.raw' } });
  return { url, bytes: await verified(url, new Uint8Array(await res.arrayBuffer()), cid) };
}

export async function verifyGroup({ cid, schema, tables }, deps = {}) {
  const d = { fetch: withGatewayToken(), gateways: gatewayList(), deadlineMs: DEADLINE_MS, validateCar: (file) => validateCar(file, CSV), csv: CSV, log: console.log, sleep: undefined, now: undefined, parallel: PARALLEL, cliParallel: CLI_PARALLEL, validateCarAsync: (file, csv) => validateCarAsync(file, csv), mirror: (cid, file) => fetchMirrorCar(cid, file, { log: console.log }), ...deps };
  const gw = gatewayClient({ gateways: d.gateways, fetch: d.fetch, deadlineMs: d.deadlineMs, sleep: d.sleep, now: d.now, log: d.log });
  d.shardClient ??= () => gatewayClient({ gateways: d.gateways, fetch: d.fetch, deadlineMs: d.deadlineMs, sleep: d.sleep, now: d.now, log: d.log });

  // 1. The whole archive by root, then the CLI.
  const dir = await mkdtemp(join(tmpdir(), 'atlas-verify-'));
  const file = join(dir, `${cid}.car`);
  try {
    const { url, size } = await downloadArchive(gw, cid, file, d);
    d.log(`downloaded ${url} (${size} bytes, root block verified)`);
    const { ok, report } = await validateArchive(file, cid, d);
    d.log(report);
    require_(ok, `archive ${cid}`, `elephant-cli validate failed; see ${d.csv}`);

    // 2. Shape and schema claim, from the local CAR only.
    const reader = await CarIndexedReader.fromFile(file);
    try {
      const roots = (await reader.getRoots()).map(String);
      require_(roots.includes(cid), `archive ${cid}`, `CAR roots are [${roots.join(', ')}]`);
      const index = await carNode(reader, cid, `archive ${cid}`);
      require_(index.label === 'CountyIndex', `archive ${cid}`, `label is ${JSON.stringify(index.label)}, expected CountyIndex`);
      require_(Array.isArray(index.shards) && index.shards.length > 0, `archive ${cid}`, 'missing non-empty `shards`');
      const shard = await carNode(reader, index.shards[0].toString(), `archive ${cid} shard 0`);
      require_(Array.isArray(shard.properties) && shard.properties.length > 0, `archive ${cid} shard 0`, 'missing non-empty `properties`');
      const first = shard.properties[0];
      const property = await carNode(reader, first.property_cid?.toString(), `archive ${cid} property 0`);
      require_(typeof property.label === 'string', `archive ${cid} property 0`, 'missing `label`');
      const dataGroups = Object.keys(first.data_groups ?? {});
      require_(dataGroups.includes(schema), `archive ${cid} property 0`, `data_groups keys are [${dataGroups.join(', ')}]; the page claims schema ${schema}`);
      d.log(`archive ${cid}: CountyIndex, ${index.shards.length} shard(s), property 0 carries schema ${schema}`);
    } finally {
      await reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 3. The schema, by CID.
  const schemaBlock = await fetchBlock(gw, schema);
  let schemaDoc;
  try {
    schemaDoc = JSON.parse(Buffer.from(schemaBlock.bytes).toString('utf8'));
  } catch (e) {
    throw new Error(`${schemaBlock.url}: not JSON (${e.message})`);
  }
  require_(schemaDoc?.properties?.label && schemaDoc?.properties?.relationships, schemaBlock.url, 'not a data-group schema: `properties` must have `label` and `relationships`');
  d.log(`fetched ${schemaBlock.url} (${schemaBlock.bytes.length} bytes): data-group schema`);

  // 4. The tables root and every part, by CID.
  const tablesBlock = await fetchBlock(gw, tables);
  const tablesNode = asNode(tablesBlock.url, tablesBlock.bytes);
  require_(tablesNode.label === 'CountyTables', tablesBlock.url, `label is ${JSON.stringify(tablesNode.label)}, expected CountyTables`);
  require_(tablesNode.county_root?.toString() === cid, tablesBlock.url, `county_root is ${tablesNode.county_root}, expected ${cid}`);
  const names = Object.keys(tablesNode.tables ?? {}).sort();
  require_(names.length > 0, tablesBlock.url, 'missing non-empty `tables`');
  d.log(`fetched ${tablesBlock.url} (${tablesBlock.bytes.length} bytes): CountyTables for ${cid}, ${names.length} table(s)`);
  const missing = [];
  let checked = 0;
  for (const name of names) {
    for (const [i, part] of (tablesNode.tables[name].parts ?? []).entries()) {
      const partCid = part.cid?.toString();
      try {
        // Trustless form: public gateways answer a plain /ipfs/<cid> with 429 (Retry-After 900)
        // but serve ?format=raw. The part's root block, hashed; a raw-leaf part is the whole file.
        await fetchBlock(gw, partCid);
        checked++;
      } catch (e) {
        missing.push(`${name}/parts/${i} ${partCid}`);
        d.log(`part ${name}/parts/${i} ${partCid}: ${e.message}`);
      }
    }
  }
  d.log(`checked ${checked} part(s) by CID${missing.length ? `, ${missing.length} unavailable` : ''}`);
  require_(!missing.length, `tables ${tables}`, `part(s) not available from any gateway: ${missing.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const all = process.argv.includes('--all');
  const targets = changedGroups(readPages(root), all ? null : pagesAt('origin/main', root));
  if (!targets.length) console.log('no changed groups to verify');
  else console.log(`gateways, in order: ${gatewayList().join(', ')}`);
  let failed = 0;
  for (const t of targets) {
    console.log(`verifying ${t.path} group ${t.key} cid ${t.cid} schema ${t.schema} tables ${t.tables}`);
    try {
      await verifyGroup(t);
      console.log(`ok ${t.path} group ${t.key}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${t.path} group ${t.key}: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
