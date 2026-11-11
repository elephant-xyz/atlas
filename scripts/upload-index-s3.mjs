#!/usr/bin/env node
// Copy the published index.json to S3 (ATLAS_INDEX_S3_URI, s3://<bucket>/<key>) for consumers
// that read it from a bucket instead of IPNS, such as Persist's registered IPFS indexes, which
// hold the object to the UnixFS CID of its exact bytes.
//   upload-index-s3 [file]   file defaults to ./index.json
// ATLAS_INDEX_CID is the CID publish-index added and pointed the IPNS name at. The file is
// uploaded only when its own CID (computed here, see unixfs.mjs) is that CID, so the object is
// byte for byte the published index; anything else (a later publication superseded this run, a
// hand-edited file) exits 1 without writing. The upload uses the aws CLI with whatever
// credentials the environment has (the workflow assumes a role through GitHub OIDC), sets
// Content-Type application/json, Cache-Control no-cache, Content-MD5 (S3 refuses a body that
// arrived damaged) and x-amz-meta-ipfs-cid. Idempotent: a re-run puts the same bytes again.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unixfsCid } from './unixfs.mjs';

/** { bucket, key } of an s3://<bucket>/<key> URI; throws on anything else. */
export function parseS3Uri(uri) {
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/.exec(String(uri ?? '').trim());
  if (!m || m[2].endsWith('/')) throw new Error(`ATLAS_INDEX_S3_URI must be s3://<bucket>/<key>, got ${JSON.stringify(uri ?? '')}`);
  return { bucket: m[1], key: m[2] };
}

/** The `aws s3api put-object` arguments for these bytes, after checking they are the published CID. */
export function putObjectArgs({ bytes, file, uri, expectedCid }) {
  if (!expectedCid) throw new Error('ATLAS_INDEX_CID (the published index CID) is required');
  const { bucket, key } = parseS3Uri(uri);
  const cid = unixfsCid(bytes);
  if (cid !== expectedCid) {
    throw new Error(`${file} is ${cid}, not the published index ${expectedCid}; not uploading. A later publication may have superseded this run: re-run the latest publish run instead.`);
  }
  return [
    's3api', 'put-object',
    '--bucket', bucket,
    '--key', key,
    '--body', file,
    '--content-type', 'application/json',
    '--cache-control', 'no-cache',
    '--content-md5', createHash('md5').update(bytes).digest('base64'),
    '--metadata', `ipfs-cid=${cid}`,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? 'index.json';
  const uri = process.env.ATLAS_INDEX_S3_URI;
  const expectedCid = process.env.ATLAS_INDEX_CID;
  const bytes = readFileSync(file);
  const args = putObjectArgs({ bytes, file, uri, expectedCid });
  console.log(`${file}: ${bytes.length} bytes, cid ${expectedCid}`);
  execFileSync(process.env.AWS_CLI ?? 'aws', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const summary = `Uploaded index.json ${expectedCid} to ${uri}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
