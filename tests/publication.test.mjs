import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CarReader } from '@ipld/car';
import * as raw from 'multiformats/codecs/raw';
import { poll, token } from '../scripts/filebase.mjs';
import { DEFAULT_GATEWAYS, fetchFromAny, gatewayList } from '../scripts/gateways.mjs';
import { TransferFailed, rootsToTransfer, transferArchive, transferTables } from '../scripts/transfer-roots.mjs';
import { validateCar } from '../scripts/verify-roots.mjs';
import { CID_A, CID_B, CID_C, block, car, group, page } from './helpers.mjs';

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

async function fixture(rpcReply) {
  const property = await block({ label: 'Seed', relationships: {} });
  const shard = await block({ properties: [{ property_cid: property.cid, data_groups: {} }] });
  const index = await block({ label: 'CountyIndex', properties: 1, shards: [shard.cid], version: 1 });
  const part = await block(new TextEncoder().encode('parquet'), raw);
  const tables = await block({ label: 'CountyTables', county_root: index.cid, codec: 'zstd', tables: { address: { rows: 1, parts: [{ cid: part.cid, bytes: 7, rows: 1 }] } } });
  const G = 'https://gw.test';
  const G2 = 'https://gw2.test';
  const routes = {
    [`${G}/ipfs/${index.cid}?format=raw`]: () => new Response(index.bytes),
    [`${G}/ipfs/${index.cid}/shards/0?format=car`]: async () => new Response(await car(shard.cid, [index, shard, property])),
    [`${G}/ipfs/${tables.cid}?format=raw`]: () => new Response(tables.bytes),
    [`${G}/ipfs/${tables.cid}/tables/address/parts/0/cid?format=car`]: async () => new Response(await car(part.cid, [tables, part])),
  };
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    const key = url.replace(G2, G);
    return routes[key] ? routes[key]() : new Response('no', { status: 404 });
  };
  const calls = [];
  const rpc = async (path, { body } = {}) => {
    if (path.startsWith('pin/ls')) return [{ Keys: { [new URL(`x:?${path.split('?')[1]}`).searchParams.get('arg')]: { Type: 'recursive' } } }];
    const reader = await CarReader.fromBytes(new Uint8Array(await body.get('file').arrayBuffer()));
    let n = 0;
    for await (const _ of reader.blocks()) n++;
    const [root] = await reader.getRoots();
    calls.push(`${path} root=${root} blocks=${n}`);
    return (rpcReply ?? ((root, n) => [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }]))(root, n, path);
  };
  let t = 0;
  const tmp = await mkdtemp(join(tmpdir(), 'atlas-test-'));
  const deps = { fetch, rpc, gateways: [G], deadlineMs: 60_000, sleep: async (ms) => (t += ms), now: () => t, log() {}, tmp };
  return { index, shard, property, tables, part, fetched, calls, deps, tmp, G, G2 };
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

test('every gateway failing through the deadline is a TransferFailed naming each attempt', async () => {
  const f = await fixture();
  let tries = 0;
  const fetch = async () => (tries++, new Response('gateway timeout', { status: 504 }));
  await assert.rejects(transferArchive(f.index.cid.toString(), { ...f.deps, fetch, gateways: [f.G, f.G2] }), (e) => e instanceof TransferFailed && e.cid === f.index.cid.toString() && e.reason.includes(`${f.G}/ipfs/${f.index.cid}?format=raw: HTTP 504; ${f.G2}/ipfs/${f.index.cid}?format=raw: HTTP 504`) && e.reason.includes('not available from any gateway within 1 min'));
  assert.ok(tries > 2, 'retried the whole list before giving up');
  assert.deepEqual(f.calls, []);
});

