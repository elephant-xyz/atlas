#!/usr/bin/env node
// Transfer every published root the registry does not hold yet into the elephant-atlas bucket:
// the new roots of every group at HEAD whose cid or tables the committed index.json does not
// list. The index is written only after a transfer, so that is every publication still owed,
// including one whose own run was cancelled or superseded because several merges landed close
// together; a run started by one merge finishes the others too. Each root is exported from
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
// One group failing does not stop the run. A group whose roots did not all arrive is "held"
// and the run goes on with the other counties; the index step lists only what is pinned.
//   withdrawn  the publication itself is wrong (no gateway can serve a root, the copy is
//              incomplete, another group holds the root): the workflow takes it off main
//   deferred   anything that is not, or may not be, the publication's fault (credentials, RPC,
//              an outage, a published root that would not transfer again, another county's
//              publication in a --county run): it stays on main for the next run
// A failure is blamed on a publication with care, because being wrong costs its author hours:
//   - Only while the service works. After each failure, and once before the first transfer, a
//     root the registry already published must still be served by a gateway (bytes hashed) and
//     listed as pinned by Filebase (see `outage`). When it is not, nothing is withdrawn, the
//     failing group is deferred and so is everything after it, unattempted. An outage before
//     the first transfer exits 2 with nothing done.
//   - Once per run. That check cannot see the network failing to deliver content Filebase does
//     not hold yet, so several publications failing together prove nothing about any of them:
//     the first is withdrawn (what a run did when it handled one merge), the rest are deferred.
// Each root is transferred in a process of its own (see inChild), so one that exhausts the heap
// or hangs ends that process and is deferred like any other error, and the roots after it are
// still tried. A root gets at most ATLAS_ROOT_MINUTES (default 180) and the whole run
// ATLAS_RUN_MINUTES (default 300), after which what is left is deferred unattempted: the step
// ends inside the 6-hour job limit and the index step still runs.
// The held groups are written to the file ATLAS_HELD as JSON and GITHUB_OUTPUT gets
// `withdrawn=<n>`. Exit 1 when anything was held. --all transfers every root on
// main again. --county ST/name transfers every root of that county again, and what the other
// counties are owed as usual (the run replaces theirs in the queue), but a transfer that fails
// withdraws only its own.
//
// A group with `car` (the archive as one CARv1 file, by its own CID) is copied from that file
// instead: one request downloads it, then the same pieces are cut locally and imported with the
// same checks (every block a piece names is in the file, each import stores exactly the blocks
// sent, the pinned root import and pin/ls prove the DAG complete). Pieces are cut in post-order,
// each block after the blocks it links to, at most ATLAS_PIECE_MB (default 8) each.
//
// TODO: unpin roots of withdrawn groups; nothing is unpinned yet.
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { CarReader, CarWriter } from '@ipld/car';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { openCar } from './car-file.mjs';
import { pinStatus, poll, rpc as filebaseRpc } from './filebase.mjs';
import { fetchFromAny, gatewayList, withGatewayToken } from './gateways.mjs';
import { claimOrder, groupsOf, heldFor, holdConflicts, holdOf, indexAt, isOwed, latestPublished, pagesAt, pool, publishedGroup, rootsOf, sleep } from './lib.mjs';

export class TransferFailed extends Error {
  constructor(cid, reason) {
    super(`transfer ${cid}: ${reason}`);
    this.cid = cid;
    this.reason = reason;
  }
}

/** The two roots of a group, archive first: [{ county: 'FL/lee', key: 'county.cid', kind: 'archive', cid, car? }, { ..., key: 'county.tables', kind: 'tables', cid }]. */
const groupRoots = (county, key, g) => [
  { county, key: `${key}.cid`, kind: 'archive', cid: g.cid, ...(g.car ? { car: g.car } : {}) },
  { county, key: `${key}.tables`, kind: 'tables', cid: g.tables },
];

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
  // A pinned import makes Filebase pin the whole DAG before it answers: over 30 minutes for
  // Travis's 11.3M blocks.
  pinMs: Number(process.env.ATLAS_PIN_MINUTES ?? 180) * 60_000,
  pinPollMs: Number(process.env.ATLAS_PIN_POLL_MINUTES ?? 5) * 60_000,
  skipStored: process.env.ATLAS_SKIP_STORED_SHARDS === '1',
  sleep,
  now: Date.now,
  log: console.log,
  tmp: undefined,
});

