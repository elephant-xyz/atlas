// Public IPFS gateways, tried in order for every fetch. The gateway is untrusted: callers hash
// every block they keep. Content is "not available" only when every gateway fails.
export const DEFAULT_GATEWAYS = ['https://ipfs.filebase.io', 'https://ipfs.io', 'https://dweb.link', 'https://w3s.link'];

/** Origins from ATLAS_GATEWAYS (comma-separated), else the defaults. */
export function gatewayList(env = process.env) {
  return (env.ATLAS_GATEWAYS ?? DEFAULT_GATEWAYS.join(','))
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * GET `/ipfs/<path>` from each gateway in order; resolve with { res, url } of the first 2xx.
 * A gateway that fails (non-2xx, timeout, network error) moves to the next; when all fail,
 * throw an Error whose message lists every attempt.
 */
export async function fetchFromAny(path, { gateways = gatewayList(), fetch = globalThis.fetch, headers = {}, requestMs = 30_000 } = {}) {
  const failures = [];
  for (const gateway of gateways) {
    const url = `${gateway}/ipfs/${path}`;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(requestMs) });
      if (res.ok) return { res, url };
      failures.push(`${url}: HTTP ${res.status}`);
    } catch (e) {
      failures.push(`${url}: ${e.name === 'TimeoutError' ? `timeout after ${requestMs / 1000}s` : e.message}`);
    }
  }
  throw new Error(failures.join('; '));
}

/**
 * A gateway client with one deadline for a whole job. `get(path)` tries the gateways in order,
 * the one that answered last first; a 429 puts that gateway on cooldown (Retry-After, else
 * 30 s) and is not counted as an attempt; any other failure moves to the next gateway; the
 * whole list is retried with backoff until the deadline, then an Error lists the last failures.
 */
export function gatewayClient({ gateways = gatewayList(), fetch = globalThis.fetch, deadlineMs = 20 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} } = {}) {
  const started = now();
  const cooldown = new Map(); // gateway -> time it may be tried again
  let preferred;
  return {
    get preferred() {
      return preferred;
    },
    async get(path, { headers = {}, requestMs = 30_000 } = {}) {
      let wait = 2_000;
      for (;;) {
        const failures = [];
        const order = preferred ? [preferred, ...gateways.filter((g) => g !== preferred)] : gateways;
        for (const gateway of order) {
          if ((cooldown.get(gateway) ?? 0) > now()) continue;
          const url = `${gateway}/ipfs/${path}`;
          try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(requestMs) });
            if (res.ok) {
              preferred = gateway;
              return { res, url };
            }
            if (res.status === 429) {
              const retry = Number(res.headers.get('retry-after')) || 30;
              cooldown.set(gateway, now() + retry * 1_000);
              log(`${url}: HTTP 429, backing off ${retry}s`);
              continue;
            }
            failures.push(`${url}: HTTP ${res.status}`);
          } catch (e) {
            failures.push(`${url}: ${e.name === 'TimeoutError' ? `timeout after ${requestMs / 1000}s` : e.message}`);
          }
        }
        const cooling = gateways.map((g) => cooldown.get(g) ?? 0).filter((t) => t > now());
        const pause = failures.length ? wait : Math.max(1_000, Math.min(...cooling) - now());
        const remaining = deadlineMs - (now() - started);
        if (pause >= remaining) throw new Error(`/ipfs/${path} not available from any gateway within ${deadlineMs / 60_000} min: ${failures.join('; ') || 'every gateway is rate limiting'}`);
        if (failures.length) log(`/ipfs/${path}: ${failures.join('; ')}; retrying in ${pause / 1000}s`);
        await sleep(pause);
        wait = Math.min(wait * 2, 60_000);
      }
    },
  };
}
