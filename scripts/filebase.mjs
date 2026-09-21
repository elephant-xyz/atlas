// Filebase access for the publish workflow: one place for the token, the Kubo RPC, and the
// poll loop.
const RPC = process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io';

/** Kubo RPC bearer token: base64 of ACCESS:SECRET:BUCKET. Never log it. */
export function token(env = process.env) {
  const { FILEBASE_ACCESS_KEY: access, FILEBASE_SECRET_KEY: secret, FILEBASE_BUCKET: bucket = 'elephant-atlas' } = env;
  if (!access || !secret) throw new Error('FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY are required');
  return Buffer.from(`${access}:${secret}:${bucket}`).toString('base64');
}

/** POST /api/v0/<path>; returns the response's JSON objects (Kubo streams one per line). */
export async function rpc(path, { body, timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${RPC}/api/v0/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token()}` }, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
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