/** GET /ipfs/<path> from the first gateway that answers, retrying the whole list with backoff until the deadline; all failing through the deadline is TransferFailed. */
async function gatewayGet(root, path, accept, d) {
  const started = d.now();
  let last;
  for (let wait = 5_000; ; wait = Math.min(wait * 2, 60_000)) {
    d.signal?.throwIfAborted();
    try {
      const { res, url } = await fetchFromAny(path, { gateways: d.gateways, fetch: d.fetch, headers: { accept }, requestMs: d.requestMs, signal: d.signal });
      d.log(`fetched ${url}`);
      return res;
    } catch (e) {
      d.signal?.throwIfAborted();
      last = e.message;
    }
    d.log(`/ipfs/${path}: ${last}`);
    if (d.now() - started + wait > d.deadlineMs) throw new TransferFailed(root, `/ipfs/${path} not available from any gateway within ${d.deadlineMs / 60_000} min: ${last}`);
    await d.sleep(wait);
  }
}

/**
 * A hashed block decoded as dag-json. A block that hashes to its CID and still does not decode is
 * the publication's own content and will never decode: a TransferFailed, not an error to retry.
 */
function decodeBlock(root, what, bytes) {
  try {
    return decode(bytes);
  } catch (e) {
    throw new TransferFailed(root, `${what} is not dag-json (${e.message})`);
  }
}

/** Whether `bytes` are the block `cid` names. Gateways are not trusted: every block kept from one is checked. */
const hashesTo = async (bytes, cid) => Buffer.compare((await sha256.digest(bytes)).bytes, CID.parse(cid).multihash.bytes) === 0;

async function rawBlock(root, cid, d) {
  const res = await gatewayGet(root, `${cid}?format=raw`, 'application/vnd.ipld.raw', d);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(await hashesTo(bytes, cid))) throw new TransferFailed(root, `${cid}: bytes do not hash to the CID`);
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
      d.signal?.throwIfAborted();
      lines = await d.rpc(`dag/import?pin-roots=${pinRoots}&stats=true`, { body: form, timeoutMs: pinRoots ? d.pinMs : 15 * 60_000, signal: d.signal });
      break;
    } catch (e) {
      d.signal?.throwIfAborted();
      // A pinned import that outlives Filebase's proxy (HTTP 504 at 60 minutes) is not re-sent:
      // the pin carries on behind the proxy, and pinRoot watches pin/ls for it instead.
      if (pinRoots && isProxyTimeout(e)) throw e;
      // Filebase drops connections and answers 500 under load; back off and try again.
      if (attempt === 6) throw e;
      d.log(`dag/import attempt ${attempt}: ${e.message}`);
      await d.sleep(15_000 * attempt);
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

/** Whether Filebase can serve `cid` at once (not only from this bucket: block/get also finds network blocks). */
async function hasBlock(cid, d) {
  try {
    await d.rpc(`block/get?arg=${cid}`, { timeoutMs: d.presenceMs ?? 30_000 });
    return true;
  } catch (e) {
    return e instanceof SyntaxError; // the block came back but is not JSON lines (rpc parses them)
  }
}

/** Export <path>?format=car to a temp file, count its blocks, import it (pin-roots=false), delete the file. */
async function transferSubtree(root, path, expect, tally, d) {
  const res = await gatewayGet(root, `${path}?format=car`, 'application/vnd.ipld.car', d);
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  const file = join(d.tmp, `${expect}.car`);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    const count = await carBlocks(readFileSync(file), tally);
    d.log(`imported ${path}: ${await importCar(root, await openAsBlob(file), expect, count, false, d)}`);
  } finally {
    await unlink(file).catch(() => {});
  }
}

