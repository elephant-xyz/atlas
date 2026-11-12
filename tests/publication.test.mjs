import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CarReader } from '@ipld/car';
import * as dagJson from '@ipld/dag-json';
import * as raw from 'multiformats/codecs/raw';
import { pinStatus, poll, token } from '../scripts/filebase.mjs';
import { buildEntries, claimOrder, holdBack, holdConflicts, latestPublished, pool, publishedGroup } from '../scripts/lib.mjs';
import { pinLookup, publishable, pushToMain, requireMainIndex } from '../scripts/publish-index.mjs';
import { openIssues, pendingIssues, revertedIssue, withdraw } from '../scripts/withdraw.mjs';
import { DEFAULT_GATEWAYS, fetchFromAny, gatewayList, redactGateways } from '../scripts/gateways.mjs';
import { TransferFailed, inChild, outage, planTransfers, runTransfers, transferArchive, transferArchiveFromCar, transferTables } from '../scripts/transfer-roots.mjs';
import { validateCar } from '../scripts/verify-roots.mjs';
import { CID_A, CID_B, CID_C, CID_D, block, car, group, page, registry } from './helpers.mjs';

const at = (path, page) => ({ path, page });
const LEE = 'counties/FL/lee.json';

const FULTON = 'counties/GA/fulton.json';
const fulton = (groups = { county: group({ cid: CID_C, tables: CID_D }) }) => page({ state: 'GA', county: 'fulton', fips: '13121', groups });
const indexOf = (...pages) => ({ version: 1, generated_from: 'x', counties: buildEntries(pages.map((page) => ({ page })), () => undefined) });
const cids = ({ targets }) => targets.map((t) => t.cid);
const heldGroup = (path, p, key) => ({ path, county: `${p.state}/${p.county}`, key, kind: 'withdrawn', cid: p.groups[key].cid, tables: p.groups[key].tables, root: p.groups[key].cid, reason: 'x' });
const holds = ({ held }) => held.map((h) => `${h.kind} ${h.county} ${h.key}`);

test('a new page transfers its archive and tables roots, archive first', () => {
  assert.deepEqual(planTransfers([at(LEE, page())], null).targets, [
    { county: 'FL/lee', key: 'county.cid', kind: 'archive', cid: CID_A, path: LEE, group: 'county', owed: true, inScope: true },
    { county: 'FL/lee', key: 'county.tables', kind: 'tables', cid: CID_B, path: LEE, group: 'county', owed: true, inScope: true },
  ]);
});

test('a superseded cid transfers only what is new; an unchanged page and a removed group transfer nothing', () => {
  const index = indexOf(page());
  assert.deepEqual(planTransfers([at(LEE, page())], index).targets, []);
  assert.deepEqual(planTransfers([at(LEE, page({ groups: {} }))], index).targets, []);
  assert.deepEqual(cids(planTransfers([at(LEE, page({ groups: { county: group({ cid: CID_C }) } }))], index)), [CID_C]);
});

test('a run transfers every root index.json does not list, whichever merge published it', () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  // lee is indexed; fulton merged earlier but its own run never finished.
  assert.deepEqual(cids(planTransfers(pages, indexOf(page()))), [CID_C, CID_D]);
  assert.deepEqual(cids(planTransfers(pages, null)), [CID_A, CID_B, CID_C, CID_D]);
  assert.deepEqual(cids(planTransfers(pages, indexOf(page(), fulton()))), []);
  assert.deepEqual(cids(planTransfers(pages, indexOf(page(), fulton()), { all: true })), [CID_A, CID_B, CID_C, CID_D]);
});

test('a run for one county transfers all of it again, and what the others are owed without ever blaming them', () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  // The dispatched run replaced fulton's own run in the queue, so it has to publish fulton too.
  const plan = planTransfers(pages, indexOf(page()), { only: 'FL/lee' });
  assert.deepEqual(plan.targets.map((t) => `${t.cid} ${t.inScope}`), [`${CID_A} true`, `${CID_B} true`, `${CID_C} false`, `${CID_D} false`]);
  assert.deepEqual(holds(plan), []);
  assert.deepEqual(cids(planTransfers(pages, indexOf(page(), fulton()), { only: 'FL/lee' })), [CID_A, CID_B]);
});

test('a root two groups claim goes to the one that had it first; the later claim is withdrawn and never transferred', () => {
  const pages = [at(LEE, page()), at(FULTON, fulton({ county: group({ cid: CID_A, tables: CID_D }) }))];
  // lee is published with CID_A; fulton merged claiming the same archive root.
  const plan = planTransfers(pages, indexOf(page()));
  assert.deepEqual(cids(plan), []);
  assert.deepEqual(holds(plan), ['withdrawn GA/fulton county']);
  assert.equal(plan.held[0].root, CID_A);
  // Neither is indexed yet: the group that got the root first keeps it, whichever run gets there.
  const leeFirst = planTransfers(pages, null, { claimed: (path) => (path === LEE ? 10 : 11) });
  assert.deepEqual(holds(leeFirst), ['withdrawn GA/fulton county']);
  assert.deepEqual(cids(leeFirst), [CID_A, CID_B]);
  assert.deepEqual(holds(planTransfers(pages, null, { claimed: (path) => (path === LEE ? 11 : 10) })), ['withdrawn FL/lee county']);
  // A run for lee only still withdraws fulton's claim: left on main it breaks every pull request's check.
  assert.deepEqual(holds(planTransfers(pages, indexOf(page()), { only: 'FL/lee' })), ['withdrawn GA/fulton county']);
});

test('two groups may exchange roots: each gives up what the other takes', () => {
  // A fix for archives assigned to the wrong counties: lee A->C, fulton C->A (tables kept).
  const before = [page(), fulton({ county: group({ cid: CID_C, tables: CID_D }) })];
  const pages = [at(LEE, page({ groups: { county: group({ cid: CID_C }) } })), at(FULTON, fulton({ county: group({ cid: CID_A, tables: CID_D }) }))];
  const plan = planTransfers(pages, indexOf(...before), { claimed: () => 5 });
  assert.deepEqual(holds(plan), []);
  // If one side of the exchange is withdrawn, the other cannot stand either.
  const half = holdConflicts(pages, indexOf(...before), [{ ...heldGroup(LEE, pages[0].page, 'county') }]);
  assert.deepEqual(holds({ held: half }), ['withdrawn FL/lee county', 'withdrawn GA/fulton county']);
});

