// A minimal S3 client for Filebase's S3 endpoint: SigV4, path-style URLs, HeadObject, PutObject
// and multipart upload, on node:http(s) with no SDK. It exists for one job: uploading a CAR with
// the object metadata `import=car`, which makes Filebase import the CAR and pin its root (see
// importCarViaS3 in transfer-roots.mjs). The AWS SDK would do, but it is a large dependency for
// four calls, and node:https lets a request wait as long as Filebase takes to answer (fetch's
// dispatcher gives up on response headers after 5 minutes; Filebase can take longer to answer the
// request that completes an import).
import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { open, stat } from 'node:fs/promises';
import { pool, sleep as wait, timeoutSignal } from './lib.mjs';

export const DEFAULT_ENDPOINT = 'https://s3.filebase.com';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MiB = 1024 * 1024;

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it. */
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** An object key in a URL path: each segment encoded, `/` kept. */
const encodeKey = (key) => key.split('/').map(encode).join('/');

/**
 * Sign a request with AWS Signature Version 4 (service s3). `headers` must not hold
 * authorization; host, x-amz-date and x-amz-content-sha256 are added. Returns the headers to send.
 */
export function signV4({ method, url, headers = {}, payloadHash = EMPTY_SHA256, accessKey, secretKey, region = 'us-east-1', date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = u.pathname.split('/').map((seg) => encode(decodeURIComponent(seg))).join('/');
  const canonical = [method, path, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export class S3Error extends Error {
  constructor(op, status, body) {
    const code = /<Code>([^<]+)<\/Code>/.exec(body ?? '')?.[1];
    super(`S3 ${op}: HTTP ${status}${code ? ` ${code}` : ''} ${String(body ?? '').replace(/\s+/g, ' ').slice(0, 200)}`.trim());
    this.status = status;
    this.code = code;
  }
}

/**
 * A client for one endpoint and key pair. Every call takes `timeoutMs` (its only time limit) and
 * an optional `signal`. `log` reports multipart progress.
 */
export function s3Client({ endpoint = DEFAULT_ENDPOINT, region = 'us-east-1', accessKey, secretKey, sleep = wait, log = () => {} } = {}) {
  if (!accessKey || !secretKey) throw new Error('S3 access key and secret are required');
  const base = endpoint.replace(/\/+$/, '');
  const objectUrl = (bucket, key, query = '') => `${base}/${bucket}/${encodeKey(key)}${query ? `?${query}` : ''}`;

  function send(op, method, url, { headers = {}, body, timeoutMs = 15 * 60_000, signal } = {}) {
    const payload = body ?? Buffer.alloc(0);
    const signed = signV4({ method, url, headers: { ...headers, 'content-length': payload.length }, payloadHash: sha256hex(payload), accessKey, secretKey, region });
    const request = url.startsWith('https:') ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers: signed, signal: timeoutSignal(timeoutMs, signal) }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) reject(new S3Error(op, res.statusCode, text));
          else resolve({ status: res.statusCode, headers: res.headers, text });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  /** Retry a call that failed on the network or with a 5xx/429, with backoff; 4xx other than 429 is final. */
  async function retried(what, call, tries = 5) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        const final = e instanceof S3Error && e.status < 500 && e.status !== 429;
        if (final || attempt >= tries || e.name === 'AbortError') throw e;
        log(`${what} attempt ${attempt}: ${e.message}`);
        await sleep(5_000 * 2 ** (attempt - 1));
      }
    }
  }

  const metaHeaders = (metadata = {}) => Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k.toLowerCase()}`, String(v)]));

  return {
    /** { size, metadata } of an object (metadata keys lower-cased), or undefined when there is none. */
    async headObject(bucket, key, { timeoutMs = 60_000, signal } = {}) {
      try {
        const { headers } = await retried(`HEAD ${key}`, () => send('HeadObject', 'HEAD', objectUrl(bucket, key), { timeoutMs, signal }));
        const metadata = Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('x-amz-meta-')).map(([k, v]) => [k.slice(11), v]));
        return { size: Number(headers['content-length']), metadata };
      } catch (e) {
        if (e instanceof S3Error && e.status === 404) return undefined;
        throw e;
      }
    },

    /**
     * Upload the file at `file` to bucket/key with `metadata` (x-amz-meta-*): one PUT up to
     * `partBytes`, a multipart upload past it (parts of `partBytes`, grown so there are at most
     * 10,000; `parallel` at a time; each retried). Only the request that ends the upload (the PUT,
     * or CompleteMultipartUpload) gets `completeTimeoutMs`: that is the one Filebase answers only
     * after it has read an imported CAR. An error of that request has `phase: 'complete'`.
     */
    async uploadFile(bucket, key, file, { metadata = {}, contentType = 'application/vnd.ipld.car', partBytes = 64 * MiB, parallel = 4, completeTimeoutMs = 60 * 60_000, partTimeoutMs = 30 * 60_000, signal } = {}) {
      const { size } = await stat(file);
      const headers = { 'content-type': contentType, ...metaHeaders(metadata) };
      const handle = await open(file, 'r');
      const read = async (offset, length) => {
        const buf = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(buf, got, length - got, offset + got);
          if (!bytesRead) throw new Error(`${file} ended at ${offset + got} bytes, expected ${size}`);
          got += bytesRead;
        }
        return buf;
      };
      const ending = (e) => Object.assign(e, { phase: 'complete' });
      try {
        if (size <= partBytes) {
          const body = await read(0, size);
          await send('PutObject', 'PUT', objectUrl(bucket, key), { headers, body, timeoutMs: completeTimeoutMs, signal }).catch((e) => Promise.reject(ending(e)));
          return { parts: 1, size };
        }
        const part = Math.max(partBytes, Math.ceil(size / 10_000)); // S3 allows 10,000 parts
        const count = Math.ceil(size / part);
        const created = await retried(`CreateMultipartUpload ${key}`, () => send('CreateMultipartUpload', 'POST', objectUrl(bucket, key, 'uploads='), { headers, timeoutMs: partTimeoutMs, signal }));
        const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created.text)?.[1];
        if (!uploadId) throw new Error(`S3 CreateMultipartUpload ${key}: no UploadId in ${created.text.slice(0, 200)}`);
        const etags = new Array(count);
        let done = 0;
        try {
          await pool(
            Array.from({ length: count }, (_, i) => async (poolSignal) => {
              const offset = i * part;
              const body = await read(offset, Math.min(part, size - offset));
              const url = objectUrl(bucket, key, `partNumber=${i + 1}&uploadId=${encode(uploadId)}`);
              const res = await retried(`UploadPart ${i + 1}/${count} of ${key}`, () => send('UploadPart', 'PUT', url, { body, timeoutMs: partTimeoutMs, signal: signal ? AbortSignal.any([poolSignal, signal]) : poolSignal }));
              etags[i] = res.headers.etag;
              if (!etags[i]) throw new Error(`S3 UploadPart ${i + 1} of ${key}: no ETag`);
              done++;
              if (done === count || done % Math.max(1, Math.round(count / 20)) === 0) log(`uploaded ${done}/${count} part(s) of ${key}`);
            }),
            parallel,
          );
        } catch (e) {
          await send('AbortMultipartUpload', 'DELETE', objectUrl(bucket, key, `uploadId=${encode(uploadId)}`), { timeoutMs: 60_000 }).catch(() => {});
          throw e;
        }
        const xml = `<CompleteMultipartUpload>${etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
        const res = await send('CompleteMultipartUpload', 'POST', objectUrl(bucket, key, `uploadId=${encode(uploadId)}`), { headers: { 'content-type': 'application/xml' }, body: Buffer.from(xml), timeoutMs: completeTimeoutMs, signal }).catch((e) => Promise.reject(ending(e)));
        // S3 may answer 200 with an error document once it has started streaming the response.
        if (/<Error>/.test(res.text)) throw ending(new S3Error('CompleteMultipartUpload', 200, res.text));
        return { parts: count, size };
      } finally {
        await handle.close();
      }
    },
  };
}

/** A client for Filebase from the workflow's environment (the same keys as the RPC token). */
export function filebaseS3(env = process.env, opts = {}) {
  return s3Client({
    endpoint: env.FILEBASE_S3_ENDPOINT || DEFAULT_ENDPOINT,
    region: env.FILEBASE_REGION || 'us-east-1',
    accessKey: env.FILEBASE_ACCESS_KEY,
    secretKey: env.FILEBASE_SECRET_KEY,
    ...opts,
  });
}