/** Filebase's nginx proxy ends a request after 60 minutes with HTTP 504, whatever the client allows. */
const isProxyTimeout = (e) => /HTTP 504\b/.test(e?.message ?? '');

/**
 * Pin `root`, whose DAG is already in the bucket, and prove it pinned. A pinned import makes Filebase
 * pin the whole DAG before it answers, and its proxy gives up on any request after 60 minutes: King
 * County's 8.9M blocks (2026-11-12) were all stored by 17:51, the pinned import answered HTTP 504 at
 * 18:51, and re-sending it ran the root out of time at 19:26. So:
 *   - a root pin/ls already lists (a pin a timed-out run left behind) is not imported again;
 *   - a pinned import that times out at the proxy is not re-sent: pin/ls is polled every
 *     ATLAS_PIN_POLL_MINUTES (default 5) for up to ATLAS_PIN_MINUTES;
 *   - a pin that never appears is an ordinary error, so the root is deferred, never withdrawn:
 *     a slow pin is Filebase's load, not the publication's fault.
 */
async function pinRoot(root, block, d) {
  if ((await pinStatus(root, { call: d.rpc })).pinned) {
    d.log(`${root} is already pinned recursively; no pinned import needed`);
  } else {
    try {
      d.log(`imported ${root} (root block, pin-roots=true): ${await importCar(root, block, root, 1, true, d)}`);
    } catch (e) {
      if (!isProxyTimeout(e)) throw e;
      const minutes = Math.round(d.pinMs / 60_000);
      d.log(`pinned import of ${root} timed out at the Filebase proxy (HTTP 504); polling pin/ls for up to ${minutes} min`);
      const pinned = await poll(async () => (await pinStatus(root, { call: d.rpc })).pinned, { limitMs: d.pinMs, intervalMs: d.pinPollMs, sleep: d.sleep, now: d.now });
      if (!pinned) throw new Error(`${root} was not pinned within ${minutes} min of the pinned import timing out at the Filebase proxy`);
    }
  }
  await requirePinned(root, d);
}

async function requirePinned(root, d) {
  const { pinned, why } = await pinStatus(root, { call: d.rpc, tries: 3, sleep: d.sleep });
  if (!pinned) throw new TransferFailed(root, `not pinned recursively after import (${why})`);
}

export async function transferArchive(root, deps = {}) {
  const d = { ...defaults(), ...deps };
  const bytes = await rawBlock(root, root, d);
  const index = decodeBlock(root, `root block ${root}`, bytes);
  if (index.label !== 'CountyIndex' || !Array.isArray(index.shards)) throw new TransferFailed(root, 'not a CountyIndex block');
  const block = await singleBlockCar(root, bytes);
  const tally = { seen: new Set([root]), bytes: bytes.length };
  d.log(`archive ${root}: ${index.shards.length} shard(s), ${index.properties} properties, ${d.parallel} subtree(s) at a time`);
  d.log(`imported ${root} (root block): ${await importCar(root, block, root, 1, false, d)}`);
  // One temp dir for every shard: the jobs get their own copy of the deps (for the pool's signal), so it is made first.
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  await pool(index.shards.map((s, i) => (signal) => transferSubtree(root, `${root}/shards/${i}`, s.toString(), tally, { ...d, signal })), d.parallel);
  await pinRoot(root, block, d);
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
  // `sent[i]` marks a block Filebase has confirmed (its piece imported). A block only queued in
  // another shard's unconfirmed piece is not sent: Filebase holds an import open while any block in
  // it links to a block the bucket lacks, so two shards skipping each other's queued blocks
  // deadlock. Blocks shared across shards are therefore sent by each shard that needs them before
  // they are confirmed (imports are idempotent). `mine` dedups within this shard's walk.
  const mine = new Uint8Array(reader.size);
  let piece = [];
  let size = 0;
  const flush = async () => {
    if (!piece.length) return;
    const blocks = piece;
    piece = [];
    size = 0;
    await importCar(root, await piecesCar(blocks.map((e) => e.block)), blocks.at(-1).block.cid.toString(), blocks.length, false, d);
    for (const { slot, block } of blocks) {
      if (sent[slot]) continue;
      sent[slot] = 1;
      tally.blocks++;
      tally.bytes += block.bytes.length;
    }
  };
  // Iterative post-order: a block is emitted after every block it links to, and pieces of one
  // shard import in order, so every link of a piece is in it or already confirmed.
  const stack = [{ cid: top, expanded: false }];
  while (stack.length) {
    const entry = stack.pop();
    const key = entry.cid.toString();
    if (!entry.expanded) {
      const i = reader.slotOf(key);
      if (i === undefined) throw new TransferFailed(root, `the car file is missing block ${key}`);
      if (sent[i] || mine[i]) continue;
      mine[i] = 1;
      const block = await reader.get(key);
      entry.block = block;
      entry.slot = i;
      entry.expanded = true;
      stack.push(entry);
      const code = entry.cid.code;
      if (code === DAG_JSON) for (const link of linksOf(decodeBlock(root, `block ${key} of the car file`, block.bytes)).reverse()) stack.push({ cid: link, expanded: false });
      else if (code !== RAW) throw new TransferFailed(root, `block ${key} has codec 0x${code.toString(16)}, which the car transfer does not walk`);
      continue;
    }
    piece.push({ slot: entry.slot, block: entry.block });
    size += entry.block.bytes.length;
    if (size >= d.pieceBytes) await flush();
  }
  await flush();
  d.log?.(`shard ${top} confirmed (${tally.blocks} distinct blocks so far)`);
}