test('a group that loses one root does not win another: the group after it keeps its own', () => {
  // Unpublished claims in merge order: a{X,T1}, b{X,Z}, c{Q,Z}. b loses X to a, so Z is c's.
  const [X, T1, Z, Q] = [CID_A, CID_B, CID_C, CID_D];
  const county = (name, cid, tables) => at(`counties/FL/${name}.json`, page({ county: name, groups: { county: group({ cid, tables }) } }));
  const pages = [county('a', X, T1), county('b', X, Z), county('c', Q, Z)];
  const order = { 'counties/FL/a.json': 1, 'counties/FL/b.json': 2, 'counties/FL/c.json': 3 };
  const plan = planTransfers(pages, null, { claimed: (path) => order[path] });
  assert.deepEqual(holds(plan), ['withdrawn FL/b county']);
  assert.deepEqual(cids(plan), [X, T1, Q, Z]);
});

test('two groups of one page that claim a root are ordered too: the first keeps it', () => {
  const both = page({ groups: { county: group(), hoa: group({ tables: CID_D }) } }); // both claim CID_A
  const plan = planTransfers([at(LEE, both)], null, { claimed: (_path, key) => (key === 'hoa' ? 1 : 2) });
  assert.deepEqual(holds(plan), ['withdrawn FL/lee county']);
  assert.deepEqual(cids(plan), [CID_A, CID_D]);
});

test('a page with a held group also gets its published fips back', () => {
  const changed = page({ fips: '99999', groups: { county: group({ cid: CID_C }) } });
  const [lee] = holdBack([at(LEE, changed)], [{ path: LEE, key: 'county' }], publishedGroup(indexOf(page())));
  assert.equal(lee.page.fips, '12071');
  const [fresh] = holdBack([at(FULTON, fulton())], [{ path: FULTON, key: 'county' }], publishedGroup(indexOf(page())));
  assert.equal(fresh.page.fips, '13121', 'a page the index does not know keeps its own');
  // Another group of the page is being published with the corrected fips: it stands.
  const two = page({ fips: '99999', groups: { county: group({ cid: CID_C }), hoa: group({ cid: CID_D, tables: CID_C }) } });
  assert.equal(holdBack([at(LEE, two)], [{ path: LEE, key: 'county' }], publishedGroup(indexOf(page())))[0].page.fips, '99999');
});

test('held groups go back to what was published: out of the index, and off the page', () => {
  const superseded = page({ groups: { county: group({ cid: CID_C }), hoa: group({ cid: CID_D, tables: CID_C }) } });
  const pages = [at(LEE, superseded), at(FULTON, fulton())];
  const published = publishedGroup(indexOf(page()));
  const held = [{ path: LEE, key: 'county' }, { path: FULTON, key: 'county' }];
  const [lee, ful] = holdBack(pages, held, published);
  assert.deepEqual(lee.page.groups, { county: { cid: CID_A, schema: group().schema, tables: CID_B }, hoa: superseded.groups.hoa }, 'the failed group is the published one again; the other group stays');
  assert.deepEqual(ful.page.groups, {}, 'a group that was never published is dropped');
  assert.deepEqual(buildEntries(holdBack(pages, held, published), () => undefined).map((e) => `${e.state}/${e.county} ${Object.keys(e.groups)}`), ['FL/lee county,hoa']);
  assert.equal(pages[0].page.groups.county.cid, CID_C, 'the input is not modified');
});

test('a root freed by a superseding publication is not handed to another group while that publication can still fail', () => {
  // lee is published with CID_A. One merge supersedes lee (CID_C), a later one gives the freed CID_A to fulton.
  const lee = page({ groups: { county: group({ cid: CID_C, tables: CID_B }) } });
  const pages = [at(LEE, lee), at(FULTON, fulton({ county: group({ cid: CID_A, tables: CID_D }) }))];
  const index = indexOf(page());
  const claimed = (path) => (path === LEE ? 1 : 2);
  assert.deepEqual(holds(planTransfers(pages, index, { claimed })), [], 'on main each root is used once, and lee lets go of CID_A first: nothing to hold');
  const rootsIn = (held) => buildEntries(holdBack(pages, held, publishedGroup(index)), () => undefined).flatMap((e) => Object.values(e.groups).map((g) => g.cid));
  // The supersede is withdrawn: lee is CID_A again for good, so fulton's claim goes too.
  const gone = holdConflicts(pages, index, [{ path: LEE, key: 'county', kind: 'withdrawn' }], { claimed });
  assert.deepEqual(holds({ held: gone.slice(1) }), ['withdrawn GA/fulton county']);
  assert.deepEqual(rootsIn(gone), [CID_A], 'the index lists the root once');
  // The supersede only failed for now: fulton waits for the next run.
  const waiting = holdConflicts(pages, index, [{ path: LEE, key: 'county', kind: 'deferred' }], { claimed });
  assert.deepEqual(holds({ held: waiting.slice(1) }), ['deferred GA/fulton county']);
  assert.deepEqual(rootsIn(waiting), [CID_A]);
});

test('a claim that only waits is withdrawn once the root goes back to its holder for good, so main never keeps the duplicate', () => {
  const lee = page({ groups: { county: group({ cid: CID_C, tables: CID_B }) } });
  const fultonPage = fulton({ county: group({ cid: CID_A, tables: CID_D }) });
  const pages = [at(LEE, lee), at(FULTON, fultonPage)];
  // lee's supersede was withdrawn back to CID_A; fulton's own transfer had merely been deferred.
  const held = [{ path: LEE, key: 'county', kind: 'withdrawn' }, { ...heldGroup(FULTON, fultonPage, 'county'), kind: 'deferred', reason: 'dag/import: HTTP 500' }];
  holdConflicts(pages, indexOf(page()), held);
  assert.equal(held.length, 2);
  assert.equal(held[1].kind, 'withdrawn');
  assert.match(held[1].reason, /^dag\/import: HTTP 500; and root .* is also held by counties\/FL\/lee\.json group county/);
  // A wait behind an earlier claim that itself only waits stays a wait.
  const rivals = [at(LEE, page()), at(FULTON, fultonPage)];
  const waits = holdConflicts(rivals, null, [{ ...heldGroup(LEE, page(), 'county'), kind: 'deferred' }], { claimed: (path) => (path === LEE ? 1 : 2) });
  assert.deepEqual(holds({ held: waits }), ['deferred FL/lee county', 'deferred GA/fulton county']);
});

