#!/usr/bin/env node
// Transfer every root this push published into the elephant-atlas bucket: every group cid and
// tables root at HEAD that no group held at HEAD~1 (first parent). Each root is exported from
// the IPFS network as CAR through the gateway list (see gateways.mjs) and imported with dag/import, bounded piece by piece so a runner
// never holds a whole county: the root block alone (pin-roots=false), then one shard or one
// Parquet part at a time through a temp file, then the root block again with pin-roots=true
// so the recursive pin sees a complete DAG, verified with pin/ls. pin/add is never called:
// Filebase does not serve a bucket's inner blocks to nodes outside the owning account.
//
// The copy is proven complete before it counts: every dag/import must report exactly the
// blocks the CAR carried, the final pinned import must return the root with no pin error
// (Filebase returns nothing and pins nothing when a child is missing), and pin/ls must list
// the root recursively. Any of those failing is a publication failure.
//
// Exit 1 with GITHUB_OUTPUT failed_root/failed_reason/county when no gateway can serve a
// root or the copy is incomplete (the workflow reverts); exit 2 on any other error
// (credentials, RPC; re-dispatch). --all transfers every root on the page, not only new ones.
//
// TODO: unpin roots of withdrawn groups; nothing is unpinned yet.
import { appendFileSync, createWriteStream, openAsBlob, readFileSync } from 'node:fs';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { CarIndexedReader, CarReader, CarWriter } from '@ipld/car';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { fetchMirrorCar } from './car-mirror.mjs';
import { rpc as filebaseRpc } from './filebase.mjs';
import { fetchFromAny, gatewayList, withGatewayToken } from './gateways.mjs';
import { groupsOf, pagesAt, rootsOf } from './lib.mjs';

export class TransferFailed extends Error {
  constructor(cid, reason) {
    super(`transfer ${cid}: ${reason}`);
    this.cid = cid;
    this.reason = reason;
  }
}

/** [{ county: 'FL/lee', key: 'county.cid', kind: 'archive' | 'tables', cid }] for every root at HEAD that no group at base held. */
export function rootsToTransfer(headPages, basePages) {
  const known = rootsOf(basePages);
  const out = [];
  for (const { page } of headPages) {
    for (const [key, g] of groupsOf(page)) {
      if (!known.has(g.cid)) out.push({ county: `${page.state}/${page.county}`, key: `${key}.cid`, kind: 'archive', cid: g.cid });
      if (!known.has(g.tables)) out.push({ county: `${page.state}/${page.county}`, key: `${key}.tables`, kind: 'tables', cid: g.tables });
    }
  }
  return out;
}

const defaults = () => ({
  fetch: withGatewayToken(),
  rpc: filebaseRpc,
  gateways: gatewayList(),
  deadlineMs: Number(process.env.ATLAS_GATEWAY_DEADLINE_MINUTES ?? 20) * 60_000,
  // One request streams a whole shard subtree; gateways walk it block by block, so a large shard
  // can take longer than 15 minutes on a shared gateway.
  requestMs: Number(process.env.ATLAS_REQUEST_MINUTES ?? 60) * 60_000,
  parallel: Number(process.env.ATLAS_TRANSFER_PARALLEL ?? 32),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  log: console.log,
  tmp: undefined,
  mirror: (cid, file) => fetchMirrorCar(cid, file, { log: console.log }),
});

/** GET /ipfs/<path> from the first gateway that answers, retrying the whole list with backoff until the deadline; all failing through the deadline is TransferFailed. */
async function gatewayGet(root, path, accept, d) {
  const started = d.now();
  let last;
  for (let wait = 5_000; ; wait = Math.min(wait * 2, 60_000)) {
    try {
      const { res, url } = await fetchFromAny(path, { gateways: d.gateways, fetch: d.fetch, headers: { accept }, requestMs: d.requestMs });
      d.log(`fetched ${url}`);
      return res;
    } catch (e) {
      last = e.message;
    }
    d.log(`/ipfs/${path}: ${last}`);
    if (d.now() - started + wait > d.deadlineMs) throw new TransferFailed(root, `/ipfs/${path} not available from any gateway within ${d.deadlineMs / 60_000} min: ${last}`);
    await d.sleep(wait);
  }
}

async function rawBlock(root, cid, d) {
  const res = await gatewayGet(root, `${cid}?format=raw`, 'application/vnd.ipld.raw', d);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await sha256.digest(bytes);
  if (Buffer.compare(digest.bytes, CID.parse(cid).multihash.bytes) !== 0) throw new TransferFailed(root, `${cid}: bytes do not hash to the CID`);
  return bytes;
}

