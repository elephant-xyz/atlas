import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as raw from 'multiformats/codecs/raw';
import { gatewayClient } from '../scripts/gateways.mjs';
import { verifyGroup } from '../scripts/verify-roots.mjs';
import { block, car } from './helpers.mjs';

const G = 'https://gw.test';
const G2 = 'https://gw2.test';
const SCHEMA_DOC = { type: 'object', properties: { label: { type: 'string' }, relationships: { type: 'object' } } };

/** A consistent archive + schema + tables world served by a stubbed gateway; `edit` mutates it before wiring. */
async function world(edit = () => {}) {
  const w = {};
  w.schema = await block(new TextEncoder().encode(JSON.stringify(SCHEMA_DOC)), raw);
  w.property = await block({ label: 'Seed', relationships: {} });
  w.indexLabel = 'CountyIndex';
  w.partA = await block(new TextEncoder().encode('parquet-a'), raw);
  w.partB = await block(new TextEncoder().encode('parquet-b'), raw);
  await edit(w);
  w.dataGroups ??= { [w.schema.cid.toString()]: w.property.cid };
  w.shard = await block({ properties: [{ property_cid: w.property.cid, data_groups: w.dataGroups }] });
  w.index = await block({ label: w.indexLabel, properties: 1, shards: [w.shard.cid], version: 1 });
  w.tables = await block({ label: 'CountyTables', county_root: w.tablesCountyRoot ?? w.index.cid, codec: 'zstd', tables: { address: { rows: 1, parts: [{ cid: w.partA.cid, bytes: 9, rows: 1 }] }, deed: { rows: 1, parts: [{ cid: w.partB.cid, bytes: 9, rows: 1 }] } } });
  const carBytes = await car(w.index.cid, [w.index, w.shard, w.property]);
  w.routes = {
    [`${w.index.cid}?format=car`]: () => new Response(carBytes),
    [`${w.schema.cid}?format=raw`]: () => new Response(w.schema.bytes),
    [`${w.tables.cid}?format=raw`]: () => new Response(w.tables.bytes),
    [`${w.partA.cid}`]: () => new Response('p', { status: 206 }),
    [`${w.partB.cid}`]: () => new Response('p', { status: 206 }),
  };
  w.fetched = [];
  w.fetch = async (url) => {
    w.fetched.push(url);
    const path = url.replace(/^https:\/\/[^/]+\/ipfs\//, '');
    return w.routes[path] ? w.routes[path]() : new Response('no', { status: 504 });
  };
  w.log = [];
  let t = 0;
  w.deps = { fetch: w.fetch, gateways: [G], deadlineMs: 60_000, validateCar: () => ({ ok: true, report: 'CAR passed every check' }), csv: 'e.csv', log: (l) => w.log.push(l), sleep: async (ms) => (t += ms), now: () => t };
  w.group = { cid: w.index.cid.toString(), schema: w.schema.cid.toString(), tables: w.tables.cid.toString() };
  return w;
}

test('a consistent archive passes: CAR by root, CLI, local shape, schema and tables by CID, every part by CID', async () => {
  const w = await world();
  await verifyGroup(w.group, w.deps);
  assert.ok(w.log.some((l) => l.startsWith(`downloaded ${G}/ipfs/${w.index.cid}?format=car`)), w.log.join('\n'));
  assert.ok(w.log.includes('checked 2 part(s) by CID'), w.log.join('\n'));
  assert.ok(w.fetched.every((u) => !u.includes('/shards/') && !u.includes('/tables/')), 'nothing resolved by path: ' + w.fetched.join('\n'));
});

test('an unserved root fails at the download with "not available from any gateway"', async () => {
  const w = await world();
  const fetch = async () => new Response('', { status: 504 });
  await assert.rejects(verifyGroup(w.group, { ...w.deps, fetch, gateways: [G, G2] }), (e) => e.message.includes(`/ipfs/${w.index.cid}?format=car not available from any gateway within 1 min`) && e.message.includes(`${G2}/ipfs/${w.index.cid}?format=car: HTTP 504`));
});

test('a 2xx with an empty or root-less CAR counts as that gateway failing; the next gateway serves it', async () => {
  const w = await world();
  const fetch = async (url, init) => {
    if (url.startsWith(G) && url.endsWith('?format=car')) return new Response('', { status: 200 });
    return w.fetch(url, init);
  };
  const cli = [];
  await verifyGroup(w.group, { ...w.deps, fetch, gateways: [G, G2], validateCar: (f) => (cli.push(f), { ok: true, report: 'ok' }) });
  assert.ok(w.log.some((l) => l === `${G}/ipfs/${w.index.cid}?format=car: empty body (0 bytes)`), w.log.join('\n'));
  assert.ok(w.log.some((l) => l.startsWith(`downloaded ${G2}/ipfs/${w.index.cid}?format=car`)), w.log.join('\n'));
  assert.equal(cli.length, 1, 'the CLI ran once, on the good CAR');

  const other = await block({ label: 'CountyIndex', shards: [] });
  const wrongRoot = await world();
  const bad = async (url, init) => (url.endsWith('?format=car') ? new Response(await car(other.cid, [other])) : wrongRoot.fetch(url, init));
  await assert.rejects(verifyGroup(wrongRoot.group, { ...wrongRoot.deps, fetch: bad, deadlineMs: 5_000 }), (e) => e.message.includes(`/ipfs/${wrongRoot.index.cid}?format=car not available from any gateway within`) && e.message.includes('every gateway is rate limiting'));
  assert.ok(wrongRoot.log.some((l) => l.includes(`CAR roots are [${other.cid}]`)), wrongRoot.log.join('\n'));
});

test('a CLI failure stops the gate before the shape checks', async () => {
  const w = await world();
  await assert.rejects(verifyGroup(w.group, { ...w.deps, validateCar: () => ({ ok: false, report: 'lexicon errors: 25' }) }), { message: `archive ${w.index.cid}: elephant-cli validate failed; see e.csv` });
  assert.equal(w.fetched.length, 1, 'only the CAR was fetched');
});

test('a root that is not a CountyIndex fails from the local CAR', async () => {
  const w = await world((w) => { w.indexLabel = 'County'; });
  await assert.rejects(verifyGroup(w.group, w.deps), { message: `archive ${w.index.cid}: label is "County", expected CountyIndex` });
});

test('a schema the property does not carry fails from the local CAR', async () => {
  const w = await world();
  const other = await block(new TextEncoder().encode('{}'), raw);
  await assert.rejects(verifyGroup({ ...w.group, schema: other.cid.toString() }, w.deps), (e) => e.message.includes(`archive ${w.index.cid} property 0: data_groups keys are [${w.schema.cid}]; the page claims schema ${other.cid}`));
});

test('a schema block that is not a data-group schema fails', async () => {
  const w = await world(async (w) => { w.schema = await block(new TextEncoder().encode('{"type":"object"}'), raw); });
  await assert.rejects(verifyGroup(w.group, w.deps), (e) => e.message.includes('not a data-group schema'));
});

test('a tables root pointing at another archive fails', async () => {
  const w = await world(async (w) => { w.tablesCountyRoot = (await block({ label: 'CountyIndex', shards: [] })).cid; });
  await assert.rejects(verifyGroup(w.group, w.deps), (e) => e.message.includes(`county_root is ${w.tablesCountyRoot}, expected ${w.index.cid}`));
});

test('a missing part is reported by its CID after every part was tried', async () => {
  const w = await world();
  delete w.routes[`${w.partB.cid}`];
  await assert.rejects(verifyGroup(w.group, w.deps), (e) => e.message.includes(`part(s) not available from any gateway: deed/parts/0 ${w.partB.cid}`));
  assert.ok(w.log.includes('checked 1 part(s) by CID, 1 unavailable'), w.log.join('\n'));
});

test('gatewayClient: a 429 puts the gateway on cooldown and is not an attempt; the gateway that answered is preferred next', async () => {
  let t = 0;
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (url.startsWith(G) && seen.filter((u) => u.startsWith(G)).length === 1) return new Response('', { status: 429, headers: { 'retry-after': '5' } });
    if (url.startsWith(G)) return new Response('ok-from-G');
    return new Response('ok-from-G2');
  };
  const log = [];
  const gw = gatewayClient({ gateways: [G, G2], fetch, deadlineMs: 60_000, sleep: async (ms) => (t += ms), now: () => t, log: (l) => log.push(l) });
  let r = await gw.get('x');
  assert.equal(r.url, `${G2}/ipfs/x`, '429 on G moved to G2 without waiting');
  assert.ok(log.some((l) => l.includes('HTTP 429, backing off 5s')), log.join('\n'));
  r = await gw.get('y');
  assert.equal(r.url, `${G2}/ipfs/y`, 'G2 answered last so it is preferred while G cools down');
  t += 6_000;
  r = await gw.get('z');
  assert.equal(r.url, `${G2}/ipfs/z`, 'preferred gateway still first once G is back');
  const onlyG = gatewayClient({ gateways: [G], fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '5' } }), deadlineMs: 12_000, sleep: async (ms) => (t += ms), now: () => t });
  await assert.rejects(onlyG.get('q'), (e) => e.message.includes('every gateway is rate limiting'));
});
