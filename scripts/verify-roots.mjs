#!/usr/bin/env node
// Spot-check every group whose cid, schema, or tables changed relative to origin/main (or
// every group with --all): fetch each block from the IPFS network through the gateway list
// (first gateway that answers wins; see gateways.mjs), hash it, require the
// multihash to match the CID, decode it and check the label and shape; resolve shard 0 and one
// property by path; require the page's schema CID to be a key of that property's data_groups;
// require the schema to be a data-group JSON Schema; require the tables root to point back at
// the archive and one part to be served. Exits 1 with the failing URL on any problem.
import { fileURLToPath } from 'node:url';
import { CarReader } from '@ipld/car';
import { decode } from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { fetchFromAny, gatewayList } from './gateways.mjs';
import { changedGroups, pagesAt, readPages } from './lib.mjs';

const GATEWAYS = gatewayList();
const DEADLINE_MS = Number(process.env.ATLAS_FETCH_DEADLINE_MS ?? 180_000);

/** GET /ipfs/<path> from the first gateway that answers, retrying the whole list with backoff until DEADLINE_MS. */
export async function fetchOk(path, headers = {}) {
  const started = Date.now();
  let last;
  for (let attempt = 0, wait = 2_000; ; attempt++, wait = Math.min(wait * 2, 30_000)) {
    try {
      return await fetchFromAny(path, { gateways: GATEWAYS, headers });
    } catch (e) {
      last = e.message;
    }
    if (Date.now() - started + wait > DEADLINE_MS) throw new Error(`/ipfs/${path} not available from any gateway after ${attempt + 1} attempt(s): ${last}`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function verified(url, bytes, expectCid) {
  const digest = await sha256.digest(bytes);
  if (Buffer.compare(digest.bytes, CID.parse(expectCid).multihash.bytes) !== 0) throw new Error(`${url}: bytes do not hash to ${expectCid}`);
  return bytes;
}

/** A root block by bare CID: every gateway serves a pinned root as a raw block. */
async function fetchRoot(cid) {
  const { res, url } = await fetchOk(`${cid}?format=raw`, { accept: 'application/vnd.ipld.raw' });
  const bytes = await verified(url, new Uint8Array(await res.arrayBuffer()), cid);
  console.log(`fetched ${url} (${bytes.length} bytes)`);
  return bytes;
}

/** The block with `expectCid` inside a CAR, or undefined. */
export async function blockFromCar(carBytes, expectCid) {
  const reader = await CarReader.fromBytes(carBytes);
  const block = await reader.get(CID.parse(expectCid));
  return block?.bytes;
}

/**
 * A block reached by path from a root. Gateways resolve paths by root on every provider, but
 * only some serve the terminal block raw, so ask for a CAR of the path (`dag-scope=block`:
 * ancestors plus the target; a gateway that ignores the scope returns the bounded subtree) and
 * take the block whose CID the parent already told us. Unrelated blocks are ignored.
 */
async function fetchByPath(path, expectCid) {
  const { res, url } = await fetchOk(`${path}?format=car&dag-scope=block`, { accept: 'application/vnd.ipld.car' });
  const car = new Uint8Array(await res.arrayBuffer());
  let bytes;
  try {
    bytes = await blockFromCar(car, expectCid);
  } catch (e) {
    throw new Error(`${url}: not a CAR (${e.message})`);
  }
  if (!bytes) throw new Error(`${url}: CAR does not contain ${expectCid}`);
  await verified(url, bytes, expectCid);
  console.log(`fetched ${url} (${car.length} bytes, block ${expectCid} ${bytes.length} bytes)`);
  return bytes;
}

function asNode(path, bytes) {
  try {
    return decode(bytes);
  } catch (e) {
    throw new Error(`/ipfs/${path}: not dag-json (${e.message})`);
  }
}

function require_(cond, path, msg) {
  if (!cond) throw new Error(`/ipfs/${path}: ${msg}`);
}

export async function verifyGroup({ cid, schema, tables }) {
  const index = asNode(cid, await fetchRoot(cid));
  require_(index.label === 'CountyIndex', cid, `label is ${JSON.stringify(index.label)}, expected CountyIndex`);
  require_(Array.isArray(index.shards) && index.shards.length > 0, cid, 'missing non-empty `shards`');
  const shard = asNode(`${cid}/shards/0`, await fetchByPath(`${cid}/shards/0`, index.shards[0].toString()));
  require_(Array.isArray(shard.properties) && shard.properties.length > 0, `${cid}/shards/0`, 'missing non-empty `properties`');
  const propertyPath = `${cid}/shards/0/properties/0/property_cid`;
  const property = asNode(propertyPath, await fetchByPath(propertyPath, shard.properties[0].property_cid?.toString()));
  require_(typeof property.label === 'string', `${cid}/shards/0/properties/0/property_cid`, 'missing `label`');
  const dataGroups = Object.keys(shard.properties[0].data_groups ?? {});
  require_(dataGroups.includes(schema), `${cid}/shards/0`, `properties/0/data_groups keys are [${dataGroups.join(', ')}]; the page claims schema ${schema}`);

  const schemaBytes = await fetchRoot(schema);
  let schemaDoc;
  try {
    schemaDoc = JSON.parse(Buffer.from(schemaBytes).toString('utf8'));
  } catch (e) {
    throw new Error(`${GATEWAY}/ipfs/${schema}?format=raw: not JSON (${e.message})`);
  }
  require_(schemaDoc?.properties?.label && schemaDoc?.properties?.relationships, schema, 'not a data-group schema: `properties` must have `label` and `relationships`');

  const tablesNode = asNode(tables, await fetchRoot(tables));
  require_(tablesNode.label === 'CountyTables', tables, `label is ${JSON.stringify(tablesNode.label)}, expected CountyTables`);
  require_(tablesNode.county_root?.toString() === cid, tables, `county_root is ${tablesNode.county_root}, expected ${cid}`);
  const tableNames = Object.keys(tablesNode.tables ?? {});
  require_(tableNames.length > 0, tables, 'missing non-empty `tables`');
  const { res: part, url: partUrl } = await fetchOk(`${tables}/tables/${tableNames[0]}/parts/0/cid`, { range: 'bytes=0-0' });
  console.log(`fetched ${partUrl} (HTTP ${part.status}, range bytes=0-0)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const all = process.argv.includes('--all');
  const targets = changedGroups(readPages(root), all ? null : pagesAt('origin/main', root));
  if (!targets.length) console.log('no changed groups to verify');
  else console.log(`gateways, in order: ${GATEWAYS.join(', ')}`);
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
