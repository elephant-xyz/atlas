#!/usr/bin/env node
// Put every Parquet part the published index.json lists into Persist's part cache, so Persist's
// registered-index sync finds them in its own bucket instead of downloading them through public
// IPFS gateways (on 2026-11-27 Denton's index sat Incomplete for hours, partsMissing 90 -> 83,
// while those gateways answered 429, 500 or stalled at Persist's 2 parts at a time).
//   upload-parts-s3 [file]   file defaults to ./index.json
// Persist's rule (lambda/registered-ipfs-indexes/cache.ts): a part is cached at
// <prefix><cid>.parquet, and counts as present only when that object's size is the byte count its
// table list declares; any other object there is fetched again and overwritten. So this script:
//   1. holds index.json to ATLAS_INDEX_CID (the CID publish-index published), as upload-index-s3;
//   2. reads every group's table list from the private gateway (ATLAS_GATEWAYS, with
//      ATLAS_GATEWAY_TOKEN; never the public gateways), each block hashed to its CID;
//   3. lists the prefix once and skips every part already there at its declared size;
//   4. for each other part, ATLAS_PARTS_PARALLEL at a time (default 4): streams it from the private
//      gateway to a temporary file while computing its UnixFS CID (cidVersion 1, rawLeaves, as
//      elephant-cli's tables export does), and uploads it only when the byte count and the CID are
//      the declared ones; the temporary file is always removed;
//   5. exits 1 when any part could not be put in place, so the workflow does not upload index.json.
// Idempotent: a re-run lists the prefix again and sends only what is still missing. The uploads use
// the aws CLI with the environment's credentials (the workflow's OIDC role). The bucket is the one
// in ATLAS_INDEX_S3_URI; the prefix is ATLAS_PARTS_S3_PREFIX.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { DOWNLOAD_ATTEMPTS, dropBackoffMs, gatewayClient, privateGateways, withGatewayToken } from './gateways.mjs';
import { sleep as wait } from './lib.mjs';
import { unixfsCid, unixfsHasher } from './unixfs.mjs';
import { parseS3Uri } from './upload-index-s3.mjs';

/** A prefix of the form Persist's partsPrefixOf gives: no leading `/`, one trailing `/`. */
export function partsPrefix(prefix) {
  const p = String(prefix ?? '').trim();
  if (!/^[^/].*\/$/.test(p) || p.includes('//')) throw new Error(`ATLAS_PARTS_S3_PREFIX must be a key prefix ending in /, e.g. persist-registered-ipfs-indexes/elephant_atlas/parts/, got ${JSON.stringify(prefix ?? '')}`);
  return p;
}

/** Persist's partKeyOf: the cache key of a part. */
export const partKey = (prefix, cid) => `${prefix}${cid}.parquet`;

/** The part CID a listed key names, when it is a part key under `prefix`. */
export function partCidOfKey(prefix, key) {
  if (!key.startsWith(prefix) || !key.endsWith('.parquet')) return undefined;
  const cid = key.slice(prefix.length, -'.parquet'.length);
  return cid && !cid.includes('/') ? cid : undefined;
}

/** The private gateways only: the public ones are what this script exists to avoid. */
export function partGateways(env = process.env) {
  const gateways = privateGateways(env);
  if (!gateways.length) throw new Error('ATLAS_GATEWAYS is not set: parts are copied from the private gateway only, never the public ones');
  return gateways;
}

/** The distinct table-list CIDs of an index, in index order. */
export function tableListCids(index) {
  const cids = [];
  for (const county of index.counties ?? []) {
    for (const group of Object.values(county.groups ?? {})) if (group?.tables && !cids.includes(group.tables)) cids.push(group.tables);
  }
  return cids;
}

/** [{ cid, bytes }] of a decoded table list (a CountyTables node), in document order. */
export function partsOfTableList(node, what = 'table list') {
  if (node?.label !== 'CountyTables' || typeof node.tables !== 'object') throw new Error(`${what}: not a CountyTables node`);
  return Object.values(node.tables).flatMap((table) =>
    (table.parts ?? []).map((part) => {
      const cid = part.cid?.toString();
      if (!cid || !Number.isSafeInteger(part.bytes) || part.bytes <= 0) throw new Error(`${what}: a part without a CID and a positive byte count`);
      return { cid, bytes: part.bytes };
    }),
  );
}

