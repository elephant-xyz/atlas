// Filebase access for the publish workflow: one place for the token, the Kubo RPC, the
// Pinning Service status, and the poll loop both callers share.
const RPC = process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io';
const PINS = process.env.FILEBASE_PINS ?? 'https://api.filebase.io/v1/ipfs/pins';

/** Kubo RPC bearer token: base64 of ACCESS:SECRET:BUCKET. Never log it. */
export function token(env = process.env) {
  const { FILEBASE_ACCESS_KEY: access, FILEBASE_SECRET_KEY: secret, FILEBASE_BUCKET: bucket = 'elephant-atlas' } = env;
  if (!access || !secret) throw new Error('FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY are required');
  return Buffer.from(`${access}:${secret}:${bucket}`).toString('base64');
}

/** POST /api/v0/<path>; returns the last JSON line of the response. */
export async function rpc(path, { body, timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${RPC}/api/v0/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token()}` }, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const lines = text.split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : {};
}

/** Pinning Service status of a CID on the bucket: queued | pinning | pinned | failed | unlisted. */
export async function pinStatus(cid) {
  const res = await fetch(`${PINS}?cid=${cid}`, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`pins?cid=${cid}: HTTP ${res.status}`);
  const { results = [] } = await res.json();
  return results[0]?.status ?? 'unlisted';
}

/**
 * Call `check` until it returns a truthy value or `limitMs` passes. `check` may throw to abort.
 * `sleep` and `now` are injectable for tests.
 */
export async function poll(check, { limitMs, intervalMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const started = now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (now() - started >= limitMs) return undefined;
    await sleep(intervalMs);
  }
}

export class PinFailed extends Error {
  constructor(cid, status) {
    super(`pin ${cid}: ${status}`);
    this.cid = cid;
    this.status = status;
  }
}

/** Resolve when the CID is pinned; throw PinFailed on `failed` or when `limitMs` passes. */
export async function waitForPin(cid, { limitMs, status = pinStatus, log = console.log, ...pollOptions }) {
  let last;
  const done = await poll(async () => {
    const s = await status(cid);
    if (s !== last) log(`pin ${cid}: ${s}`);
    last = s;
    if (s === 'failed') throw new PinFailed(cid, 'failed');
    return s === 'pinned';
  }, { limitMs, ...pollOptions });
  if (!done) throw new PinFailed(cid, `still ${last} after ${Math.round(limitMs / 60_000)} min`);
}
