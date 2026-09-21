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