/** Copy an archive from its `car` file: download it once, then import it shard by shard in post-order pieces, then pin the root. */
export async function transferArchiveFromCar(root, car, deps = {}) {
  const d = { ...defaults(), ...deps };
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  const file = join(d.tmp, `${root}.car`);
  let reader;
  // The download is inside the try: a run goes on after a failure, and a partial multi-GB file
  // left behind would fill the runner's disk for the counties after it.
  try {
    const res = await gatewayGet(root, car, '*/*', d);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    // The whole file arrived; if it does not open as a CAR it never will.
    reader = await openCar(file).catch((e) => Promise.reject(new TransferFailed(root, `car file ${car} is not a readable CAR (${e.message})`)));
    const roots = (await reader.getRoots()).map(String);
    if (!roots.includes(root)) throw new TransferFailed(root, `car file ${car} has roots [${roots.join(', ')}]`);
    const rootBlock = await reader.get(CID.parse(root));
    if (!rootBlock) throw new TransferFailed(root, `car file ${car} lacks the root block`);
    if (!(await hashesTo(rootBlock.bytes, root))) throw new TransferFailed(root, `car file ${car}: root block does not hash to the CID`);
    const index = decodeBlock(root, `root block of car file ${car}`, rootBlock.bytes);
    if (index.label !== 'CountyIndex' || !Array.isArray(index.shards)) throw new TransferFailed(root, 'not a CountyIndex block');
    const block = await singleBlockCar(root, rootBlock.bytes);
    // One flag per distinct block (a Set of 11M CID strings would double the index's memory).
    const tally = { blocks: 1, bytes: rootBlock.bytes.length };
    const sent = new Uint8Array(reader.size);
    sent[reader.slotOf(root)] = 1;
    d.log(`archive ${root} from car file ${car}: ${index.shards.length} shard(s), ${index.properties} properties, ${d.parallel} shard(s) at a time, pieces up to ${d.pieceBytes} bytes`);
    // A shard root Filebase holds means its whole subtree is there: an import that links a block
    // the bucket lacks never returns, so every block was stored only after everything it links to.
    // Checked 4 at a time before any upload (many at once time out; a miss only re-sends the shard).
    const shards = index.shards.map((s) => CID.asCID(s) ?? CID.parse(String(s)));
    // Off unless ATLAS_SKIP_STORED_SHARDS=1: block/get also answers for blocks Filebase finds on the
    // IPFS network, so on an empty bucket it reported all 48 Travis permit shards stored.
    const held = new Set();
    if (d.skipStored) await pool(shards.map((s) => async () => (await hasBlock(s.toString(), d)) && held.add(s.toString())), 4);
    d.log(`${held.size}/${shards.length} shard(s) already in the bucket; sending the rest`);
    await pool(shards.filter((s) => !held.has(s.toString())).map((s) => (signal) => transferLocalSubtree(root, reader, s, sent, tally, { ...d, signal })), d.parallel);
    await pinRoot(root, block, d);
    d.log(`pinned ${root}: ${tally.blocks} distinct blocks, ${tally.bytes} bytes copied`);
  } finally {
    await reader?.close();
    await unlink(file).catch(() => {});
  }
}

