import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { S3Error, filebaseS3, s3Client, signV4 } from '../scripts/s3.mjs';
import { fakeS3 } from './helpers.mjs';

const fast = () => new Promise((r) => setTimeout(r, 1));
const tempFile = async (bytes) => {
  const file = join(await mkdtemp(join(tmpdir(), 's3-test-')), 'x.bin');
  writeFileSync(file, bytes);
  return file;
};

test('signV4 reproduces the AWS documentation example (GET with a range, us-east-1)', () => {
  const h = signV4({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9' },
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    h.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('a file past the part size goes up as a multipart upload with its metadata on the create, parts in order', async () => {
  const s3 = await fakeS3();
  try {
    const bytes = Buffer.alloc(250_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 253;
    const file = await tempFile(bytes);
    const logs = [];
    const client = s3Client({ endpoint: s3.url, accessKey: 'AK', secretKey: 'SK', sleep: fast, log: (m) => logs.push(m) });
    const out = await client.uploadFile('elephant-atlas', 'import/FL-lee county.car', file, { metadata: { import: 'car', 'atlas-root': 'bafyroot' }, partBytes: 100_000, parallel: 2 });
    assert.deepEqual(out, { parts: 3, size: 250_000 });
    assert.deepEqual(s3.requests.map((r) => r.op), ['CreateMultipartUpload', 'UploadPart', 'UploadPart', 'UploadPart', 'CompleteMultipartUpload']);
    assert.deepEqual(s3.requests[0].metadata, { import: 'car', 'atlas-root': 'bafyroot' });
    assert.deepEqual(s3.objects.get('elephant-atlas/import/FL-lee county.car').body, bytes);
    assert.match(logs.at(-1), /uploaded 3\/3 part\(s\)/);
    assert.deepEqual(await client.headObject('elephant-atlas', 'import/FL-lee county.car'), { size: 250_000, metadata: { import: 'car', 'atlas-root': 'bafyroot', 'pinning-status': 'failed' } }, 'not a CAR: the fake fails its import, like Filebase');
    assert.equal(await client.headObject('elephant-atlas', 'import/none.car'), undefined, 'no object is undefined, not an error');
  } finally {
    await s3.close();
  }
});

test('a small file is one PUT; a 5xx part is retried, a 4xx is final, and a failed multipart upload is aborted', async () => {
  let failPart = 1;
  const s3 = await fakeS3({ respond: ({ op }) => (op === 'UploadPart' && failPart-- > 0 ? { status: 500, body: '<Error><Code>InternalError</Code></Error>' } : undefined) });
  try {
    const client = s3Client({ endpoint: s3.url, accessKey: 'AK', secretKey: 'SK', sleep: fast });
    const small = await tempFile(Buffer.from('tiny'));
    assert.deepEqual(await client.uploadFile('b', 'k1', small, { metadata: { import: 'car' }, partBytes: 100 }), { parts: 1, size: 4 }, 'PUT');
    assert.equal(s3.requests.at(-1).op, 'PutObject');
    assert.deepEqual(s3.requests.at(-1).metadata, { import: 'car' });
    const big = await tempFile(Buffer.alloc(250, 1));
    await client.uploadFile('b', 'k2', big, { partBytes: 100, parallel: 1 });
    assert.equal(s3.requests.filter((r) => r.op === 'UploadPart').length, 4, 'one part sent twice');
    assert.deepEqual(readFileSync(big), s3.objects.get('b/k2').body);
    const bad = s3Client({ endpoint: s3.url, accessKey: 'AK', secretKey: 'wrong', sleep: fast });
    await assert.rejects(bad.uploadFile('b', 'k3', big, { partBytes: 100 }), (e) => e instanceof S3Error && e.status === 403 && e.code === 'SignatureDoesNotMatch');
    assert.equal(s3.requests.filter((r) => r.op === 'CreateMultipartUpload').length, 2, 'a 403 is not retried');
  } finally {
    await s3.close();
  }
  failPart = 99;
  const s3b = await fakeS3({ respond: ({ op }) => (op === 'UploadPart' ? { status: 503 } : undefined) });
  try {
    const client = s3Client({ endpoint: s3b.url, accessKey: 'AK', secretKey: 'SK', sleep: fast });
    await assert.rejects(client.uploadFile('b', 'k', await tempFile(Buffer.alloc(250, 2)), { partBytes: 100, parallel: 1 }), /HTTP 503/);
    assert.equal(s3b.requests.at(-1).op, 'AbortMultipartUpload');
    assert.equal(s3b.uploads.size, 0);
  } finally {
    await s3b.close();
  }
});

test('the request that ends an upload is marked, so a caller can tell a dropped completion from a failed part', async () => {
  const s3 = await fakeS3({ respond: ({ op }) => (op === 'CompleteMultipartUpload' ? { status: 504, after: true } : undefined) });
  try {
    const client = s3Client({ endpoint: s3.url, accessKey: 'AK', secretKey: 'SK', sleep: fast });
    await assert.rejects(client.uploadFile('b', 'k', await tempFile(Buffer.alloc(250, 3)), { partBytes: 100 }), (e) => e.phase === 'complete' && /HTTP 504/.test(e.message));
    assert.ok(s3.objects.has('b/k'), 'the server finished it');
  } finally {
    await s3.close();
  }
});

test('filebaseS3 takes the workflow\'s Filebase keys and s3.filebase.com unless told otherwise', () => {
  assert.throws(() => filebaseS3({}), /access key and secret are required/);
  assert.ok(filebaseS3({ FILEBASE_ACCESS_KEY: 'a', FILEBASE_SECRET_KEY: 'b' }).uploadFile);
});
