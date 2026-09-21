import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CarReader, CarWriter } from '@ipld/car';
import * as dagJson from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { poll, token } from '../scripts/filebase.mjs';
import { TransferFailed, rootsToTransfer, transferArchive, transferTables } from '../scripts/transfer-roots.mjs';
import { CID_A, CID_B, CID_C, group, page } from './helpers.mjs';

const at = (path, page) => ({ path, page });
const LEE = 'counties/FL/lee.json';

test('a new page transfers its archive and tables roots, archive first', () => {
  assert.deepEqual(rootsToTransfer([at(LEE, page())], []), [
    { county: 'FL/lee', key: 'county.cid', kind: 'archive', cid: CID_A },
    { county: 'FL/lee', key: 'county.tables', kind: 'tables', cid: CID_B },
  ]);
});

test('a superseded cid transfers only what is new; an unchanged page and a removed group transfer nothing', () => {
  const base = [at(LEE, page())];
  assert.deepEqual(rootsToTransfer(base, base), []);
  assert.deepEqual(rootsToTransfer([at(LEE, page({ groups: {} }))], base), []);
  assert.deepEqual(rootsToTransfer([at(LEE, page({ groups: { county: group({ cid: CID_C }) } }))], base), [{ county: 'FL/lee', key: 'county.cid', kind: 'archive', cid: CID_C }]);
});

test('token is base64 of access:secret:bucket', () => {
  assert.equal(token({ FILEBASE_ACCESS_KEY: 'a', FILEBASE_SECRET_KEY: 's' }), Buffer.from('a:s:elephant-atlas').toString('base64'));
  assert.throws(() => token({}), /required/);
});

test('poll returns the first truthy result or undefined at the limit', async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => (t += ms) };
  let n = 0;
  assert.equal(await poll(async () => (++n === 3 ? 'ok' : false), { limitMs: 100, intervalMs: 10, ...clock }), 'ok');
  assert.equal(await poll(async () => false, { limitMs: 100, intervalMs: 10, ...clock }), undefined);
});

// ---- transfer with a stubbed gateway and RPC

const block = async (value, codec = dagJson) => {
  const bytes = codec.encode(value);
  return { cid: CID.create(1, codec.code, await sha256.digest(bytes)), bytes };
};
const car = async (root, blocks) => {
  const { writer, out } = CarWriter.create([root]);
  const chunks = [];
  const collected = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collected;
  return Buffer.concat(chunks);
};

async function fixture() {
  const property = await block({ label: 'Seed', relationships: {} });
  const shard = await block({ properties: [{ property_cid: property.cid, data_groups: {} }] });
  const index = await block({ label: 'CountyIndex', properties: 1, shards: [shard.cid], version: 1 });
  const part = await block(new TextEncoder().encode('parquet'), raw);
  const tables = await block({ label: 'CountyTables', county_root: index.cid, codec: 'zstd', tables: { address: { rows: 1, parts: [{ cid: part.cid, bytes: 7, rows: 1 }] } } });
  const G = 'https://gw.test';
  const routes = {
    [`${G}/ipfs/${index.cid}?format=raw`]: () => new Response(index.bytes),
    [`${G}/ipfs/${index.cid}/shards/0?format=car`]: async () => new Response(await car(shard.cid, [index, shard, property])),
    [`${G}/ipfs/${tables.cid}?format=raw`]: () => new Response(tables.bytes),
    [`${G}/ipfs/${tables.cid}/tables/address/parts/0/cid?format=car`]: async () => new Response(await car(part.cid, [tables, part])),
  };
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    return routes[url] ? routes[url]() : new Response('no', { status: 404 });
  };
  const calls = [];
  const rpc = async (path, { body } = {}) => {
    if (path.startsWith('pin/ls')) return [{ Keys: { [new URL(`x:?${path.split('?')[1]}`).searchParams.get('arg')]: { Type: 'recursive' } } }];
    const reader = await CarReader.fromBytes(new Uint8Array(await body.get('file').arrayBuffer()));
    let n = 0;
    for await (const _ of reader.blocks()) n++;
    const [root] = await reader.getRoots();
    calls.push(`${path} root=${root} blocks=${n}`);
    return [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }];
  };
  let t = 0;
  const tmp = await mkdtemp(join(tmpdir(), 'atlas-test-'));
  const deps = { fetch, rpc, gateway: G, deadlineMs: 60_000, sleep: async (ms) => (t += ms), now: () => t, log() {}, tmp };
  return { index, shard, tables, part, fetched, calls, deps, tmp, G };
}

test('transferArchive imports the root block, each shard, then the root block pinned, and verifies the pin', async () => {
  const f = await fixture();
  await transferArchive(f.index.cid.toString(), f.deps);
  assert.deepEqual(f.calls, [
    `dag/import?pin-roots=false&stats=true root=${f.index.cid} blocks=1`,
    `dag/import?pin-roots=false&stats=true root=${f.shard.cid} blocks=3`,
    `dag/import?pin-roots=true&stats=true root=${f.index.cid} blocks=1`,
  ]);
  assert.deepEqual(f.fetched, [`${f.G}/ipfs/${f.index.cid}?format=raw`, `${f.G}/ipfs/${f.index.cid}/shards/0?format=car`]);
  assert.deepEqual(readdirSync(f.tmp), [], 'temp CAR deleted');
});

test('transferTables imports the tables block, each part by path, then the tables block pinned', async () => {
  const f = await fixture();
  await transferTables(f.tables.cid.toString(), f.deps);
  assert.deepEqual(f.calls, [
    `dag/import?pin-roots=false&stats=true root=${f.tables.cid} blocks=1`,
    `dag/import?pin-roots=false&stats=true root=${f.part.cid} blocks=2`,
    `dag/import?pin-roots=true&stats=true root=${f.tables.cid} blocks=1`,
  ]);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('a gateway 504 that persists through the deadline is a TransferFailed naming the URL', async () => {
  const f = await fixture();
  let tries = 0;
  const fetch = async () => (tries++, new Response('gateway timeout', { status: 504 }));
  await assert.rejects(transferArchive(f.index.cid.toString(), { ...f.deps, fetch }), (e) => e instanceof TransferFailed && e.cid === f.index.cid.toString() && e.reason.includes(`${f.G}/ipfs/${f.index.cid}?format=raw: HTTP 504`) && e.reason.includes('not available within 1 min'));
  assert.ok(tries > 1, 'retried before giving up');
  assert.deepEqual(f.calls, []);
});

test('a transient gateway error is retried, and a persistent RPC error is not a TransferFailed', async () => {
  const f = await fixture();
  let first = true;
  const flaky = async (url, init) => {
    if (first) {
      first = false;
      return new Response('', { status: 502 });
    }
    return f.deps.fetch(url, init);
  };
  await transferArchive(f.index.cid.toString(), { ...f.deps, fetch: flaky });
  assert.equal(f.calls.length, 3);

  const g = await fixture();
  await assert.rejects(transferArchive(g.index.cid.toString(), { ...g.deps, rpc: async () => { throw new Error('HTTP 401'); } }), (e) => !(e instanceof TransferFailed) && e.message === 'HTTP 401');
});

test('a root that decodes but is not a CountyIndex is a TransferFailed', async () => {
  const f = await fixture();
  await assert.rejects(transferArchive(f.tables.cid.toString(), f.deps), (e) => e instanceof TransferFailed && e.reason === 'not a CountyIndex block');
});