/** A CAR holding one block, as a Blob. */
async function singleBlockCar(cid, bytes) {
  const parsed = CID.parse(cid);
  const { writer, out } = CarWriter.create([parsed]);
  const chunks = [];
  const collected = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await writer.put({ cid: parsed, bytes });
  await writer.close();
  await collected;
  return new Blob([Buffer.concat(chunks)], { type: 'application/vnd.ipld.car' });
}

/** Distinct blocks and bytes in a CAR, without keeping the blocks. */
async function carBlocks(bytes, tally) {
  const reader = await CarReader.fromBytes(bytes);
  let count = 0;
  for await (const { cid, bytes: b } of reader.blocks()) {
    count++;
    const key = cid.toString();
    if (!tally.seen.has(key)) {
      tally.seen.add(key);
      tally.bytes += b.length;
    }
  }
  return count;
}

/**
 * dag/import a CAR of `count` blocks and require the node to report exactly that many blocks
 * and, when pinning, the root with no pin error. Filebase answers a pinned import of an
 * incomplete DAG with an empty body and no pin, so a missing Root on the pinned import means
 * the copy is incomplete: TransferFailed. A persistent RPC error is not a TransferFailed.
 */
async function importCar(root, blob, expect, count, pinRoots, d) {
  const form = new FormData();
  form.append('file', blob, 'import.car');
  let lines;
  for (let attempt = 1; ; attempt++) {
    try {
      lines = await d.rpc(`dag/import?pin-roots=${pinRoots}&stats=true`, { body: form, timeoutMs: 15 * 60_000 });
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      d.log(`dag/import attempt ${attempt}: ${e.message}`);
      await d.sleep(10_000 * attempt);
    }
  }
  const rootLine = lines.find((l) => l.Root)?.Root;
  const got = rootLine?.Cid?.['/'];
  if (got !== expect || rootLine.PinErrorMsg) {
    const why = got === undefined ? 'the node returned no root' : got !== expect ? `root ${got}, expected ${expect}` : rootLine.PinErrorMsg;
    if (pinRoots) throw new TransferFailed(root, `pinned import of ${expect} did not pin: ${why}; the copy is incomplete`);
    throw new Error(`dag/import ${expect}: ${why}`);
  }
  const stats = lines.find((l) => l.Stats)?.Stats;
  if (!stats || stats.BlockCount !== count) throw new TransferFailed(root, `dag/import of ${expect} stored ${stats?.BlockCount ?? 'no'} blocks, sent ${count}`);
  return `${stats.BlockCount} blocks, ${stats.BlockBytesCount} bytes`;
}

/** Run `jobs` (functions returning promises), `n` at a time; the first rejection rejects. */
async function pool(jobs, n) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
}

