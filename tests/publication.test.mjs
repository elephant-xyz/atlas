import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PinFailed, token, waitForPin } from '../scripts/filebase.mjs';
import { rootsToPin } from '../scripts/pin-roots.mjs';
import { CID_A, CID_B, CID_C, group, page } from './helpers.mjs';

const at = (path, page) => ({ path, page });
const LEE = 'counties/FL/lee.json';

test('a new page pins its archive and tables roots', () => {
  assert.deepEqual(rootsToPin([at(LEE, page())], []), [
    { county: 'FL/lee', key: 'county.cid', cid: CID_A },
    { county: 'FL/lee', key: 'county.tables', cid: CID_B },
  ]);
});

test('a superseded cid pins only what is new; an unchanged page and a removed group pin nothing', () => {
  const base = [at(LEE, page())];
  assert.deepEqual(rootsToPin(base, base), []);
  assert.deepEqual(rootsToPin([at(LEE, page({ groups: {} }))], base), []);
  const head = [at(LEE, page({ groups: { county: group({ cid: CID_C }) } }))];
  assert.deepEqual(rootsToPin(head, base), [{ county: 'FL/lee', key: 'county.cid', cid: CID_C }]);
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