/**
 * What a run does with every group on `pages`, given `index` (the committed index.json):
 * `targets` are the roots to transfer, each with its page `path`, `group` key, whether the group
 * is `owed` (the index does not list its cid and tables) and whether it is `inScope`, and `held`
 * the groups it will not transfer because they collide on a root (see holdConflicts in lib.mjs;
 * `claimed` gives the order the groups got their roots in). An owed group transfers the roots
 * the index lacks. `all` transfers every root. `only` (ST/name) transfers every root of that
 * county and leaves the others as they are, owed groups included: the run replaces theirs in
 * the queue, so it must publish them, but they are out of scope and a failed transfer never
 * withdraws them.
 */
export function planTransfers(pages, index, { all = false, only, claimed } = {}) {
  const published = publishedGroup(index);
  const known = rootsOf((index?.counties ?? []).map((page) => ({ page })));
  const targets = [];
  for (const { path, page } of pages) {
    const county = `${page.state}/${page.county}`;
    const inScope = !only || county === only;
    for (const [key, g] of groupsOf(page)) {
      const owed = isOwed(published(path, key), g);
      const roots = groupRoots(county, key, g).map((t) => ({ ...t, path, group: key, owed, inScope }));
      if (all || (only && inScope)) targets.push(...roots);
      else if (owed) targets.push(...roots.filter((t) => !known.has(t.cid)));
    }
  }
  const held = holdConflicts(pages, index, [], { claimed });
  return { targets: targets.filter((t) => !heldFor(held, t.path, t.group)), held };
}

/**
 * What is wrong with the service itself, or undefined when it works, judged on `canaries`, roots
 * the registry already published: for one of them, some gateway must serve the root block
 * (hashed, like every block taken from a gateway) and Filebase must list it as pinned. One is
 * enough: a published root that has itself gone missing is that root's problem, and must not
 * stop every publication, the re-transfer that would repair it included. Three rounds, so a
 * blip is not an outage. Without canaries (an empty registry) there is nothing to judge by and
 * the service is taken to work. It proves the registry's own copy is reachable, not that the
 * network delivers content Filebase does not hold yet; runTransfers allows for that.
 */
export async function outage(canaries, deps = {}) {
  const d = { ...defaults(), ...deps };
  if (!canaries.length) return undefined;
  const served = async (cid) => {
    const problems = [];
    for (const gateway of d.gateways) {
      try {
        const { res, url } = await fetchFromAny(`${cid}?format=raw`, { gateways: [gateway], fetch: d.fetch, headers: { accept: 'application/vnd.ipld.raw' }, requestMs: 60_000 });
        if (await hashesTo(new Uint8Array(await res.arrayBuffer()), cid)) return undefined;
        problems.push(`${url}: bytes do not hash to the CID`);
      } catch (e) {
        problems.push(e.message);
      }
    }
    return `no gateway serves the published root ${cid} (${problems.join('; ')})`;
  };
  let problem;
  for (let round = 1; round <= 3; round++) {
    if (round > 1) await d.sleep(10_000);
    for (const cid of canaries) {
      problem = await served(cid);
      if (problem) continue;
      const { pinned, why } = await pinStatus(cid, { call: d.rpc });
      if (pinned) return undefined;
      problem = why === 'not listed' ? `Filebase does not list the published root ${cid} as pinned` : `Filebase does not answer for the published root ${cid} (${why})`;
    }
  }
  return problem;
}