test('pool starts nothing after a failure, aborts the signal its running jobs were given, and rejects with the first error', async () => {
  const started = [];
  const fails = async () => {
    started.push('fails');
    await new Promise((r) => setTimeout(r, 5));
    throw new Error('first');
  };
  // A job in a long request: it ends only when the signal the pool gave it is aborted.
  const longRequest = (signal) => {
    started.push('long');
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  const never = async () => started.push('never');
  await assert.rejects(pool([fails, longRequest, never, never], 2), /first/);
  assert.deepEqual(started, ['fails', 'long']);
});

test('a part that fails aborts the requests of the parts still in flight', async () => {
  const partA = await block(new TextEncoder().encode('a'), raw);
  const partB = await block(new TextEncoder().encode('b'), raw);
  const index = await block({ label: 'CountyIndex', shards: [] });
  const tables = await block({ label: 'CountyTables', county_root: index.cid, tables: { address: { parts: [{ cid: partA.cid }, { cid: partB.cid }] } } });
  let aborted = false;
  const fetch = async (url, { signal } = {}) => {
    if (url.endsWith(`${tables.cid}?format=raw`)) return new Response(tables.bytes);
    // Part 1 is a request that would run for an hour; part 0 is not served at all.
    if (url.includes('/parts/1/')) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(((aborted = true), signal.reason))));
    return new Response('no', { status: 404 });
  };
  let t = 0;
  const deps = { fetch, rpc: async () => [], gateways: ['https://gw.test'], deadlineMs: 60_000, sleep: async (ms) => (t += ms), now: () => t, log() {}, parallel: 2, tmp: await mkdtemp(join(tmpdir(), 'atlas-test-')) };
  await assert.rejects(transferTables(tables.cid.toString(), deps), (e) => e instanceof TransferFailed && /parts\/0\/cid\?format=car not available from any gateway/.test(e.reason));
  assert.ok(aborted, 'the request in flight was aborted, not waited for');
});

const transferring = (failures = {}) => {
  const done = [];
  return { done, transfer: async (t) => (failures[t.cid] ? Promise.reject(failures[t.cid]) : done.push(t.cid)) };
};
const quiet = { log: () => {}, error: () => {} };

test('one failed publication is withdrawn and the run goes on with the others', async () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  const { done, transfer } = transferring({ [CID_A]: new TransferFailed(CID_A, 'not available from any gateway') });
  const held = await runTransfers(pages, null, {}, { transfer, down: async () => undefined, ...quiet });
  assert.deepEqual(holds({ held }), ['withdrawn FL/lee county']);
  assert.equal(held[0].reason, 'not available from any gateway');
  assert.deepEqual(done, [CID_C, CID_D], "lee's tables root is not attempted, fulton is published");
});

test('a group that lost a root to one whose transfer then failed is not withdrawn with it', async () => {
  // lee (merged first) and fulton claim CID_A; lee's tables root cannot be served.
  const pages = [at(LEE, page()), at(FULTON, fulton({ county: group({ cid: CID_A, tables: CID_D }) }))];
  const { done, transfer } = transferring({ [CID_B]: new TransferFailed(CID_B, 'not available from any gateway') });
  const held = await runTransfers(pages, null, { claimed: (path) => (path === LEE ? 1 : 2) }, { transfer, down: async () => undefined, ...quiet });
  assert.deepEqual(holds({ held }), ['withdrawn FL/lee county'], 'fulton is publishable now; the next run transfers it');
  assert.deepEqual(done, [CID_A], "fulton's roots were not transferred while it looked like the loser");
  // When lee goes through, fulton's claim is withdrawn.
  const fine = transferring();
  assert.deepEqual(holds({ held: await runTransfers(pages, null, { claimed: (path) => (path === LEE ? 1 : 2) }, { transfer: fine.transfer, down: async () => undefined, ...quiet }) }), ['withdrawn GA/fulton county']);
});

test('a run withdraws one failed publication; more failing with it are deferred, since that may be the network', async () => {
  const unavailable = (cid) => new TransferFailed(cid, 'not available from any gateway');
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  const { transfer } = transferring({ [CID_A]: unavailable(CID_A), [CID_C]: unavailable(CID_C) });
  const held = await runTransfers(pages, null, {}, { transfer, down: async () => undefined, ...quiet });
  assert.deepEqual(holds({ held }), ['withdrawn FL/lee county', 'deferred GA/fulton county']);
  assert.match(held[1].reason, /not withdrawn: this run already withdrew a publication/);
});

test('a run for one county never withdraws another county\'s publication', async () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  const { done, transfer } = transferring({ [CID_C]: new TransferFailed(CID_C, 'not available from any gateway within 1 min') });
  const held = await runTransfers(pages, indexOf(page()), { only: 'FL/lee' }, { transfer, down: async () => undefined, ...quiet });
  assert.deepEqual(holds({ held }), ['deferred GA/fulton county']);
  assert.deepEqual(done, [CID_A, CID_B]);
});

test('during an outage nothing is withdrawn: the failing group is deferred and the rest is not attempted', async () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  const { done, transfer } = transferring({ [CID_A]: new TransferFailed(CID_A, 'not available from any gateway') });
  let checks = 0;
  const down = async () => (checks++ ? 'no gateway serves the published root' : undefined); // fine before the run, down at the failure
  const held = await runTransfers(pages, null, {}, { transfer, down, ...quiet });
  assert.deepEqual(holds({ held }), ['deferred FL/lee county', 'deferred GA/fulton county']);
  assert.match(held[1].reason, /^not attempted: no gateway serves/);
  assert.deepEqual(done, []);
  // Down before the first transfer: nothing is done, and nothing may be indexed.
  assert.equal(await runTransfers(pages, null, {}, { transfer, down: async () => 'Filebase does not answer', ...quiet }), undefined);
  assert.deepEqual(done, []);
});