/**
 * Every part of the table lists, each once, in order. A part declared with two byte counts is
 * refused, as Persist refuses it (partByteConflicts): its cache object could match only one.
 */
export function distinctParts(lists) {
  const sizes = new Map();
  for (const parts of lists) {
    for (const { cid, bytes } of parts) {
      if (sizes.has(cid) && sizes.get(cid) !== bytes) throw new Error(`part ${cid} is declared as ${Math.min(bytes, sizes.get(cid))} and ${Math.max(bytes, sizes.get(cid))} bytes`);
      sizes.set(cid, bytes);
    }
  }
  return [...sizes].map(([cid, bytes]) => ({ cid, bytes }));
}

/** Persist's missingParts: the parts whose cache object is absent or another size. */
export const missingParts = (parts, cached) => parts.filter(({ cid, bytes }) => cached.get(cid) !== bytes);

/** A table-list block from the gateway, hashed to its CID and decoded. */
async function fetchTableList(gw, cid) {
  const { res, url } = await gw.get(`${cid}?format=raw`, { headers: { accept: 'application/vnd.ipld.raw' } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await sha256.digest(bytes);
  if (Buffer.compare(digest.bytes, CID.parse(cid).multihash.bytes) !== 0) throw new Error(`table list ${cid}: the bytes served do not hash to it`);
  try {
    return partsOfTableList(decode(bytes), `table list ${cid}`);
  } catch (e) {
    throw new Error(`table list ${cid}: ${e.message}`);
  }
}

/** A part whose bytes could not be checked or uploaded; final once every attempt failed. */
class PartError extends Error {}

/**
 * Stream one part from the gateway into `file`, computing its UnixFS CID and MD5 on the way;
 * rejects as soon as the body runs past the declared size, and when the size or CID differ.
 */
async function download(gw, part, file, requestMs) {
  const { res, url } = await gw.get(part.cid, { requestMs });
  const hasher = unixfsHasher();
  const md5 = createHash('md5');
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const piece of source) {
          hasher.update(piece);
          md5.update(piece);
          if (hasher.size > part.bytes) throw new PartError(`${url}: body runs past the declared ${part.bytes} bytes`);
          yield piece;
        }
      },
      createWriteStream(file),
    );
  } catch (e) {
    throw Object.assign(e, { url });
  }
  if (hasher.size !== part.bytes) throw Object.assign(new PartError(`${url}: ${hasher.size} bytes, declared ${part.bytes}`), { url, dropped: true });
  const cid = hasher.digest();
  if (cid !== part.cid) throw Object.assign(new PartError(`${url}: the bytes are ${cid}, not ${part.cid}`), { url, wrong: true });
  return { md5: md5.digest('base64') };
}

/** Fetch, verify and upload one part, retrying a dropped or wrong body; the temp file is always removed. */
async function copyPart(part, d) {
  const file = join(d.tempDir, `${part.cid}.parquet`);
  const gw = d.gateway(); // its own deadline: ATLAS_GATEWAY_DEADLINE_MINUTES for each part
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const { md5 } = await download(gw, part, file, d.requestMs);
        await d.put({ bucket: d.bucket, key: partKey(d.prefix, part.cid), file, md5, cid: part.cid });
        return;
      } catch (e) {
        if (attempt >= DOWNLOAD_ATTEMPTS || !e.url) throw e;
        if (e.wrong) gw.reject(e.url);
        else gw.rotate(e.url);
        d.log(`part ${part.cid} attempt ${attempt}: ${e.message}; retrying`);
        await d.sleep(dropBackoffMs(attempt));
      }
    }
  } finally {
    await rm(file, { force: true });
  }
}

/** Run `jobs` `n` at a time; unlike lib's pool, one failure does not stop the others. */
async function settleAll(jobs, n) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await jobs[i]() };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
  return results;
}

/**
 * Put every part of `index` in place. deps: gateway() (a gatewayClient), list({ bucket, prefix })
 * -> Map(key -> size), put({ bucket, key, file, md5, cid }), parallel, requestMs, log, sleep.
 * Resolves with { parts, present, uploaded, failed: [{ cid, reason }] }.
 */
