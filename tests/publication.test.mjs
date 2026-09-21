import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PinFailed, token, waitForPin } from '../scripts/filebase.mjs';
import { rootsToPin } from '../scripts/pin-roots.mjs';
import { CID_A, CID_B, CID_C, page, run } from './helpers.mjs';

const at = (path, page) => ({ path, page });
const LEE = 'counties/FL/lee.json';

test('a new published run pins both roots', () => {
  const head = [at(LEE, page({ runs: [run({ status: 'withdrawn' }), run()] }))];
  const base = [at(LEE, page({ runs: [run({ status: 'withdrawn' })] }))];
  assert.deepEqual(rootsToPin(head, base), [
    { county: 'FL/lee', key: 'county_root', cid: CID_A },
    { county: 'FL/lee', key: 'tables_root', cid: CID_B },
  ]);
});

test('a brand-new page pins its published runs', () => {
  const r = run();
  delete r.tables_root;
  assert.deepEqual(rootsToPin([at(LEE, page({ runs: [r] }))], []), [{ county: 'FL/lee', key: 'county_root', cid: CID_A }]);
});

test('a status flip to published pins; a flip away from published does not', () => {
  const head = [at(LEE, page({ runs: [run(), run({ county_root: CID_C, tables_root: undefined, status: 'superseded' })] }))];
  const base = [at(LEE, page({ runs: [run({ status: 'superseded' }), run({ county_root: CID_C, tables_root: undefined })] }))];
  assert.deepEqual(rootsToPin(head, base).map((t) => t.cid), [CID_A, CID_B]);
});

test('a new withdrawn run and an unchanged page pin nothing', () => {
  const unchanged = [at(LEE, page())];
  assert.deepEqual(rootsToPin(unchanged, unchanged), []);
  const head = [at(LEE, page({ runs: [run(), run({ county_root: CID_C, tables_root: undefined, status: 'withdrawn' })] }))];
  assert.deepEqual(rootsToPin(head, unchanged), []);
});

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => (t += ms) };
};
const statuses = (...seq) => {
  const calls = [];
  return { calls, status: async () => (calls.push(1), seq[Math.min(calls.length - 1, seq.length - 1)]) };
};

test('waitForPin resolves once pinned and logs each transition', async () => {
  const log = [];
  const { status, calls } = statuses('unlisted', 'pinning', 'pinning', 'pinned');
  await waitForPin(CID_A, { limitMs: 60_000, intervalMs: 1_000, status, log: (l) => log.push(l), ...clock() });
  assert.equal(calls.length, 4);
  assert.deepEqual(log, [`pin ${CID_A}: unlisted`, `pin ${CID_A}: pinning`, `pin ${CID_A}: pinned`]);
});

test('waitForPin throws PinFailed on failed', async () => {
  const { status } = statuses('pinning', 'failed');
  await assert.rejects(waitForPin(CID_A, { limitMs: 60_000, intervalMs: 1_000, status, log() {}, ...clock() }), (e) => e instanceof PinFailed && e.status === 'failed' && e.cid === CID_A);
});

test('waitForPin throws PinFailed on timeout with the last status', async () => {
  const { status, calls } = statuses('pinning');
  await assert.rejects(waitForPin(CID_A, { limitMs: 5 * 60_000, intervalMs: 30_000, status, log() {}, ...clock() }), (e) => e instanceof PinFailed && e.status === 'still pinning after 5 min');
  assert.equal(calls.length, 11);
});

test('waitForPin propagates a status lookup error unchanged (not a publication failure)', async () => {
  await assert.rejects(waitForPin(CID_A, { limitMs: 60_000, status: async () => { throw new Error('HTTP 503'); }, log() {}, ...clock() }), (e) => !(e instanceof PinFailed) && e.message === 'HTTP 503');
});

test('token is base64 of access:secret:bucket', () => {
  assert.equal(token({ FILEBASE_ACCESS_KEY: 'a', FILEBASE_SECRET_KEY: 's' }), Buffer.from('a:s:elephant-atlas').toString('base64'));
  assert.throws(() => token({}), /required/);
});