/** Export <path>?format=car to a temp file, count its blocks, import it (pin-roots=false), delete the file. */
async function transferSubtree(root, path, expect, tally, d) {
  const res = await gatewayGet(root, `${path}?format=car`, 'application/vnd.ipld.car', d);
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  const file = join(d.tmp, `${expect}.car`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  try {
    const count = await carBlocks(readFileSync(file), tally);
    d.log(`imported ${path}: ${await importCar(root, await openAsBlob(file), expect, count, false, d)}`);
  } finally {
    await unlink(file).catch(() => {});
  }
}

async function requirePinned(root, d) {
  for (let attempt = 1; ; attempt++) {
    try {
      const [ls] = await d.rpc(`pin/ls?arg=${root}&type=recursive`);
      if (ls?.Keys?.[root]) return;
      throw new Error('not listed');
    } catch (e) {
      if (attempt === 3) throw new TransferFailed(root, `not pinned recursively after import (${e.message})`);
      await d.sleep(10_000);
    }
  }
}

/** Every block reachable from `start` in a local CAR, as a CAR Blob; dag-json blocks link onward. */
async function localSubtree(reader, start) {
  const isLink = (v) => v && typeof v === 'object' && v.asCID === v;
  const links = (v, out) => {
    if (isLink(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => links(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => links(x, out));
    return out;
  };
  const { writer, out } = CarWriter.create([start]);
  const chunks = [];
  const collected = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const cid = stack.pop();
    const key = cid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const block = await reader.get(cid);
    if (!block) throw new Error(`block ${key} is not in the mirror CAR`);
    await writer.put(block);
    if (cid.code === 0x0129) links(decode(block.bytes), stack);
  }
  await writer.close();
  await collected;
  return new Blob([Buffer.concat(chunks)], { type: 'application/vnd.ipld.car' });
}

/**
 * When the archive's CAR is in a mirror bucket, import it from that local copy instead of the
 * gateways: each shard subtree as its own CAR (block counts checked by importCar), d.parallel at
 * a time. Resolves true when it did, false when there is no usable mirror object.
 */
async function transferFromMirror(root, index, tally, d) {
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  const file = join(d.tmp, `${root}.mirror.car`);
  const mirror = d.mirror ? await d.mirror(root, file) : undefined;
  if (!mirror) return false;
  const reader = await CarIndexedReader.fromFile(file);
  try {
    const roots = (await reader.getRoots()).map(String);
    if (!roots.includes(root)) {
      d.log(`${mirror.url}: CAR roots are [${roots.join(', ')}]; using the gateways`);
      return false;
    }
    d.log(`importing ${root} from ${mirror.url}`);
    await pool(index.shards.map((shard) => async () => {
      const blob = await localSubtree(reader, shard);
      const count = await carBlocks(new Uint8Array(await blob.arrayBuffer()), tally);
      d.log(`imported shard ${shard} from the mirror: ${await importCar(root, blob, shard.toString(), count, false, d)}`);
    }), d.parallel);
    return true;
  } finally {
    await reader.close();
    await unlink(file).catch(() => {});
  }
}

export async function transferArchive(root, deps = {}) {
  const d = { ...defaults(), ...deps };
  const bytes = await rawBlock(root, root, d);
  const index = decode(bytes);
  if (index.label !== 'CountyIndex' || !Array.isArray(index.shards)) throw new TransferFailed(root, 'not a CountyIndex block');
  const block = await singleBlockCar(root, bytes);
  const tally = { seen: new Set([root]), bytes: bytes.length };
  d.log(`archive ${root}: ${index.shards.length} shard(s), ${index.properties} properties, ${d.parallel} subtree(s) at a time`);
  d.log(`imported ${root} (root block): ${await importCar(root, block, root, 1, false, d)}`);
  if (!(await transferFromMirror(root, index, tally, d))) await pool(index.shards.map((s, i) => () => transferSubtree(root, `${root}/shards/${i}`, s.toString(), tally, d)), d.parallel);
  d.log(`imported ${root} (root block, pin-roots=true): ${await importCar(root, block, root, 1, true, d)}`);
  await requirePinned(root, d);
  d.log(`pinned ${root}: ${tally.seen.size} distinct blocks, ${tally.bytes} bytes copied`);
}

export async function transferTables(root, deps = {}) {
  const d = { ...defaults(), ...deps };
  const bytes = await rawBlock(root, root, d);
  const tables = decode(bytes);
  if (tables.label !== 'CountyTables' || !tables.tables) throw new TransferFailed(root, 'not a CountyTables block');
  const block = await singleBlockCar(root, bytes);
  const tally = { seen: new Set([root]), bytes: bytes.length };
  const names = Object.keys(tables.tables).sort();
  d.log(`tables ${root}: ${names.length} table(s), ${names.reduce((n, t) => n + tables.tables[t].parts.length, 0)} part(s)`);
  d.log(`imported ${root} (root block): ${await importCar(root, block, root, 1, false, d)}`);
  const jobs = names.flatMap((name) => tables.tables[name].parts.map((part, i) => () => transferSubtree(root, `${root}/tables/${name}/parts/${i}/cid`, part.cid.toString(), tally, d)));
  await pool(jobs, d.parallel);
  d.log(`imported ${root} (root block, pin-roots=true): ${await importCar(root, block, root, 1, true, d)}`);
  await requirePinned(root, d);
  d.log(`pinned ${root}: ${tally.seen.size} distinct blocks, ${tally.bytes} bytes copied (the county_root link is pinned by the archive transfer)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const all = process.argv.includes('--all');
  const targets = rootsToTransfer(pagesAt('HEAD', root), all ? [] : (pagesAt('HEAD~1', root) ?? []));
  if (!targets.length) console.log('no new roots to transfer');
  for (const t of targets) {
    console.log(`transferring ${t.county} ${t.key} ${t.cid}`);
    try {
      await (t.kind === 'tables' ? transferTables : transferArchive)(t.cid);
    } catch (e) {
      if (!(e instanceof TransferFailed)) {
        console.error(e.stack ?? e.message);
        process.exit(2);
      }
      console.error(`FAIL ${t.county} ${t.key}: ${e.message}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `failed_root=${t.cid}\nfailed_reason=${e.reason}\ncounty=${t.county}\n`);
      process.exit(1);
    }
  }
}
