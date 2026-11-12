import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { parseS3Uri, putObjectArgs } from '../scripts/upload-index-s3.mjs';
import { CHUNK_BYTES, LINKS_PER_NODE, unixfsCid } from '../scripts/unixfs.mjs';

// Larger-than-one-chunk vectors from `ipfs-only-hash` 4.0.0 { cidVersion: 1, rawLeaves: true },
// the same ones Persist pins for its own copy of this computation.
const generated = (n) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = i % 251;
  return bytes;
};

test('unixfsCid is the raw block CID while the file fits one chunk, a dag-pb root past it', async () => {
  const one = generated(CHUNK_BYTES);
  assert.equal(unixfsCid(one), CID.createV1(raw.code, await sha256.digest(one)).toString());
  assert.match(unixfsCid(generated(CHUNK_BYTES + 1)), /^bafybei/);
});

test('unixfsCid builds one dag-pb node over a full node of chunks, without an empty trailing chunk', () => {
  assert.equal(unixfsCid(generated(LINKS_PER_NODE * CHUNK_BYTES)), 'bafybeihpe5snhzneq7xs53nivmsopto5lrogo3wjynauqylqeym5a3irbm');
});

test('unixfsCid builds a second level of nodes past 174 chunks', () => {
  const bytes = new Uint8Array(460 * 100_000);
  for (let p = 0; p < 460; p++) bytes.fill(p % 256, p * 100_000, (p + 1) * 100_000);
  assert.equal(unixfsCid(bytes), 'bafybeiaq4mx5lz7bnshwwuntisfwoaoexwbikpqvbqbkidbqeud43zjtda');
});

test('parseS3Uri takes s3://<bucket>/<key> and refuses anything else', () => {
  assert.deepEqual(parseS3Uri('s3://persist-indexes/atlas/index.json'), { bucket: 'persist-indexes', key: 'atlas/index.json' });
  for (const bad of [undefined, '', 's3://bucket', 's3://bucket/', 's3://bucket/dir/', 'https://bucket.s3.amazonaws.com/index.json', 's3://Bad_Bucket/index.json']) {
    assert.throws(() => parseS3Uri(bad), /s3:\/\/<bucket>\/<key>/, String(bad));
  }
});

test('putObjectArgs uploads the file only when it is the published CID, as JSON, uncached, with its MD5 and CID', () => {
  const bytes = Buffer.from('{"version":1}\n');
  const cid = unixfsCid(bytes);
  assert.deepEqual(putObjectArgs({ bytes, file: 'index.json', uri: 's3://b-1/atlas/index.json', expectedCid: cid }), [
    's3api', 'put-object',
    '--bucket', 'b-1',
    '--key', 'atlas/index.json',
    '--body', 'index.json',
    '--content-type', 'application/json',
    '--cache-control', 'no-cache',
    '--content-md5', createHash('md5').update(bytes).digest('base64'),
    '--metadata', `ipfs-cid=${cid}`,
  ]);
});

test('putObjectArgs refuses bytes that are not the published index, and a missing CID', () => {
  const bytes = Buffer.from('{"version":1}\n');
  const other = unixfsCid(Buffer.from('{"version":1} \n'));
  assert.throws(() => putObjectArgs({ bytes, file: 'index.json', uri: 's3://b-1/index.json', expectedCid: other }), /not the published index/);
  assert.throws(() => putObjectArgs({ bytes, file: 'index.json', uri: 's3://b-1/index.json', expectedCid: '' }), /ATLAS_INDEX_CID/);
});