test('a gateway that fails moves to the next; the answering gateway is logged', async () => {
  const f = await fixture();
  const fetch = async (url, init) => (url.startsWith(f.G + '/') ? new Response('', { status: 504 }) : f.deps.fetch(url, init));
  const log = [];
  await transferArchive(f.index.cid.toString(), { ...f.deps, fetch, gateways: [f.G, f.G2], log: (l) => log.push(l) });
  assert.equal(f.calls.length, 3);
  assert.ok(log.includes(`fetched ${f.G2}/ipfs/${f.index.cid}?format=raw`), log.join('\n'));
  assert.ok(log.includes(`fetched ${f.G2}/ipfs/${f.index.cid}/shards/0?format=car`), log.join('\n'));
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

test('the log reports the distinct blocks and bytes copied per root', async () => {
  const f = await fixture();
  const log = [];
  await transferArchive(f.index.cid.toString(), { ...f.deps, log: (l) => log.push(l) });
  const total = f.index.bytes.length + f.shard.bytes.length + f.property.bytes.length;
  assert.ok(log.includes(`pinned ${f.index.cid}: 3 distinct blocks, ${total} bytes copied`), log.join('\n'));
});

test('an import that stores fewer blocks than the CAR carried is a TransferFailed', async () => {
  const f = await fixture((root, n) => [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n - 1, BlockBytesCount: 0 } }]);
  await assert.rejects(transferArchive(f.index.cid.toString(), f.deps), (e) => e instanceof TransferFailed && /stored 0 blocks, sent 1/.test(e.reason));
});

test('a pinned import that returns no root (Filebase on an incomplete DAG) is a TransferFailed; on an unpinned import it is an ordinary error', async () => {
  const f = await fixture((root, n, path) => (path.includes('pin-roots=true') ? [] : [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }]));
  await assert.rejects(transferArchive(f.index.cid.toString(), f.deps), (e) => e instanceof TransferFailed && /did not pin: the node returned no root; the copy is incomplete/.test(e.reason));
  const g = await fixture(() => []);
  await assert.rejects(transferArchive(g.index.cid.toString(), g.deps), (e) => !(e instanceof TransferFailed) && /the node returned no root/.test(e.message));
  const h = await fixture((root, n, path) => (path.includes('pin-roots=true') ? [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: 'missing block' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }] : [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }]));
  await assert.rejects(transferArchive(h.index.cid.toString(), h.deps), (e) => e instanceof TransferFailed && /missing block; the copy is incomplete/.test(e.reason));
});

test('a root that decodes but is not a CountyIndex is a TransferFailed', async () => {
  const f = await fixture();
  await assert.rejects(transferArchive(f.tables.cid.toString(), f.deps), (e) => e instanceof TransferFailed && e.reason === 'not a CountyIndex block');
});

test('gatewayList reads ATLAS_GATEWAYS or the defaults', () => {
  assert.deepEqual(gatewayList({}), DEFAULT_GATEWAYS);
  assert.deepEqual(gatewayList({ ATLAS_GATEWAYS: '' }), DEFAULT_GATEWAYS, 'an empty secret counts as unset');
  assert.deepEqual(gatewayList({ ATLAS_GATEWAYS: ' https://a.test/, https://ipfs.filebase.io ' }), ['https://a.test', 'https://ipfs.filebase.io', 'https://trustless-gateway.link'], 'custom gateways go first, defaults follow');
});

test('fetchFromAny takes the first 2xx, skipping a 504, and throws listing every attempt when all fail', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (url.startsWith('https://a.test')) return new Response('', { status: 504 });
    if (url.startsWith('https://b.test')) return new Response('ok');
    throw new Error('unreachable');
  };
  const { res, url } = await fetchFromAny('bafy/x?format=raw', { gateways: ['https://a.test', 'https://b.test', 'https://c.test'], fetch });
  assert.equal(url, 'https://b.test/ipfs/bafy/x?format=raw');
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(seen, ['https://a.test/ipfs/bafy/x?format=raw', 'https://b.test/ipfs/bafy/x?format=raw']);
  await assert.rejects(fetchFromAny('bafy/x', { gateways: ['https://a.test', 'https://c.test'], fetch }), { message: 'https://a.test/ipfs/bafy/x: HTTP 504; https://c.test/ipfs/bafy/x: unreachable' });
});

test('validateCar is clean only on exit 0 and strips browserslist noise from the report', () => {
  const run = (status, stdout) => () => ({ status, stdout, stderr: '' });
  assert.deepEqual(validateCar('x.car', 'e.csv', 'cli', run(0, 'Browserslist: data is old\n  lexicon errors: 0\n')), { ok: true, report: '  lexicon errors: 0' });
  assert.deepEqual(validateCar('x.car', 'e.csv', 'cli', run(1, '  lexicon errors: 25\n')), { ok: false, report: '  lexicon errors: 25' });
  assert.equal(validateCar('x.car', 'e.csv', 'cli', () => ({ status: null, error: new Error('spawn cli ENOENT') })).ok, false);
});
