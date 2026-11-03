// Optional fast path for large archives: the archive's CAR file stored as one plain object,
// `<archive root cid>.car`, in a Filebase bucket (ATLAS_CAR_BUCKETS, comma-separated; default
// elephant-atlas-cars), read over the S3 API with the Filebase keys the workflows already hold.
//
// Gateways export an archive by walking it block by block, which is slow for archives of
// millions of small blocks (measured on a 4 GB county: about 0.25 MB/s even with 32 parallel
// shard requests on a dedicated gateway); the same bytes as one object download at about
// 14 MB/s. The object is never trusted: callers check that the CAR's root is the page's cid and
// `elephant-cli validate` hashes every block, exactly as for a gateway download. No object (or
// no keys) means the caller falls back to the gateways.
import { spawn } from 'node:child_process';

const S3 = process.env.FILEBASE_S3 ?? 'https://s3.filebase.com';

export function mirrorBuckets(env = process.env) {
  return (env.ATLAS_CAR_BUCKETS ?? 'elephant-atlas-cars').split(',').map((s) => s.trim()).filter(Boolean);
}

/** curl with its configuration on stdin, so the keys never appear in the process list. Resolves the HTTP status (0 on a transport error). */
export function curlS3(config, run = spawn) {
  return new Promise((resolve) => {
    const child = run('curl', ['-K', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number(out.trim()) || 0));
    child.stdin.end(config);
  });
}

/**
 * Download `<cid>.car` from the first mirror bucket that has it into `file`. Resolves
 * `{ url }` (an s3:// locator for logs) or undefined when no bucket has it or no keys are set.
 */
export async function fetchMirrorCar(cid, file, { env = process.env, curl = curlS3, log = () => {} } = {}) {
  const access = env.FILEBASE_ACCESS_KEY;
  const secret = env.FILEBASE_SECRET_KEY;
  if (!access || !secret) return undefined;
  for (const bucket of mirrorBuckets(env)) {
    const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
    const config = [
      `url = ${q(`${S3}/${bucket}/${cid}.car`)}`,
      `user = ${q(`${access}:${secret}`)}`,
      'aws-sigv4 = "aws:amz:us-east-1:s3"',
      `output = ${q(file)}`,
      'write-out = "%{http_code}"',
      'silent',
      'max-time = 3600',
    ].join('\n');
    const status = await curl(config);
    if (status === 200) return { url: `s3://${bucket}/${cid}.car` };
    if (status !== 404) log(`s3://${bucket}/${cid}.car: HTTP ${status || 'transport error'}`);
  }
  return undefined;
}
