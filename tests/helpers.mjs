import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CID_A = 'baguqeerakenv6uzkrga4lx6jntgqe4ftdrqjgqiigm4h5gedrqopujfa6sda'; // smoke CountyIndex
export const CID_B = 'baguqeerasxkelzdxtkgdrii54zoanz3t7qznf72niikqmiyer4dlb2k2xfhq'; // smoke CountyTables
export const CID_C = 'baguqeerad32anku3fwoiex7gw4se6kybbujphmxmea3g2ztnytaatdpb43aq'; // smoke shard 0
export const CID_D = 'baguqeeraek5eh2ihcujvsmbv5i6jwmkqvvc3z46qegpyo7mdgm4w2j2z4qda'; // a data-group root
export const SCHEMA = 'bafkreia6tjziby3upxmidymud5iusd32urrztslgrudkwysc7ydmxoekuq'; // County data-group schema

export const group = (overrides = {}) => ({ cid: CID_A, schema: SCHEMA, tables: CID_B, ...overrides });

export function page(overrides = {}) {
  return { county: 'lee', state: 'FL', fips: '12071', groups: { county: group() }, ...overrides };
}

/** publishedAt stub for buildEntries: cid -> timestamp map. */
export const stamps = (map = {}) => (_path, cid) => map[cid];

/** Write a registry into a temp dir: files is { 'counties/FL/lee.json': obj, 'index.json': obj }. */
export function registry(files) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-'));
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  }
  return root;
}

// ---- IPLD fixtures for the gateway/transfer/verify tests
import { CarWriter } from '@ipld/car';
import * as dagJson from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

/** { cid, bytes } for a value encoded with `codec` (dag-json by default). */
export const block = async (value, codec = dagJson) => {
  const bytes = codec.encode(value);
  return { cid: CID.create(1, codec.code, await sha256.digest(bytes)), bytes };
};

/** CAR bytes with one root and the given blocks. */
export const car = async (root, blocks) => {
  const { writer, out } = CarWriter.create([root]);
  const chunks = [];
  const collected = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of blocks) await writer.put(b);
  await writer.close();
  await collected;
  return Buffer.concat(chunks);
};

// ---- a fake Filebase S3 endpoint for the S3 import tests
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { CarReader } from '@ipld/car';

/**
 * A local S3 endpoint that behaves like Filebase's for what the transfer uses: HeadObject,
 * PutObject, multipart upload (create, parts, complete, abort), path-style. Every request must
 * carry a SigV4 Authorization for `accessKey` whose x-amz-content-sha256 is the body's hash, and
 * whose signature `secretKey` reproduces. An object stored with metadata import=car is read as a
 * CAR and its root pinned, unless `pins(root, blocks, key)` says otherwise ('pending': Pinning-Status
 * pinning and never pinned; anything else: failed). `respond(req)` may return { status, body, after } to answer a
 * request instead (`after: true` stores the object first, like a proxy timing out on a request
 * the server finished; `hold: true` never answers it). Resolves { url, objects, pinned, requests, close() }.
 */