/**
 * Transfer every target of a plan and return the groups held back, or undefined when the service
 * was already down before the first transfer (nothing was done). `transfer(target, { timeoutMs })`
 * copies one root and `down()` resolves to what is wrong with the service, if anything. A root
 * gets `rootMs` at most and the run `budgetMs`; what does not fit is deferred unattempted.
 */
export async function runTransfers(pages, index, options, { transfer, down, log = console.log, error = console.error, now = Date.now, budgetMs = Infinity, rootMs = Infinity }) {
  const started = now();
  // The plan's collision holds only keep the losing groups out of the transfers: who really
  // loses is settled at the end, on what the transfers did. A group that lost a root to one
  // whose transfer then failed is publishable after all, and the next run transfers it.
  const { targets, held: notNow } = planTransfers(pages, index, options);
  const held = [];
  const hold = (t, kind, reason) => held.push(holdOf(pages.find((p) => p.path === t.path), t.group, kind, t.cid, reason));
  for (const h of notNow) log(`not transferred for now: ${h.county} ${h.key}: ${h.reason}`);
  if (!targets.length) log('no roots to transfer');
  else {
    const broken = await down();
    if (broken) {
      error(`nothing transferred: ${broken}`);
      return undefined;
    }
  }
  let blamed = false; // this run has withdrawn a publication for failing to transfer
  for (const [i, t] of targets.entries()) {
    if (heldFor(held, t.path, t.group)) continue; // its archive failed: the tables root has nothing to point at
    const rest = () => targets.slice(i).filter((r) => !heldFor(held, r.path, r.group));
    const left = budgetMs - (now() - started);
    if (left <= 0) {
      for (const r of rest()) if (!heldFor(held, r.path, r.group)) hold(r, 'deferred', 'not attempted: the run was out of time');
      break;
    }
    log(`transferring ${t.county} ${t.key} ${t.cid}${t.car ? ` from car file ${t.car}` : ''}`);
    try {
      await transfer(t, { timeoutMs: Math.min(rootMs, left) });
    } catch (e) {
      const broken = await down();
      // Only a new publication of this run's own scope can be at fault, and only while the service works.
      const atFault = !broken && t.owed && t.inScope && e instanceof TransferFailed;
      const kind = atFault && !blamed ? 'withdrawn' : 'deferred';
      const note = broken ? `; and ${broken}` : atFault && blamed ? '; not withdrawn: this run already withdrew a publication, and several failing together may be the network' : '';
      if (kind === 'withdrawn') blamed = true;
      if (!(e instanceof TransferFailed)) error(e.stack ?? e.message);
      error(`FAIL ${t.county} ${t.key} (${kind}): ${e.message}${note}`);
      hold(t, kind, `${t.owed ? '' : 'already published, but it would not transfer again: '}${e.reason ?? e.message}${note}`);
      if (broken) {
        for (const r of rest()) if (!heldFor(held, r.path, r.group)) hold(r, 'deferred', `not attempted: ${broken}`);
        break;
      }
    }
  }
  const before = held.map((h) => h.kind);
  holdConflicts(pages, index, held, options);
  for (const [i, h] of held.entries()) if (h.kind !== before[i]) log(`${h.kind} ${h.county} ${h.key}: ${h.reason}`);
  return held;
}

/** Copy one target, unless an earlier run already pinned it (a re-run after a later root failed). */
async function transferOne(t) {
  if ((await pinStatus(t.cid)).pinned) return console.log(`already pinned ${t.cid}; skipped`);
  if (t.kind === 'tables') await transferTables(t.cid);
  else if (t.car) await transferArchiveFromCar(t.cid, t.car);
  else await transferArchive(t.cid);
}

