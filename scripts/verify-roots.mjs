#!/usr/bin/env node
// Spot-check every root that is new relative to origin/main (or every root with --all):
// fetch the block from the public gateway, hash it, require the multihash to match the CID,
// decode it as dag-json and check the label and shape. For a county root also resolve
// shard 0 and one property's root by path. Exits 1 with the failing URL on any problem.
//
// TODO: full CAR validation (every block, every link) belongs in a nightly job, not here.
import { fileURLToPath } from 'node:url';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { pagesAt, readPages, rootsOf } from './lib.mjs';

const GATEWAY = (process.env.ATLAS_GATEWAY ?? 'https://ipfs.filebase.io').replace(/\/$/, '');
const DEADLINE_MS = Number(process.env.ATLAS_FETCH_DEADLINE_MS ?? 180_000);
const REQUEST_MS = 30_000;

/** GET a raw block, retrying with backoff until DEADLINE_MS. Throws with the URL on failure. */
export async function fetchRaw(url) {
  const started = Date.now();
  let last;
  for (let attempt = 0, wait = 2_000; ; attempt++, wait = Math.min(wait * 2, 30_000)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS), headers: { accept: 'application/vnd.ipld.raw' } });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.name === 'TimeoutError' ? `timeout after ${REQUEST_MS}ms` : e.message;
    }
    if (Date.now() - started + wait > DEADLINE_MS) throw new Error(`${url}: ${last} after ${attempt + 1} attempt(s)`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function fetchBlock(path, expectCid) {
  const url = `${GATEWAY}/ipfs/${path}?format=raw`;
  const bytes = await fetchRaw(url);
  if (expectCid) {
    const cid = CID.parse(expectCid);
    const digest = await sha256.digest(bytes);
    if (Buffer.compare(digest.bytes, cid.multihash.bytes) !== 0) throw new Error(`${url}: bytes do not hash to ${expectCid}`);
  }
  let node;
  try {
    node = decode(bytes);
  } catch (e) {
    throw new Error(`${url}: not dag-json (${e.message})`);
  }
  console.log(`fetched ${url} (${bytes.length} bytes)`);
  return node;
}

function require_(cond, url, msg) {
  if (!cond) throw new Error(`${GATEWAY}/ipfs/${url}?format=raw: ${msg}`);
}

export async function verifyCountyRoot(cid) {
  const index = await fetchBlock(cid, cid);
  require_(index.label === 'CountyIndex', cid, `label is ${JSON.stringify(index.label)}, expected CountyIndex`);
  require_(Number.isInteger(index.properties), cid, 'missing integer `properties`');
  require_(Array.isArray(index.shards) && index.shards.length > 0, cid, 'missing non-empty `shards`');
  const shard = await fetchBlock(`${cid}/shards/0`, index.shards[0].toString());
  require_(Array.isArray(shard.properties) && shard.properties.length > 0, `${cid}/shards/0`, 'missing non-empty `properties`');
  const property = await fetchBlock(`${cid}/shards/0/properties/0/property_cid`, shard.properties[0].property_cid?.toString());
  require_(typeof property.label === 'string', `${cid}/shards/0/properties/0/property_cid`, 'missing `label`');
}

export async function verifyTablesRoot(cid) {
  const tables = await fetchBlock(cid, cid);
  require_(tables.label === 'CountyTables', cid, `label is ${JSON.stringify(tables.label)}, expected CountyTables`);
  require_(tables.tables && typeof tables.tables === 'object', cid, 'missing `tables`');
}

/** [{ page, run, key, cid }] for every root to verify. Withdrawn runs are skipped. */
export function newRoots(pages, basePages) {
  const known = basePages ? rootsOf(basePages) : new Set();
  const out = [];
  for (const { path, page } of pages) {
    for (const run of page.runs) {
      if (run.status === 'withdrawn') continue;
      for (const key of ['county_root', 'tables_root']) {
        if (run[key] && !known.has(run[key])) out.push({ path, run: run.county_root, groups: run.groups, key, cid: run[key] });
      }
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const all = process.argv.includes('--all');
  const targets = newRoots(readPages(root), all ? null : pagesAt('origin/main', root));
  if (!targets.length) console.log('no new roots to verify');
  let failed = 0;
  for (const t of targets) {
    console.log(`verifying ${t.path} county_root ${t.run} groups [${t.groups.join(', ')}] ${t.key} ${t.cid}`);
    try {
      await (t.key === 'county_root' ? verifyCountyRoot(t.cid) : verifyTablesRoot(t.cid));
      console.log(`ok ${t.key} ${t.cid}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${t.path} county_root ${t.run} ${t.key}: ${e.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
