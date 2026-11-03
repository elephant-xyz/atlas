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
//      ATLAS_FETCH_PARALLEL requests at a time (default 16), written into one CAR rooted at the
//      cid. Gateways walk a DAG block by block, so one stream per archive is the bottleneck for
//      archives of millions of small blocks; parallel shard requests add up. The CLI then checks
//      every block of the assembled CAR exactly as before.
// Gateways: first that answers wins, a 429 puts a gateway on cooldown, the gateway that served
// the CAR is preferred afterwards, one deadline (ATLAS_GATEWAY_DEADLINE_MINUTES) per group.
// The CAR is deleted after the checks. The CLI comes from ELEPHANT_CLI (default: elephant-cli).
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { CarBlockIterator, CarIndexedReader, CarWriter } from '@ipld/car';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { gatewayClient, gatewayList } from './gateways.mjs';
import { changedGroups, pagesAt, readPages } from './lib.mjs';

const CLI = process.env.ELEPHANT_CLI ?? 'elephant-cli';
const CSV = process.env.ATLAS_VALIDATION_CSV ?? 'validation-errors.csv';
const DEADLINE_MS = Number(process.env.ATLAS_GATEWAY_DEADLINE_MINUTES ?? 20) * 60_000;
const PARALLEL = Number(process.env.ATLAS_FETCH_PARALLEL ?? 16);
const ROOT_PROBE_MS = 2 * 60_000;

/** Run the CLI on a CAR; returns { ok, report } where report is the CLI's stdout/stderr. */
export function validateCar(file, csv, cli = CLI, run = spawnSync) {
  const r = run(cli, ['validate', file, '--output-csv', csv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const report = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => l && !/browserslist|update-browserslist-db|unknown format/i.test(l)).join('\n');
  return { ok: r.status === 0, report: r.error ? `${r.error.message}\n${report}` : report };
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
    let problem;
    if (!size) problem = 'empty body';
    else {
      try {
        const reader = await CarIndexedReader.fromFile(file);
        try {
          const roots = (await reader.getRoots()).map(String);
          const block = await reader.get(CID.parse(cid));
          if (!roots.includes(cid)) problem = `CAR roots are [${roots.join(', ')}]`;
          else if (!block) problem = 'root block missing from the CAR';
          else await verified(url, block.bytes, cid);
        } finally {
          await reader.close();
        }
      } catch (e) {
        problem = e.message.startsWith(url) ? e.message.slice(url.length + 2) : `not a CAR (${e.message})`;
      }
    }
    if (!problem) return { url, size };
    d.log(`${url}: ${problem} (${size} bytes)`);
    gw.reject(url);
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
  if (d.parallel > 1) {
    const index = await rootIndex(cid, d);
    if (index?.node?.label === 'CountyIndex' && Array.isArray(index.node.shards) && index.node.shards.length > 1) return downloadByShard(gw, cid, index, file, d);
    d.log(index ? `archive ${cid}: root is not a multi-shard CountyIndex; downloading the whole CAR` : `archive ${cid}: root block not served within ${ROOT_PROBE_MS / 60_000} min; downloading the whole CAR`);
  }
  return downloadCar(gw, cid, file, d);
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
  const d = { fetch: globalThis.fetch, gateways: gatewayList(), deadlineMs: DEADLINE_MS, validateCar: (file) => validateCar(file, CSV), csv: CSV, log: console.log, sleep: undefined, now: undefined, parallel: PARALLEL, ...deps };
  const gw = gatewayClient({ gateways: d.gateways, fetch: d.fetch, deadlineMs: d.deadlineMs, sleep: d.sleep, now: d.now, log: d.log });
  d.shardClient ??= () => gatewayClient({ gateways: d.gateways, fetch: d.fetch, deadlineMs: d.deadlineMs, sleep: d.sleep, now: d.now, log: d.log });

  // 1. The whole archive by root, then the CLI.
  const dir = await mkdtemp(join(tmpdir(), 'atlas-verify-'));
  const file = join(dir, `${cid}.car`);
  try {
    const { url, size } = await downloadArchive(gw, cid, file, d);
    d.log(`downloaded ${url} (${size} bytes, root block verified)`);
    const { ok, report } = d.validateCar(file);
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