test('a run keeps to its time: a root gets what is left of it, and what does not fit is deferred unattempted', async () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  let clock = 0;
  const given = [];
  const transfer = async (t, { timeoutMs }) => {
    given.push([t.cid, timeoutMs]);
    clock += 40;
  };
  const held = await runTransfers(pages, null, {}, { transfer, down: async () => undefined, now: () => clock, budgetMs: 100, rootMs: 50, ...quiet });
  assert.deepEqual(given, [[CID_A, 50], [CID_B, 50], [CID_C, 20]]);
  assert.deepEqual(holds({ held }), ['deferred GA/fulton county']);
  assert.equal(held[0].reason, 'not attempted: the run was out of time');
});

test('a root is copied in a process of its own: its verdict comes back, and a process that dies or hangs is an ordinary error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-test-'));
  const script = join(dir, 'child.mjs');
  // Stands in for transfer-roots.mjs --one: behaves as the target's cid says.
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
    const { cid } = JSON.parse(arg('--one'));
    if (cid === 'ok') writeFileSync(arg('--result'), '{"ok":true}');
    else if (cid === 'unpublishable') { writeFileSync(arg('--result'), '{"failed":"not available from any gateway"}'); process.exit(1); }
    else if (cid === 'rpc') { writeFileSync(arg('--result'), '{"error":"dag/import: HTTP 500"}'); process.exit(1); }
    else if (cid === 'dies') process.abort();
    else await new Promise((r) => setTimeout(r, 60_000));
  `);
  const run = (cid, ms = 30_000) => inChild({ cid }, ms, [script]);
  await run('ok');
  await assert.rejects(run('unpublishable'), (e) => e instanceof TransferFailed && e.cid === 'unpublishable' && e.reason === 'not available from any gateway');
  await assert.rejects(run('rpc'), (e) => !(e instanceof TransferFailed) && e.message === 'dag/import: HTTP 500');
  await assert.rejects(run('dies'), (e) => !(e instanceof TransferFailed) && /ended on .* without a result/.test(e.message));
  await assert.rejects(run('hangs', 300), (e) => !(e instanceof TransferFailed) && /ended on SIGTERM without a result/.test(e.message));
});

test('an error that is not the publication\'s fault, or a failure on a published root, is deferred', async () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  const rpcError = transferring({ [CID_A]: new Error('dag/import: HTTP 500') });
  assert.deepEqual(holds({ held: await runTransfers(pages, null, {}, { transfer: rpcError.transfer, down: async () => undefined, ...quiet }) }), ['deferred FL/lee county']);
  assert.deepEqual(rpcError.done, [CID_C, CID_D]);
  // --all: lee is published already; failing to copy it again takes nothing off main.
  const again = transferring({ [CID_A]: new TransferFailed(CID_A, 'not available from any gateway') });
  const held = await runTransfers(pages, indexOf(page(), fulton()), { all: true }, { transfer: again.transfer, down: async () => undefined, ...quiet });
  assert.deepEqual(holds({ held }), ['deferred FL/lee county']);
  assert.match(held[0].reason, /^already published, but it would not transfer again: /);
});

test('outage judges the service on the last published roots: a gateway serves the hashed bytes of one and Filebase lists it pinned', async () => {
  const index = { counties: [{ groups: { a: { cid: CID_A, published_at: '2026-01-01T00:00:00.000Z' }, b: { cid: CID_C, published_at: '2026-02-01T00:00:00.000Z' }, c: { cid: CID_D } } }] };
  assert.deepEqual(latestPublished(index), [CID_C, CID_A, CID_D]);
  assert.deepEqual(latestPublished(index, 1), [CID_C]);
  assert.deepEqual(latestPublished(null), []);
  const canary = await block({ label: 'CountyIndex', shards: [] });
  const other = await block({ label: 'CountyIndex', shards: [], n: 2 });
  const [cid, cid2] = [canary.cid.toString(), other.cid.toString()];
  const good = async (url) => new Response(url.includes(cid2) ? other.bytes : canary.bytes);
  const pinnedAll = async (path) => [{ Keys: { [new URL(`x:?${path.split('?')[1]}`).searchParams.get('arg')]: { Type: 'recursive' } } }];
  const deps = { gateways: ['https://g', 'https://g2'], sleep: async () => {}, fetch: good, rpc: pinnedAll };
  assert.equal(await outage([cid], deps), undefined);
  assert.equal(await outage([], { ...deps, fetch: async () => new Response('', { status: 504 }) }), undefined, 'an empty registry has nothing to judge by');
  assert.match(await outage([cid], { ...deps, fetch: async () => new Response('', { status: 504 }) }), /^no gateway serves the published root .*HTTP 504/);
  assert.match(await outage([cid], { ...deps, fetch: async () => new Response('<html>captive portal</html>') }), /^no gateway serves the published root .*bytes do not hash to the CID/, 'a 200 is not proof');
  assert.equal(await outage([cid], { ...deps, fetch: async (url) => (url.startsWith('https://g2/') ? good(url) : new Response('<html>')) }), undefined, 'the second gateway serves it');
  assert.match(await outage([cid], { ...deps, rpc: async () => { throw new Error('pin/ls: HTTP 401'); } }), /^Filebase does not answer for the published root .*HTTP 401/);
  assert.match(await outage([cid], { ...deps, rpc: async () => [{}] }), /^Filebase does not list the published root/);
  let calls = 0;
  assert.equal(await outage([cid], { ...deps, gateways: ['https://g'], fetch: async (url) => (calls++ ? good(url) : new Response('', { status: 504 })) }), undefined, 'a blip is not an outage');
  // The newest published root has itself gone missing: that is its problem, not an outage.
  const lostPin = async (path) => (path.includes(cid) ? [{}] : pinnedAll(path));
  assert.equal(await outage([cid, cid2], { ...deps, rpc: lostPin }), undefined);
  assert.equal(await outage([cid, cid2], { ...deps, fetch: async (url) => (url.includes(cid2) ? good(url) : new Response('', { status: 404 })) }), undefined);
});

test('the index lists an owed group only when Filebase has both its roots pinned, and says which groups it left out and why', async () => {
  const pages = [at(LEE, page()), at(FULTON, fulton())];
  const ask = (pinnedRoots, why = 'not listed') => async (cid) => (pinnedRoots.includes(cid) ? { pinned: true } : { pinned: false, why });
  const listed = async (pinned, index = indexOf(page())) => {
    const { pages: out, left } = await publishable(pages, index, { pinned });
    return [buildEntries(out, () => undefined).map((e) => `${e.state}/${e.county}`), left.map((h) => `${h.county} ${h.key}: ${h.reason}`)];
  };
  assert.deepEqual(await listed(ask([CID_C, CID_D])), [['FL/lee', 'GA/fulton'], []]);
  assert.deepEqual(await listed(ask([CID_C])), [['FL/lee'], [`GA/fulton county: Filebase does not list ${CID_D} as pinned (not listed)`]], 'the tables root did not arrive');
  // Filebase did not answer: the group is left out, and reported, not passed over.
  assert.deepEqual(await listed(ask([], 'pin/ls: HTTP 500')), [['FL/lee'], [`GA/fulton county: Filebase does not list ${CID_C} as pinned (pin/ls: HTTP 500)`]]);
  assert.deepEqual((await listed(ask([]), null))[0], [], 'an empty registry stays empty');
  // Pinned or not, a root another group holds is not listed twice.
  const twice = [at(LEE, page()), at(FULTON, fulton({ county: group({ cid: CID_A, tables: CID_D }) }))];
  const { pages: out, left } = await publishable(twice, indexOf(page()), { pinned: ask([CID_A, CID_D]) });
  assert.deepEqual(buildEntries(out, () => undefined).map((e) => `${e.state}/${e.county}`), ['FL/lee']);
  assert.deepEqual(holds({ held: left }), ['withdrawn GA/fulton county']);
});

test('the index step asks about every owed root, unless Filebase cannot even list what it published last', async () => {
  const asked = [];
  const status = (pinnedRoots) => async (cid, opts) => (asked.push([cid, opts?.tries]), pinnedRoots.includes(cid) ? { pinned: true } : { pinned: false, why: 'pin/ls: HTTP 500' });
  // Filebase works (it lists a published root): an unpinned owed root is asked about, three tries, and so is the next one.
  let pinned = await pinLookup([CID_A, CID_B], status([CID_B]));
  assert.deepEqual(await pinned(CID_C), { pinned: false, why: 'pin/ls: HTTP 500' });
  assert.deepEqual(await pinned(CID_B), { pinned: true });
  assert.deepEqual(asked.slice(-2), [[CID_C, 3], [CID_B, 3]]);
  // It lists none of them: nothing more is asked, every owed root is left out and says why.
  asked.length = 0;
  pinned = await pinLookup([CID_A, CID_B], status([]));
  assert.match((await pinned(CID_C)).why, /^not asked: /);
  assert.deepEqual(asked.map(([cid]) => cid), [CID_A, CID_B]);
  // An empty registry has nothing to judge by.
  assert.deepEqual(await (await pinLookup([], status([CID_C])))(CID_C), { pinned: true });
});

test('a failure reason posted in an issue names no private gateway', () => {
  const env = { ATLAS_GATEWAYS: 'https://secret-gw.example/, https://other.example' };
  const reason = '/ipfs/x not available from any gateway within 20 min: https://secret-gw.example/ipfs/x: HTTP 504; https://ipfs.filebase.io/ipfs/x: HTTP 504; https://other.example/ipfs/x: timeout';
  assert.equal(redactGateways(reason, env), '/ipfs/x not available from any gateway within 20 min: https://<private gateway>/ipfs/x: HTTP 504; https://ipfs.filebase.io/ipfs/x: HTTP 504; https://<private gateway>/ipfs/x: timeout');
  assert.equal(redactGateways(reason, {}), reason);
});

test('pinStatus tells a listed pin from a missing one and from a call that failed, and asks again', async () => {
  const listed = async () => [{ Keys: { [CID_A]: { Type: 'recursive' } } }];
  assert.deepEqual(await pinStatus(CID_A, { call: listed }), { pinned: true });
  assert.deepEqual(await pinStatus(CID_A, { call: async () => [{}] }), { pinned: false, why: 'not listed' });
  assert.deepEqual(await pinStatus(CID_A, { call: async () => { throw new Error('pin/ls: HTTP 500'); } }), { pinned: false, why: 'pin/ls: HTTP 500' });
  let calls = 0;
  const flaky = async () => (calls++ ? listed() : Promise.reject(new Error('pin/ls: HTTP 500')));
  assert.deepEqual(await pinStatus(CID_A, { call: flaky, tries: 3, sleep: async () => {} }), { pinned: true });
  assert.equal(calls, 2);
});

test('every withdrawn group gets its issue: one that cannot be opened is retried, reported, and does not stop the rest', async () => {
  const issues = [heldGroup(LEE, page(), 'county'), heldGroup(FULTON, fulton(), 'county')].map((h) => revertedIssue(h, 'abc123', 'https://run'));
  const opened = [];
  const errors = [];
  let leeTries = 0;
  const create = (title) => {
    if (title.includes('FL/lee') && ++leeTries) throw new Error('HTTP 403 rate limit');
    opened.push(title);
  };
  const unopened = await openIssues(issues, { create, sleep: async () => {}, error: (l) => errors.push(l) });
  assert.equal(leeTries, 3);
  assert.deepEqual(opened, [`Publication reverted: GA/fulton ${CID_C}`]);
  assert.deepEqual(unopened, [`Publication reverted: FL/lee ${CID_A}`]);
  assert.match(errors[0], /^::error title=Issue not opened: Publication reverted: FL\/lee .*withdrawn from `main` in abc123/);
});

test('a publication that has waited too long gets one issue, and one taken off main does not', () => {
  const hour = 3_600_000;
  const now = Date.parse('2026-11-12T12:00:00Z');
  const since = (path) => (path === LEE ? '2026-11-11T12:00:00.000Z' : '2026-11-12T10:00:00.000Z'); // lee a day ago, fulton two hours ago
  const left = [
    { ...heldGroup(LEE, page(), 'county'), kind: 'deferred', reason: 'dag/import: HTTP 500' },
    { ...heldGroup(FULTON, fulton(), 'county'), kind: 'deferred', reason: 'x' },
    { ...heldGroup(LEE, page({ groups: { hoa: group({ cid: CID_D }) } }), 'hoa'), kind: 'withdrawn' },
  ];
  const issues = pendingIssues(left, 'https://run', { since, olderThan: now - 12 * hour, isOpen: () => false });
  assert.deepEqual(issues.map((i) => i.title), ['Publication pending: FL/lee county']);
  assert.match(issues[0].body, /has been on `main` since 2026-11-11T12:00:00.000Z and is not published.*last reason: dag\/import: HTTP 500/s);
  assert.deepEqual(pendingIssues(left, 'https://run', { since, olderThan: now - 12 * hour, isOpen: () => true }), [], 'not opened twice');
});

// ---- a registry with a remote, for the commits the publish run pushes
const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function remoteRegistry(files) {
  const remote = registry({});
  g(remote, 'init', '-q', '--bare', '-b', 'main');
  const clone = () => {
    const dir = registry({});
    g(dir, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) g(dir, 'config', k, v);
    g(dir, 'remote', 'add', 'origin', remote);
    return dir;
  };
  const dev = clone();
  /** Commit `files` ({ path: object | null }, null deletes) on main and push: one merged pull request. */
  const merge = (message, changes) => {
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) rmSync(join(dev, path));
      else {
        mkdirSync(dirname(join(dev, path)), { recursive: true });
        writeFileSync(join(dev, path), JSON.stringify(value, null, 2) + '\n');
      }
    }
    g(dev, 'add', '-A');
    g(dev, 'commit', '-q', '-m', message);
    g(dev, 'push', '-q', 'origin', 'HEAD:main');
  };
  merge('main', files);
  const run = clone();
  g(run, 'pull', '-q', 'origin', 'main');
  const pageOnMain = (path) => {
    try {
      return JSON.parse(g(remote, 'show', `main:${path}`));
    } catch {
      return null;
    }
  };
  return { remote, run, merge, pageOnMain };
}

test('the index commit is pushed on top of a main that moved during the run', () => {
  const { remote, run, merge } = remoteRegistry({ [LEE]: page(), 'index.json': {} });
  merge('another publication', { 'counties/FL/polk.json': {} });
  writeFileSync(`${run}/index.json`, '{"version":1}');
  g(run, 'commit', '-q', '-am', 'Publish index.json');
  pushToMain(run);
  assert.deepEqual(g(remote, 'log', '--format=%s', 'main').split('\n'), ['Publish index.json', 'another publication', 'main']);
  assert.equal(g(remote, 'show', 'main:index.json'), '{"version":1}');
});

test('an index commit made on a branch that is not main is not pushed', () => {
  const { remote, run } = remoteRegistry({ [LEE]: page(), 'index.json': {} });
  const tip = g(remote, 'rev-parse', 'main');
  writeFileSync(`${run}/README.md`, 'a commit of some feature branch\n');
  g(run, 'add', '-A');
  g(run, 'commit', '-q', '-m', 'not on main');
  writeFileSync(`${run}/index.json`, '{"version":1}');
  g(run, 'commit', '-q', '-am', 'Publish index.json');
  assert.throws(() => pushToMain(run), /this checkout is not main/);
  assert.equal(g(remote, 'rev-parse', 'main'), tip);
});

test('withdrawing a group does not touch a later merge to the same page, and main moving is not a conflict', () => {
  // A added group county (its root then failed); B added group hoa to the same page; C merged elsewhere mid-run.
  const a = page();
  const b = page({ groups: { ...a.groups, hoa: group({ cid: CID_C, tables: CID_D }) } });
  const { remote, run, merge, pageOnMain } = remoteRegistry({ 'index.json': indexOf() });
  merge('A', { [LEE]: a });
  merge('B', { [LEE]: b });
  g(run, 'pull', '-q', 'origin', 'main');
  merge('C', { [FULTON]: fulton({ county: group({ cid: CID_D, tables: CID_C }) }) });
  const { sha, done } = withdraw(run, [heldGroup(LEE, a, 'county')]);
  assert.equal(done.length, 1);
  assert.deepEqual(pageOnMain(LEE).groups, { hoa: b.groups.hoa });
  assert.ok(pageOnMain(FULTON), 'the merge that landed during the run is still there');
  assert.equal(g(remote, 'rev-parse', 'main'), sha);
  assert.match(g(remote, 'log', '-1', '--format=%s', 'main'), /^Withdraw FL\/lee county: not publishable \[skip ci\]$/);
  // Again: nothing holds the failed roots any more, so nothing is pushed, whatever else lies in the workspace.
  writeFileSync(`${run}/held.json`, '[]');
  assert.deepEqual(withdraw(run, [heldGroup(LEE, a, 'county')]), { done: [] });
  assert.equal(g(remote, 'rev-parse', 'main'), sha);
});

test('a failed supersede goes back to the published group verbatim, and failing again changes nothing (no revert of a revert)', () => {
  // lee is published with a car file. M1 supersedes it (never indexed), M2 supersedes M1; M2 fails, then M1's root too.
  const published = page({ groups: { county: group({ car: CID_D }) } });
  const m1 = page({ groups: { county: group({ cid: CID_C, tables: CID_D }) } });
  const m2 = page({ groups: { county: group({ cid: CID_D, tables: CID_C }) } });
  const { remote, run, merge, pageOnMain } = remoteRegistry({ [LEE]: published, 'index.json': indexOf(published) });
  merge('M1', { [LEE]: m1 });
  merge('M2', { [LEE]: m2 });
  withdraw(run, [heldGroup(LEE, m2, 'county')]);
  assert.deepEqual(pageOnMain(LEE), published, 'back to the published group, car included, not to M1');
  const tip = g(remote, 'rev-parse', 'main');
  assert.deepEqual(withdraw(run, [heldGroup(LEE, m1, 'county'), heldGroup(LEE, m2, 'county')]), { done: [] });
  assert.equal(g(remote, 'rev-parse', 'main'), tip);
});

test('a group the index step published after all is not withdrawn and gets no issue', () => {
  // The transfer step withdrew fulton (its pin check flaked), but Filebase had it and the index lists it.
  const { remote, run } = remoteRegistry({ [LEE]: page(), [FULTON]: fulton(), 'index.json': indexOf(page(), fulton()) });
  const tip = g(remote, 'rev-parse', 'main');
  assert.deepEqual(withdraw(run, [heldGroup(FULTON, fulton(), 'county')]), { done: [] });
  assert.equal(g(remote, 'rev-parse', 'main'), tip);
});

test('the IPNS name is only ever pointed at the index main has', () => {
  const { run, merge } = remoteRegistry({ [LEE]: page(), 'index.json': indexOf(page()) });
  const mine = readFileSync(`${run}/index.json`);
  requireMainIndex(run, mine);
  // A stale checkout: main's index has moved on.
  merge('Publish index.json', { [FULTON]: fulton(), 'index.json': indexOf(page(), fulton()) });
  assert.throws(() => requireMainIndex(run, mine), /not the one on main; the IPNS name was not touched/);
});

test('claimOrder is where on main a group got its current roots, per group', () => {
  const { run, merge } = remoteRegistry({ 'index.json': {} });
  merge('lee county', { [LEE]: page() });
  merge('fulton', { [FULTON]: fulton() });
  merge('lee hoa, same page', { [LEE]: page({ groups: { county: group(), hoa: group({ cid: CID_C, tables: CID_D }) } }) });
  g(run, 'pull', '-q', 'origin', 'main');
  const at = claimOrder(run);
  assert.ok(at(LEE, 'county') < at(FULTON, 'county'));
  assert.ok(at(FULTON, 'county') < at(LEE, 'hoa'), "lee's page changed last, but its county group did not");
  assert.equal(at(LEE, 'nope'), undefined);
  // A page that was withdrawn (deleted) and published again counts from the second time.
  merge('withdraw fulton', { [FULTON]: null });
  merge('polk', { 'counties/FL/polk.json': page({ county: 'polk' }) });
  merge('fulton again', { [FULTON]: fulton() });
  g(run, 'pull', '-q', 'origin', 'main');
  const again = claimOrder(run);
  assert.ok(again('counties/FL/polk.json', 'county') < again(FULTON, 'county'));
  assert.equal(claimOrder('/nonexistent')(LEE, 'county'), undefined);
});

test('a withdrawn group does not take back roots main has given to another group meanwhile', () => {
  // lee is published with CID_A and superseded (CID_C), which then fails. During the run a merge gives CID_A to fulton.
  const superseded = page({ groups: { county: group({ cid: CID_C }), hoa: group({ cid: CID_D, tables: CID_C }) } });
  const { run, merge, pageOnMain } = remoteRegistry({ [LEE]: page(), 'index.json': indexOf(page()) });
  merge('supersede', { [LEE]: superseded });
  g(run, 'pull', '-q', 'origin', 'main');
  merge('fulton takes the freed root', { [FULTON]: fulton({ county: group({ cid: CID_A, tables: 'baguqeeraceyahyqrzlj3cdbhlhfyrtmk3qz7mvz4kk4fd5nqd4ybzuh3xuaa' }) }) });
  const { done } = withdraw(run, [heldGroup(LEE, superseded, 'county')]);
  assert.equal(done.length, 1);
  assert.deepEqual(Object.keys(pageOnMain(LEE).groups), ['hoa'], 'the group is dropped, not put back on a root that is no longer free');
  assert.equal(pageOnMain(FULTON).groups.county.cid, CID_A);
});

test('a page whose only group was never published is deleted, and a group someone changed since is left alone', () => {
  const { run, merge, pageOnMain } = remoteRegistry({ [LEE]: page(), 'index.json': indexOf(page()) });
  merge('new county', { [FULTON]: fulton() });
  const failed = heldGroup(FULTON, fulton(), 'county');
  merge('the author fixed it before the run got there', { [FULTON]: fulton({ county: group({ cid: CID_D, tables: CID_C }) }) });
  assert.deepEqual(withdraw(run, [failed]), { done: [] });
  assert.equal(pageOnMain(FULTON).groups.county.cid, CID_D);
  withdraw(run, [heldGroup(FULTON, pageOnMain(FULTON), 'county')]);
  assert.equal(pageOnMain(FULTON), null);
  assert.ok(pageOnMain(LEE));
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

test('transferTables imports each part by path, then the tables block pinned (never the tables block first)', async () => {
  const f = await fixture();
  await transferTables(f.tables.cid.toString(), f.deps);
  assert.deepEqual(f.calls, [
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

test('a group with car carries it to the transfer', () => {
  const head = [at(LEE, page({ groups: { county: group({ car: CID_C }) } }))];
  assert.deepEqual(planTransfers(head, null).targets.map((r) => r.car), [CID_C, undefined]);
});

test('transferArchiveFromCar downloads the car file once, imports post-order pieces, then pins the root', async () => {
  const f = await fixture();
  const leafA = await block({ label: 'Seed', relationships: {}, n: 1 });
  const leafB = await block(new TextEncoder().encode('leaf'), raw);
  const property = await block({ label: 'Seed', relationships: { a: leafA.cid, b: leafB.cid } });
  const shard0 = await block({ properties: [{ property_cid: property.cid, data_groups: {} }] });
  const shard1 = await block({ properties: [{ property_cid: leafA.cid, data_groups: {} }] });
  const index = await block({ label: 'CountyIndex', properties: 2, shards: [shard0.cid, shard1.cid], version: 1 });
  const CAR = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const file = await car(index.cid, [index, shard0, property, leafA, leafB, shard1]);
  const fetched = [];
  const order = [];
  const rpc = async (path, { body } = {}) => {
    if (path.startsWith('pin/ls')) return [{ Keys: { [index.cid.toString()]: { Type: 'recursive' } } }];
    const reader = await CarReader.fromBytes(new Uint8Array(await body.get('file').arrayBuffer()));
    let n = 0;
    for await (const b of reader.blocks()) (n++, order.push(b.cid.toString()));
    const [root] = await reader.getRoots();
    f.calls.push(`${path.split('&')[0]} root=${root} blocks=${n}`);
    return [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }];
  };
  const fetch = async (url) => (fetched.push(url), url === `${f.G}/ipfs/${CAR}` ? new Response(file) : new Response('no', { status: 404 }));
  await transferArchiveFromCar(index.cid.toString(), CAR, { ...f.deps, fetch, rpc, parallel: 1, pieceBytes: 1 });
  assert.deepEqual(fetched, [`${f.G}/ipfs/${CAR}`], 'one request');
  const at_ = (c) => order.indexOf(c.cid.toString());
  assert.ok(at_(leafA) < at_(property) && at_(leafB) < at_(property) && at_(property) < at_(shard0), 'every block is imported after the blocks it links to');
  assert.equal(order.filter((c) => c === leafA.cid.toString()).length, 1, 'a block two shards share is imported once when shards run one at a time');
  assert.equal(f.calls.at(-1), `dag/import?pin-roots=true root=${index.cid} blocks=1`);
  assert.equal(f.calls.length, 6, f.calls.join('\n'));
  assert.deepEqual(readdirSync(f.tmp), [], 'temp CAR deleted');
});

test('shards in parallel never import a piece linking a block that is only queued elsewhere (Filebase holds such imports)', async () => {
  const f = await fixture();
  const shared = await block({ label: 'Seed', relationships: {}, n: 2 });
  const shards = [];
  for (let k = 0; k < 4; k++) {
    const own = await block({ label: 'Seed', relationships: { s: shared.cid }, k });
    shards.push({ own, shard: await block({ properties: [{ property_cid: own.cid, data_groups: {} }] }) });
  }
  const index = await block({ label: 'CountyIndex', properties: 4, shards: shards.map((s) => s.shard.cid), version: 1 });
  const CAR = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const file = await car(index.cid, [index, shared, ...shards.flatMap((s) => [s.own, s.shard])]);
  const stored = new Set();
  const hung = [];
  const paths = [];
  const rpc = async (path, { body } = {}) => {
    paths.push(path);
    if (path.startsWith('pin/ls')) return [{ Keys: { [index.cid.toString()]: { Type: 'recursive' } } }];
    const reader = await CarReader.fromBytes(new Uint8Array(await body.get('file').arrayBuffer()));
    const here = [];
    for await (const b of reader.blocks()) here.push(b);
    await new Promise((r) => setTimeout(r, 5)); // imports overlap
    const inCar = new Set(here.map((b) => b.cid.toString()));
    for (const b of here) {
      if (b.cid.code !== dagJson.code) continue;
      const links = JSON.stringify(dagJson.decode(b.bytes)).match(/"\/":"(ba[a-z0-9]+)"/g) ?? [];
      for (const l of links.map((x) => x.split('"')[3])) if (!inCar.has(l) && !stored.has(l)) throw (hung.push(l), new Error(`import would hang: ${b.cid} links missing ${l}`));
    }
    for (const b of here) stored.add(b.cid.toString());
    const [root] = await reader.getRoots();
    return [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: here.length, BlockBytesCount: 0 } }];
  };
  const fetch = async (url) => (url === `${f.G}/ipfs/${CAR}` ? new Response(file) : new Response('no', { status: 404 }));
  await transferArchiveFromCar(index.cid.toString(), CAR, { ...f.deps, fetch, rpc, parallel: 4, pieceBytes: 1, sleep: async () => {} });
  assert.deepEqual(hung, [], 'no import linked a block the bucket lacked');
  assert.ok(!paths.some((p) => p.startsWith('block/get')), 'no block/get presence check unless ATLAS_SKIP_STORED_SHARDS=1');
  assert.ok(stored.has(index.cid.toString()) && stored.has(shared.cid.toString()));
});

test('a re-run skips shards whose root the bucket already holds and gives the pinned import the pin timeout', async () => {
  const f = await fixture();
  const a = await block({ label: 'Seed', relationships: {}, n: 7 });
  const b = await block({ label: 'Seed', relationships: {}, n: 8 });
  const shard0 = await block({ properties: [{ property_cid: a.cid, data_groups: {} }] });
  const shard1 = await block({ properties: [{ property_cid: b.cid, data_groups: {} }] });
  const index = await block({ label: 'CountyIndex', properties: 2, shards: [shard0.cid, shard1.cid], version: 1 });
  const CAR = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const file = await car(index.cid, [index, shard0, a, shard1, b]);
  const imported = [];
  const timeouts = [];
  const rpc = async (path, { body, timeoutMs } = {}) => {
    if (path.startsWith('pin/ls')) return [{ Keys: { [index.cid.toString()]: { Type: 'recursive' } } }];
    if (path.startsWith('block/get')) {
      if (path.includes(shard0.cid.toString())) return [{}];
      throw new Error('The operation was aborted');
    }
    const reader = await CarReader.fromBytes(new Uint8Array(await body.get('file').arrayBuffer()));
    let n = 0;
    for await (const blk of reader.blocks()) (n++, imported.push(blk.cid.toString()));
    const [root] = await reader.getRoots();
    if (path.includes('pin-roots=true')) timeouts.push(timeoutMs);
    return [{ Root: { Cid: { '/': root.toString() }, PinErrorMsg: '' } }, { Stats: { BlockCount: n, BlockBytesCount: 0 } }];
  };
  const fetch = async (url) => (url === `${f.G}/ipfs/${CAR}` ? new Response(file) : new Response('no', { status: 404 }));
  await transferArchiveFromCar(index.cid.toString(), CAR, { ...f.deps, fetch, rpc, parallel: 2, pieceBytes: 1, pinMs: 123, skipStored: true });
  assert.ok(!imported.includes(shard0.cid.toString()) && !imported.includes(a.cid.toString()), 'shard 0 skipped');
  assert.ok(imported.includes(shard1.cid.toString()) && imported.includes(b.cid.toString()), 'shard 1 sent');
  assert.deepEqual(timeouts, [123]);
});

test('a car file that is not a CAR, or a root block that does not decode, is the publication\'s fault: a TransferFailed', async () => {
  const f = await fixture();
  const CAR = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const garbage = async () => new Response(new TextEncoder().encode('<html>not a car</html>'));
  await assert.rejects(transferArchiveFromCar(f.index.cid.toString(), CAR, { ...f.deps, fetch: garbage }), (e) => e instanceof TransferFailed && /is not a readable CAR/.test(e.reason));
  assert.deepEqual(readdirSync(f.tmp), [], 'and the download is removed');
  // A raw block where dag-json is expected: it hashes to its CID, so it will never decode.
  const notJson = await block(new TextEncoder().encode('\x00\x01 not json'), raw);
  await assert.rejects(transferArchive(notJson.cid.toString(), { ...f.deps, fetch: async () => new Response(notJson.bytes) }), (e) => e instanceof TransferFailed && /is not dag-json/.test(e.reason));
});

test('a car file that lacks a block is a TransferFailed', async () => {
  const f = await fixture();
  const CAR = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const file = await car(f.index.cid, [f.index, f.shard]);
  const fetch = async (url) => (url.endsWith(CAR) ? new Response(file) : new Response('no', { status: 404 }));
  await assert.rejects(transferArchiveFromCar(f.index.cid.toString(), CAR, { ...f.deps, fetch }), (e) => e instanceof TransferFailed && /missing block/.test(e.reason));
});