export async function fakeS3({ accessKey = 'AK', secretKey = 'SK', pins = () => 'pinned', respond = () => undefined } = {}) {
  const objects = new Map(); // `${bucket}/${key}` -> { body, metadata }
  const uploads = new Map(); // uploadId -> { key, metadata, parts: [] }
  const pinned = new Set();
  const requests = [];
  let nextId = 1;
  const { signV4 } = await import('../scripts/s3.mjs');
  const store = async (k, body, metadata) => {
    const meta = { ...metadata };
    if (meta.import === 'car') {
      const reader = await CarReader.fromBytes(body).catch(() => undefined);
      if (!reader) {
        objects.set(k, { body, metadata: { ...meta, 'pinning-status': 'failed' } }); // not a CAR
        return;
      }
      const [root] = await reader.getRoots();
      const blocks = new Set();
      for await (const b of reader.blocks()) blocks.add(b.cid.toString());
      meta.cid = root.toString();
      const verdict = pins(root.toString(), blocks, k.split('/').slice(1).join('/'));
      meta['pinning-status'] = { pinned: 'pinned', pending: 'pinning' }[verdict] ?? 'failed';
      if (verdict === 'pinned') pinned.add(root.toString());
    }
    objects.set(k, { body, metadata: meta });
  };
  const server = createServer((req, res) => handle(req, res).catch((e) => (res.headersSent ? res.destroy() : (res.writeHead(500), res.end(String(e.message))))));
  const handle = async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const k = `${bucket}/${key}`;
    const op = req.method === 'HEAD' ? 'HeadObject' : req.method === 'DELETE' ? 'AbortMultipartUpload' : u.searchParams.has('uploads') ? 'CreateMultipartUpload' : u.searchParams.has('partNumber') ? 'UploadPart' : u.searchParams.has('uploadId') ? 'CompleteMultipartUpload' : 'PutObject';
    const metadata = Object.fromEntries(Object.entries(req.headers).filter(([h]) => h.startsWith('x-amz-meta-')).map(([h, v]) => [h.slice(11), v]));
    requests.push({ op, key, metadata, bytes: body.length, query: u.search });
    const send = (status, text = '', headers = {}) => (res.writeHead(status, headers), res.end(req.method === 'HEAD' ? undefined : text));
    // SigV4: the credential is ours, the payload hash is the body's, and the signature is reproducible.
    const auth = req.headers.authorization ?? '';
    const hash = createHash('sha256').update(body).digest('hex');
    const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? [];
    const date = req.headers['x-amz-date'] ?? '';
    const again = signV4({
      method: req.method,
      url: `http://${req.headers.host}${req.url}`,
      headers: Object.fromEntries(signed.filter((h) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(h)).map((h) => [h, req.headers[h]])),
      payloadHash: hash,
      accessKey,
      secretKey,
      date: new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`),
    });
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKey}/`) || req.headers['x-amz-content-sha256'] !== hash || again.authorization !== auth) return send(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
    const override = respond({ op, key, query: u.search });
    if (override?.hold) return; // never answered: the client's own timeout or signal ends it
    if (override && !override.after) return send(override.status, override.body ?? '');
    if (op === 'HeadObject') {
      const o = objects.get(k);
      if (!o) return send(404);
      return send(200, '', { 'content-length': o.body.length, ...Object.fromEntries(Object.entries(o.metadata).map(([m, v]) => [`x-amz-meta-${m}`, v])) });
    }
    if (op === 'PutObject') await store(k, body, metadata);
    else if (op === 'CreateMultipartUpload') {
      const id = `up${nextId++}`;
      uploads.set(id, { key: k, metadata, parts: [] });
      return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    } else if (op === 'UploadPart') {
      const up = uploads.get(u.searchParams.get('uploadId'));
      if (!up) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      up.parts[Number(u.searchParams.get('partNumber')) - 1] = body;
      return send(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
    } else if (op === 'CompleteMultipartUpload') {
      const up = uploads.get(u.searchParams.get('uploadId'));
      if (!up) return send(404, '<Error><Code>NoSuchUpload</Code></Error>');
      const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)];
      if (listed.length !== up.parts.length || listed.some(([, n, etag], i) => Number(n) !== i + 1 || etag !== `"${createHash('md5').update(up.parts[i]).digest('hex')}"`)) return send(400, '<Error><Code>InvalidPart</Code></Error>');
      uploads.delete(u.searchParams.get('uploadId'));
      await store(up.key, Buffer.concat(up.parts), up.metadata);
    } else if (op === 'AbortMultipartUpload') uploads.delete(u.searchParams.get('uploadId'));
    if (override) return send(override.status, override.body ?? '');
    send(200, op === 'CompleteMultipartUpload' ? '<CompleteMultipartUploadResult></CompleteMultipartUploadResult>' : '');
  };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, objects, pinned, requests, uploads, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}