/**
 * Copy one target in a process of its own, with `timeoutMs` at most. Indexing a county-sized CAR
 * can exhaust the heap, and a process that dies or hangs must cost that root only: here it is
 * an ordinary Error (deferred), and the run goes on. The child (`argv`, this script by default,
 * given `--one <target> --result <file>`) writes { ok } or { failed: reason } (a TransferFailed)
 * or { error } to the file; its temp files live in a directory removed here whatever happens.
 */
export async function inChild(t, timeoutMs, argv = [fileURLToPath(import.meta.url)]) {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-root-'));
  const result = join(dir, 'result.json');
  try {
    const child = spawn(process.execPath, [...argv, '--one', JSON.stringify(t), '--result', result], { stdio: 'inherit', env: { ...process.env, TMPDIR: dir }, ...(Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}) });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (...ended) => resolve(ended));
    });
    let said = {};
    try {
      said = JSON.parse(readFileSync(result, 'utf8'));
    } catch {
      // no result: the process did not get that far
    }
    if (code === 0 && said.ok) return;
    if (said.failed) throw new TransferFailed(t.cid, said.failed);
    throw new Error(said.error ?? `the transfer process ended on ${signal ?? `exit code ${code}`} without a result (out of memory, or out of time)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function transferTables(root, deps = {}) {
  const d = { ...defaults(), ...deps };
  const bytes = await rawBlock(root, root, d);
  const tables = decodeBlock(root, `tables block ${root}`, bytes);
  if (tables.label !== 'CountyTables' || !tables.tables) throw new TransferFailed(root, 'not a CountyTables block');
  const block = await singleBlockCar(root, bytes);
  const tally = { seen: new Set([root]), bytes: bytes.length };
  const names = Object.keys(tables.tables).sort();
  d.log(`tables ${root}: ${names.length} table(s), ${names.reduce((n, t) => n + tables.tables[t].parts.length, 0)} part(s)`);
  // The tables block goes in last: Filebase holds a dag/import open while any block it carries
  // links to something the bucket lacks, so importing it before its parts never returns.
  d.tmp ??= await mkdtemp(join(tmpdir(), 'atlas-transfer-'));
  const jobs = names.flatMap((name) => tables.tables[name].parts.map((part, i) => (signal) => transferSubtree(root, `${root}/tables/${name}/parts/${i}/cid`, part.cid.toString(), tally, { ...d, signal })));
  await pool(jobs, d.parallel);
  await pinRoot(root, block, d);
  d.log(`pinned ${root}: ${tally.seen.size} distinct blocks, ${tally.bytes} bytes copied (the county_root link is pinned by the archive transfer)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  // --one <target json> --result <file>: one root, as the child process of inChild.
  if (arg('--one')) {
    try {
      await transferOne(JSON.parse(arg('--one')));
      writeFileSync(arg('--result'), JSON.stringify({ ok: true }));
      process.exit(0);
    } catch (e) {
      console.error(e.stack ?? e.message);
      writeFileSync(arg('--result'), JSON.stringify(e instanceof TransferFailed ? { failed: e.reason } : { error: e.message }));
      process.exit(1);
    }
  }
  const root = process.cwd();
  const all = process.argv.includes('--all');
  // --county ST/name: every root of that county on HEAD again (re-runs one publication after a fix).
  const only = arg('--county');
  const index = JSON.parse(indexAt('HEAD', root) ?? 'null');
  const minutes = (name, fallback) => Number(process.env[name] ?? fallback) * 60_000;
  const held = await runTransfers(pagesAt('HEAD', root), index, { all, only, claimed: claimOrder(root) }, {
    down: () => outage(latestPublished(index)),
    transfer: (t, { timeoutMs }) => inChild(t, timeoutMs),
    rootMs: minutes('ATLAS_ROOT_MINUTES', 180),
    budgetMs: minutes('ATLAS_RUN_MINUTES', 300),
  });
  if (!held) process.exit(2);
  if (process.env.ATLAS_HELD) writeFileSync(process.env.ATLAS_HELD, JSON.stringify(held, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `withdrawn=${held.filter((h) => h.kind === 'withdrawn').length}\n`);
  process.exit(held.length ? 1 : 0);
}
