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
// A group with `car` (the archive as one CARv1 file, by its own CID) is copied from that file
// instead: one request downloads it, then the same pieces are cut locally and imported with the
// same checks (every block a piece names is in the file, each import stores exactly the blocks
// sent, the pinned root import and pin/ls prove the DAG complete). Pieces are cut in post-order,
// each block after the blocks it links to, at most ATLAS_PIECE_MB (default 8) each.
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
      if (!known.has(g.cid)) out.push({ county: `${page.state}/${page.county}`, key: `${key}.cid`, kind: 'archive', cid: g.cid, ...(g.car ? { car: g.car } : {}) });
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
  pieceBytes: Number(process.env.ATLAS_PIECE_MB ?? 8) * 1024 * 1024,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  log: console.log,
  tmp: undefined,
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

export async function transferArchive(root, deps = {}) {
  const d = { ...defaults(), ...deps };
  const bytes = await rawBlock(root, root, d);
  const index = decode(bytes);
  if (index.label !== 'CountyIndex' || !Array.isArray(index.shards)) throw new TransferFailed(root, 'not a CountyIndex block');
  const block = await singleBlockCar(root, bytes);
  const tally = { seen: new Set([root]), bytes: bytes.length };
  d.log(`archive ${root}: ${index.shards.length} shard(s), ${index.properties} properties, ${d.parallel} subtree(s) at a time`);
  d.log(`imported ${root} (root block): ${await importCar(root, block, root, 1, false, d)}`);
  await pool(index.shards.map((s, i) => () => transferSubtree(root, `${root}/shards/${i}`, s.toString(), tally, d)), d.parallel);
  d.log(`imported ${root} (root block, pin-roots=true): ${await importCar(root, block, root, 1, true, d)}`);
  await requirePinned(root, d);
  d.log(`pinned ${root}: ${tally.seen.size} distinct blocks, ${tally.bytes} bytes copied`);
}

const DAG_JSON = 0x0129;
const RAW = 0x55;

/** Every CID a decoded dag-json value links to, in order. */
function linksOf(value, out = []) {
  const cid = CID.asCID(value);
  if (cid) out.push(cid);
  else if (Array.isArray(value)) for (const v of value) linksOf(v, out);
  else if (value && typeof value === 'object' && !(value instanceof Uint8Array)) for (const v of Object.values(value)) linksOf(v, out);
  return out;
}

/** CAR of `blocks` rooted at the last one (in post-order, the subtree's top), as a Blob. */
async function piecesCar(blocks) {
  const { writer, out } = CarWriter.create([blocks.at(-1).cid]);
  const chunks = [];
  const collected = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collected;
  return new Blob([Buffer.concat(chunks)], { type: 'application/vnd.ipld.car' });
}

/**
 * Import the subtree under `top` out of the local CAR, in post-order pieces of at most
 * `d.pieceBytes`. A block already claimed by another subtree (`sent`) is skipped; a block the file
 * lacks is TransferFailed.
 */
async function transferLocalSubtree(root, reader, top, sent, tally, d) {
  let piece = [];
  let size = 0;
  const flush = async () => {
    if (!piece.length) return;
    const blocks = piece;
    piece = [];
    size = 0;
    await importCar(root, await piecesCar(blocks), blocks.at(-1).cid.toString(), blocks.length, false, d);
  };
  // Iterative post-order: a block is emitted after every block it links to.
  const stack = [{ cid: top, expanded: false }];
  while (stack.length) {
    const entry = stack.pop();
    const key = entry.cid.toString();
    if (!entry.expanded) {
      if (sent.has(key)) continue;
      sent.add(key);
      const block = await reader.get(entry.cid);
      if (!block) throw new TransferFailed(root, `the car file is missing block ${key}`);
      entry.block = block;
      entry.expanded = true;
      stack.push(entry);
      const code = entry.cid.code;
      if (code === DAG_JSON) for (const link of linksOf(decode(block.bytes)).reverse()) stack.push({ cid: link, expanded: false });
      else if (code !== RAW) throw new TransferFailed(root, `block ${key} has codec 0x${code.toString(16)}, which the car transfer does not walk`);
      continue;
    }
    piece.push(entry.block);
    size += entry.block.bytes.length;
    tally.seen.add(key);
    tally.bytes += entry.block.bytes.length;
    if (size >= d.pieceBytes) await flush();
  }
  await flush();
}

/** Copy an archive from its `car` file: download it once, then import it shard by shard in post-order pieces, then pin the root. */
export async function transferArchiveFromCar(root, car, deps = {}) {
  const d = { ...defaults(), ...deps };
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  const file = join(d.tmp, `${root}.car`);
  const res = await gatewayGet(root, car, '*/*', d);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const reader = await CarIndexedReader.fromFile(file);
  try {
    const roots = (await reader.getRoots()).map(String);
    if (!roots.includes(root)) throw new TransferFailed(root, `car file ${car} has roots [${roots.join(', ')}]`);
    const rootBlock = await reader.get(CID.parse(root));
    if (!rootBlock) throw new TransferFailed(root, `car file ${car} lacks the root block`);
    const digest = await sha256.digest(rootBlock.bytes);
    if (Buffer.compare(digest.bytes, CID.parse(root).multihash.bytes) !== 0) throw new TransferFailed(root, `car file ${car}: root block does not hash to the CID`);
    const index = decode(rootBlock.bytes);
    if (index.label !== 'CountyIndex' || !Array.isArray(index.shards)) throw new TransferFailed(root, 'not a CountyIndex block');
    const block = await singleBlockCar(root, rootBlock.bytes);
    const tally = { seen: new Set([root]), bytes: rootBlock.bytes.length };
    const sent = new Set([root]);
    d.log(`archive ${root} from car file ${car}: ${index.shards.length} shard(s), ${index.properties} properties, ${d.parallel} shard(s) at a time, pieces up to ${d.pieceBytes} bytes`);
    await pool(index.shards.map((s) => () => transferLocalSubtree(root, reader, CID.asCID(s) ?? CID.parse(String(s)), sent, tally, d)), d.parallel);
    d.log(`imported ${root} (root block, pin-roots=true): ${await importCar(root, block, root, 1, true, d)}`);
    await requirePinned(root, d);
    d.log(`pinned ${root}: ${tally.seen.size} distinct blocks, ${tally.bytes} bytes copied`);
  } finally {
    await reader.close();
    await unlink(file).catch(() => {});
  }
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
    console.log(`transferring ${t.county} ${t.key} ${t.cid}${t.car ? ` from car file ${t.car}` : ''}`);
    try {
      if (t.kind === 'tables') await transferTables(t.cid);
      else if (t.car) await transferArchiveFromCar(t.cid, t.car);
      else await transferArchive(t.cid);
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
