#!/usr/bin/env node
// Spot-check every group whose cid, schema, or tables changed relative to origin/main (or
// every group with --all): fetch each block from the public gateway, hash it, require the
// multihash to match the CID, decode it and check the label and shape; resolve shard 0 and one
// property by path; require the page's schema CID to be a key of that property's data_groups;
// require the schema to be a data-group JSON Schema; require the tables root to point back at
// the archive and one part to be served. Exits 1 with the failing URL on any problem.
//
// TODO: full CAR validation (every block, every link) belongs in a nightly job, not here.
import { fileURLToPath } from 'node:url';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { changedGroups, pagesAt, readPages } from './lib.mjs';

const GATEWAY = (process.env.ATLAS_GATEWAY ?? 'https://ipfs.filebase.io').replace(/\/$/, '');
const DEADLINE_MS = Number(process.env.ATLAS_FETCH_DEADLINE_MS ?? 180_000);
const REQUEST_MS = 30_000;

/** GET a URL, retrying with backoff until DEADLINE_MS. Resolves to the Response; throws with the URL on failure. */
export async function fetchOk(url, init = {}) {
  const started = Date.now();
  let last;
  for (let attempt = 0, wait = 2_000; ; attempt++, wait = Math.min(wait * 2, 30_000)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS), ...init });
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.name === 'TimeoutError' ? `timeout after ${REQUEST_MS}ms` : e.message;
    }
    if (Date.now() - started + wait > DEADLINE_MS) throw new Error(`${url}: ${last} after ${attempt + 1} attempt(s)`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function fetchVerified(path, expectCid) {
  const url = `${GATEWAY}/ipfs/${path}?format=raw`;
  const bytes = new Uint8Array(await (await fetchOk(url, { headers: { accept: 'application/vnd.ipld.raw' } })).arrayBuffer());
  const cid = CID.parse(expectCid);
  const digest = await sha256.digest(bytes);
  if (Buffer.compare(digest.bytes, cid.multihash.bytes) !== 0) throw new Error(`${url}: bytes do not hash to ${expectCid}`);
  console.log(`fetched ${url} (${bytes.length} bytes)`);
  return bytes;
}

async function fetchNode(path, expectCid) {
  const bytes = await fetchVerified(path, expectCid);
  try {
    return decode(bytes);
  } catch (e) {
    throw new Error(`${GATEWAY}/ipfs/${path}?format=raw: not dag-json (${e.message})`);
  }
}

function require_(cond, path, msg) {
  if (!cond) throw new Error(`${GATEWAY}/ipfs/${path}?format=raw: ${msg}`);
}

export async function verifyGroup({ cid, schema, tables }) {
  const index = await fetchNode(cid, cid);
  require_(index.label === 'CountyIndex', cid, `label is ${JSON.stringify(index.label)}, expected CountyIndex`);
  require_(Array.isArray(index.shards) && index.shards.length > 0, cid, 'missing non-empty `shards`');
  const shard = await fetchNode(`${cid}/shards/0`, index.shards[0].toString());
  require_(Array.isArray(shard.properties) && shard.properties.length > 0, `${cid}/shards/0`, 'missing non-empty `properties`');
  const property = await fetchNode(`${cid}/shards/0/properties/0/property_cid`, shard.properties[0].property_cid?.toString());
  require_(typeof property.label === 'string', `${cid}/shards/0/properties/0/property_cid`, 'missing `label`');
  const dataGroups = Object.keys(shard.properties[0].data_groups ?? {});
  require_(dataGroups.includes(schema), `${cid}/shards/0`, `properties/0/data_groups keys are [${dataGroups.join(', ')}]; the page claims schema ${schema}`);

  const schemaBytes = await fetchVerified(schema, schema);
  let schemaDoc;
  try {
    schemaDoc = JSON.parse(Buffer.from(schemaBytes).toString('utf8'));
  } catch (e) {
    throw new Error(`${GATEWAY}/ipfs/${schema}?format=raw: not JSON (${e.message})`);
  }
  require_(schemaDoc?.properties?.label && schemaDoc?.properties?.relationships, schema, 'not a data-group schema: `properties` must have `label` and `relationships`');

  const tablesNode = await fetchNode(tables, tables);
  require_(tablesNode.label === 'CountyTables', tables, `label is ${JSON.stringify(tablesNode.label)}, expected CountyTables`);
  require_(tablesNode.county_root?.toString() === cid, tables, `county_root is ${tablesNode.county_root}, expected ${cid}`);
  const tableNames = Object.keys(tablesNode.tables ?? {});
  require_(tableNames.length > 0, tables, 'missing non-empty `tables`');
  const partUrl = `${GATEWAY}/ipfs/${tables}/tables/${tableNames[0]}/parts/0/cid`;
  const part = await fetchOk(partUrl, { headers: { range: 'bytes=0-0' } });
  console.log(`fetched ${partUrl} (HTTP ${part.status}, range bytes=0-0)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const all = process.argv.includes('--all');
  const targets = changedGroups(readPages(root), all ? null : pagesAt('origin/main', root));
  if (!targets.length) console.log('no changed groups to verify');
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