export async function syncParts(index, { bucket, prefix, ...deps }) {
  const d = { parallel: 4, requestMs: 60 * 60_000, log: () => {}, sleep: wait, ...deps, bucket, prefix: partsPrefix(prefix) };
  const lists = tableListCids(index);
  const gw = d.gateway();
  const parts = distinctParts(await Promise.all(lists.map((cid) => fetchTableList(gw, cid))));
  const cached = new Map();
  for (const [key, size] of await d.list({ bucket, prefix: d.prefix })) {
    const cid = partCidOfKey(d.prefix, key);
    if (cid) cached.set(cid, size);
  }
  const missing = missingParts(parts, cached);
  d.log(`${lists.length} table list(s), ${parts.length} part(s): ${parts.length - missing.length} already in s3://${bucket}/${d.prefix} at their size, ${missing.length} to copy`);
  d.tempDir = await mkdtemp(join(d.tmp ?? tmpdir(), 'atlas-parts-'));
  try {
    let done = 0;
    const results = await settleAll(
      missing.map((part) => async () => {
        await copyPart(part, d);
        d.log(`copied ${part.cid} (${part.bytes} bytes) [${++done}/${missing.length}]`);
      }),
      d.parallel,
    );
    const failed = results.flatMap((r, i) => (r.ok ? [] : [{ cid: missing[i].cid, reason: r.error.message }]));
    return { parts: parts.length, present: parts.length - missing.length, uploaded: missing.length - failed.length, failed };
  } finally {
    await rm(d.tempDir, { recursive: true, force: true });
  }
}

const run = promisify(execFile);
const aws = process.env.AWS_CLI ?? 'aws';

/** Every key and size under the prefix (the CLI follows the pages). */
export async function awsList({ bucket, prefix }) {
  const { stdout } = await run(aws, ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix, '--query', 'Contents[].[Key,Size]', '--output', 'json'], { maxBuffer: 256 * 1024 * 1024 });
  return new Map((JSON.parse(stdout || 'null') ?? []).map(([key, size]) => [key, Number(size)]));
}

/** The put-object arguments for one checked part. */
export const putPartArgs = ({ bucket, key, file, md5, cid }) => [
  's3api', 'put-object',
  '--bucket', bucket,
  '--key', key,
  '--body', file,
  '--content-type', 'application/vnd.apache.parquet',
  '--content-md5', md5,
  '--metadata', `ipfs-cid=${cid}`,
];

export const awsPut = (args) => run(aws, putPartArgs(args), { maxBuffer: 16 * 1024 * 1024 });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? 'index.json';
  const bytes = readFileSync(file);
  const expected = process.env.ATLAS_INDEX_CID;
  if (!expected) throw new Error('ATLAS_INDEX_CID (the published index CID) is required');
  if (unixfsCid(bytes) !== expected) throw new Error(`${file} is ${unixfsCid(bytes)}, not the published index ${expected}; not copying its parts. A later publication may have superseded this run: re-run the latest publish run instead.`);
  const { bucket } = parseS3Uri(process.env.ATLAS_INDEX_S3_URI);
  const prefix = process.env.ATLAS_PARTS_S3_PREFIX;
  const gateways = partGateways();
  const deadlineMs = Number(process.env.ATLAS_GATEWAY_DEADLINE_MINUTES || 20) * 60_000;
  const log = (m) => console.log(m);
  const result = await syncParts(JSON.parse(bytes.toString('utf8')), {
    bucket,
    prefix,
    gateway: () => gatewayClient({ gateways, fetch: withGatewayToken(), deadlineMs, log }),
    list: awsList,
    put: awsPut,
    parallel: Number(process.env.ATLAS_PARTS_PARALLEL || 4),
    requestMs: Number(process.env.ATLAS_PART_MINUTES || 60) * 60_000,
    log,
  });
  for (const f of result.failed) console.error(`FAIL part ${f.cid}: ${f.reason}`);
  const summary = `Persist part cache s3://${bucket}/${partsPrefix(prefix)}: ${result.parts} part(s), ${result.present} already there, ${result.uploaded} copied, ${result.failed.length} failed`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.exit(result.failed.length ? 1 : 0);
}
