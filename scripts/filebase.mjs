// Filebase access for the publish workflow: one place for the token, the Kubo RPC, and the
// poll loop.
import { request } from 'node:https';
import { sleep as wait, timeoutSignal } from './lib.mjs';
import { filebaseS3 } from './s3.mjs';

const RPC = process.env.FILEBASE_RPC ?? 'https://rpc.filebase.io';

/** Kubo RPC bearer token: base64 of ACCESS:SECRET:BUCKET. Never log it. */
export function token(env = process.env) {
  const { FILEBASE_ACCESS_KEY: access, FILEBASE_SECRET_KEY: secret, FILEBASE_BUCKET: bucket = 'elephant-atlas' } = env;
  if (!access || !secret) throw new Error('FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY are required');
  return Buffer.from(`${access}:${secret}:${bucket}`).toString('base64');
}

/**
 * POST /api/v0/<path>; returns the response's JSON objects (Kubo streams one per line).
 * node:https, not fetch: fetch's dispatcher gives up on any response whose headers take more than
 * 5 minutes, whatever the abort signal says, and a loaded Filebase can take longer than that to
 * answer a dag/import. Here `timeoutMs` is the only limit, and `signal` aborts the call early.
 */
export async function rpc(path, { body, timeoutMs = 60_000, signal, bucket } = {}) {
  const headers = { authorization: `Bearer ${token(bucket ? { ...process.env, FILEBASE_BUCKET: bucket } : process.env)}` };
  let payload;
  if (body) {
    const encoded = new Response(body);
    headers['content-type'] = encoded.headers.get('content-type') ?? 'application/octet-stream';
    payload = Buffer.from(await encoded.arrayBuffer());
    headers['content-length'] = payload.length;
  } else headers['content-length'] = 0;
  const { status, text } = await new Promise((resolve, reject) => {
    const req = request(`${RPC}/api/v0/${path}`, { method: 'POST', headers, signal: timeoutSignal(timeoutMs, signal) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
  if (status < 200 || status >= 300) throw new Error(`${path.split('?')[0]}: HTTP ${status} ${text.slice(0, 200)}`);
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Other buckets of the same Filebase account (same keys) whose recursive pins count as published,
 * besides FILEBASE_BUCKET: ATLAS_PINNED_BUCKETS, comma-separated, e.g. the bucket Oracle uploads an
 * archive to before its pull request, or `*` for every bucket of the account (listed once per
 * process; a listing that fails counts as none, so the root is copied as before). A root pinned
 * there is not copied into the registry's bucket. An array, or a promise of one for `*`.
 */
let listing;
export function pinnedBuckets(env = process.env, list = () => filebaseS3(env).listBuckets()) {
  const named = (env.ATLAS_PINNED_BUCKETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!named.includes('*')) return named;
  const own = env.FILEBASE_BUCKET || 'elephant-atlas';
  listing ??= Promise.resolve()
    .then(list)
    .catch((e) => {
      console.log(`ListBuckets: ${e.message}; only ${own} is asked for pins`);
      listing = undefined;
      return [];
    });
  return listing.then((all) => all.filter((b) => b !== own));
}

/** pin/ls of `cid` in one bucket (undefined: the call's own bucket): { pinned: true } or { pinned: false, why }. */
async function listed(cid, call, bucket) {
  try {
    const [ls] = await call(`pin/ls?arg=${cid}&type=recursive`, bucket ? { bucket } : undefined);
    return ls?.Keys?.[cid] ? { pinned: true } : { pinned: false, why: 'not listed' };
  } catch (e) {
    // Kubo's answer for a root that is not pinned is an error saying so; anything else is a failed call.
    return { pinned: false, why: /not pinned/i.test(e.message) ? 'not listed' : e.message };
  }
}

/**
 * Whether Filebase lists `cid` as recursively pinned in the bucket, or in one of `buckets` (see
 * pinnedBuckets), which it does only once the whole DAG is there: { pinned: true }, or
 * { pinned: false, why } where `why` is 'not listed' or the error of a call that failed (the
 * registry's own bucket's). A node answers a root it does not pin with an error; the
 * "is not pinned" one reads as 'not listed', but how Filebase words it is not pinned down, so a
 * caller must not take any other `why` as proof that Filebase is unreachable. Asked up
 * to `tries` times, `waitMs` apart: a pin can take a moment to show after an import.
 */
export async function pinStatus(cid, { call = rpc, tries = 1, waitMs = 10_000, sleep = wait, buckets = pinnedBuckets() } = {}) {
  let why;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await sleep(waitMs);
    const own = await listed(cid, call);
    if (own.pinned) return own;
    why = own.why;
    const others = await buckets;
    const answers = await Promise.all(others.map((bucket) => listed(cid, call, bucket)));
    const at = answers.findIndex((a) => a.pinned);
    if (at >= 0) return { pinned: true, bucket: others[at] };
  }
  return { pinned: false, why };
}

/**
 * Call `check` until it returns a truthy value or `limitMs` passes. `check` may throw to abort.
 * `sleep` and `now` are injectable for tests.
 */
export async function poll(check, { limitMs, intervalMs = 30_000, sleep = wait, now = Date.now } = {}) {
  const started = now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (now() - started >= limitMs) return undefined;
    await sleep(intervalMs);
  }
}
