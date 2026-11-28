import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as dagJson from '@ipld/dag-json';
import { CID } from 'multiformats/cid';
import { gatewayClient } from '../scripts/gateways.mjs';
import { CHUNK_BYTES, LINKS_PER_NODE, unixfsCid, unixfsHasher } from '../scripts/unixfs.mjs';
import { distinctParts, missingParts, partCidOfKey, partGateways, partKey, partsOfTableList, partsPrefix, putPartArgs, syncParts, tableListCids } from '../scripts/upload-parts-s3.mjs';
import { block } from './helpers.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PRIVATE = 'https://atlas-private.myfilebase.com';
const BUCKET = 'persist-ipfs-indexes-008402584743-us-east-2';
const PREFIX = 'persist-registered-ipfs-indexes/elephant_atlas/parts/';

// Denton TX as index bafkreicnyg3jxpfbtkwseyfjj3tysf4mve74oexcdlb3yzdhspb4kvtlly (2026-11-27)
// listed it; its two table lists are in fixtures/, byte for byte as IPFS serves them.
const DENTON = {
  county: 'denton', state: 'TX', fips: '48121',
  groups: {
    county: { cid: 'baguqeera3ic3u6fbh43lcz7apf2wartwizij7rasxenbedjq2fvazcss5hsq', schema: 'bafkreia6tjziby3upxmidymud5iusd32urrztslgrudkwysc7ydmxoekuq', tables: 'baguqeeraq6oimykgto72s7eo7tvyxzs2hsldwzxpelc6ykystwngixgxtovq', published_at: '2026-11-27T18:11:27.000Z' },
    property_improvement: { cid: 'baguqeeraxkggnbwqro4ac6czfqzmgfiquq47utnk6pply4ixgowkwcvnpzsa', schema: 'bafkreicyzywzwhmguojpi2otgrwsyi37le3u4lnavljbxu76cnrudxaxfu', tables: 'baguqeeraimzlermeyvypfpa7wzashvyhoaqzchlrlvtzt4jm5coa2af3edxq', published_at: '2026-11-27T18:11:27.000Z' },
  },
};
const dentonList = (cid) => readFileSync(join(FIXTURES, `${cid}.json`));

const bytesOf = (n, seed) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) % 251;
  return b;
};

/** A clock the fake sleep advances, so gateway cooldowns and backoffs pass at once. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

/**
 * A private gateway serving `blocks` (cid -> bytes, for ?format=raw) and `files` (cid -> bytes,
 * or a function of the attempt number returning the bytes to serve). Records every URL asked for.
 */
function gateway({ blocks = {}, files = {} }) {
  const urls = [];
  const tries = new Map();
  const fetch = async (url) => {
    urls.push(url);
    const path = url.slice(`${PRIVATE}/ipfs/`.length);
    if (path.endsWith('?format=raw')) {
      const b = blocks[path.slice(0, -'?format=raw'.length)];
      return b ? new Response(b) : new Response('not found', { status: 404 });
    }
    const n = (tries.get(path) ?? 0) + 1;
    tries.set(path, n);
    const f = files[path];
    const body = typeof f === 'function' ? f(n) : f;
    return body ? new Response(body) : new Response('not found', { status: 404 });
  };
  return { fetch, urls };
}

/** A part cache: list() and put() over a Map of key -> size, recording what put() was given. */
function bucket(initial = {}) {
  const objects = new Map(Object.entries(initial));
  const puts = [];
  return {
    objects,
    puts,
    list: async ({ bucket: b, prefix }) => {
      assert.equal(b, BUCKET);
      return new Map([...objects].filter(([k]) => k.startsWith(prefix)));
    },
    put: async ({ bucket: b, key, file, md5, cid }) => {
      assert.equal(b, BUCKET);
      const body = readFileSync(file);
      puts.push({ key, cid, md5, uploadedCid: unixfsCid(body), md5OfBody: createHash('md5').update(body).digest('base64') });
      objects.set(key, body.length);
    },
  };
}

function deps(gw, s3, extra = {}) {
  const c = clock();
  const tmp = mkdtempSync(join(tmpdir(), 'parts-test-'));
  return {
    tmp,
    d: {
      bucket: BUCKET,
      prefix: PREFIX,
      gateway: () => gatewayClient({ gateways: [PRIVATE], fetch: gw.fetch, deadlineMs: 10 * 60_000, sleep: c.sleep, now: c.now }),
      list: s3.list,
      put: s3.put,
      sleep: c.sleep,
      tmp,
      ...extra,
    },
  };
}

/** A synthetic index of one county whose table list declares `parts` ({ cid, bytes }). */
async function indexWith(parts) {
  const list = await block({ label: 'CountyTables', county_root: CID.parse(DENTON.groups.county.cid), part_size_bytes: 1 << 30, tables: { t: { rows: parts.length, parts: parts.map((p) => ({ cid: CID.parse(p.cid), bytes: p.bytes, rows: 1 })) } } });
  return { index: { version: 1, counties: [{ ...DENTON, groups: { county: { ...DENTON.groups.county, tables: list.cid.toString() } } }] }, blocks: { [list.cid.toString()]: list.bytes } };
}

test('the Denton incident: every part of its two table lists is read, and only the ones the cache lacks at their size are fetched', async () => {
  const cids = tableListCids({ counties: [DENTON] });
  assert.deepEqual(cids, [DENTON.groups.county.tables, DENTON.groups.property_improvement.tables]);
  const lists = cids.map((cid) => partsOfTableList(dagJson.decode(dentonList(cid)), cid));
  const parts = distinctParts(lists);
  assert.equal(parts.length, 32, '25 county tables and 7 property_improvement tables, one part each');
  assert.equal(Math.max(...parts.map((p) => p.bytes)), 144_262_779);

  // Persist's sync left it Incomplete: some parts cached, others not, one cut short.
  const cached = new Map(parts.slice(0, 24).map((p) => [p.cid, p.bytes]));
  cached.set(parts[24].cid, parts[24].bytes - 1);
  const missing = missingParts(parts, cached);
  assert.deepEqual(missing.map((p) => p.cid), parts.slice(24).map((p) => p.cid), 'the 7 never fetched and the one at the wrong size');

  // The copy reads the real table lists from the private gateway, hashed, and asks it, and only it,
  // for exactly those 8 parts; bytes that are not the part are never uploaded and the run fails.
  const gw = gateway({
    blocks: Object.fromEntries(cids.map((cid) => [cid, dentonList(cid)])),
    files: Object.fromEntries(missing.map((p) => [p.cid, bytesOf(p.bytes > 1_000_000 ? 1_000 : p.bytes, 1)])),
  });
  const s3 = bucket(Object.fromEntries([...cached].map(([cid, size]) => [partKey(PREFIX, cid), size])));
  const { d, tmp } = deps(gw, s3);
  const result = await syncParts({ version: 1, counties: [DENTON] }, d);
  assert.equal(result.parts, 32);
  assert.equal(result.present, 24);
  assert.equal(result.uploaded, 0);
  assert.deepEqual(result.failed.map((f) => f.cid).sort(), missing.map((p) => p.cid).sort());
  assert.deepEqual(s3.puts, []);
  assert.ok(gw.urls.every((u) => u.startsWith(`${PRIVATE}/ipfs/`)), 'no public gateway is asked');
  assert.deepEqual([...new Set(gw.urls.filter((u) => !u.includes('?')).map((u) => u.split('/ipfs/')[1]))].sort(), missing.map((p) => p.cid).sort());
  assert.deepEqual(readdirSync(tmp), [], 'temporary files removed');
  rmSync(tmp, { recursive: true, force: true });
});

test('missing parts are streamed, held to their CID and size, uploaded once, and a re-run sends nothing', async () => {
  const files = [bytesOf(10, 1), bytesOf(CHUNK_BYTES + 5, 2), bytesOf(2 * CHUNK_BYTES, 3), bytesOf(7_000, 4)];
  const parts = files.map((b) => ({ cid: unixfsCid(b), bytes: b.length }));
  const { index, blocks } = await indexWith(parts);
  let dropped = 0;
  const gw = gateway({
    blocks,
    files: {
      [parts[0].cid]: files[0],
      [parts[1].cid]: (n) => (n === 1 ? (dropped++, files[1].subarray(0, 1000)) : files[1]), // body cut short once
      [parts[2].cid]: files[2],
      [parts[3].cid]: files[3],
    },
  });
  // parts[0] already cached at its size; parts[3] cached at another size (an old, wrong object).
  const s3 = bucket({ [partKey(PREFIX, parts[0].cid)]: 10, [partKey(PREFIX, parts[3].cid)]: 6_999, 'persist-registered-ipfs-indexes/elephant_atlas/versions/x.json': 5 });
  const { d, tmp } = deps(gw, s3, { parallel: 2 });
  const result = await syncParts(index, d);
  assert.deepEqual(result, { parts: 4, present: 1, uploaded: 3, failed: [] });
  assert.equal(dropped, 1);
  assert.deepEqual(s3.puts.map((p) => p.key).sort(), [1, 2, 3].map((i) => partKey(PREFIX, parts[i].cid)).sort());
  for (const p of s3.puts) {
    assert.equal(p.uploadedCid, p.cid, 'the uploaded file is the part');
    assert.equal(p.md5, p.md5OfBody, 'Content-MD5 is of the uploaded bytes');
  }
  for (const p of parts) assert.equal(s3.objects.get(partKey(PREFIX, p.cid)), p.bytes, 'Persist now counts every part as present');
  assert.deepEqual(readdirSync(tmp), []);

  const again = await syncParts(index, d);
  assert.deepEqual(again, { parts: 4, present: 4, uploaded: 0, failed: [] });
  assert.equal(s3.puts.length, 3, 'nothing sent again');
  rmSync(tmp, { recursive: true, force: true });
});

test('a part whose bytes never match its CID fails the run without being uploaded; the others still go in', async () => {
  const good = bytesOf(5_000, 5);
  const bad = bytesOf(5_000, 6);
  const parts = [{ cid: unixfsCid(good), bytes: good.length }, { cid: unixfsCid(bad), bytes: bad.length }];
  const { index, blocks } = await indexWith(parts);
  const tampered = Buffer.from(bad);
  tampered[0] ^= 1;
  const gw = gateway({ blocks, files: { [parts[0].cid]: good, [parts[1].cid]: tampered } });
  const s3 = bucket();
  const { d, tmp } = deps(gw, s3);
  const result = await syncParts(index, d);
  assert.equal(result.uploaded, 1);
  assert.deepEqual(result.failed.map((f) => f.cid), [parts[1].cid]);
  assert.match(result.failed[0].reason, /the bytes are .* not /);
  assert.deepEqual(s3.puts.map((p) => p.cid), [parts[0].cid]);
  assert.equal(gw.urls.filter((u) => u.endsWith(parts[1].cid)).length, 5, 'retried DOWNLOAD_ATTEMPTS times');
  assert.ok(!existsSync(join(tmp, `${parts[1].cid}.parquet`)));
  rmSync(tmp, { recursive: true, force: true });
});

test('a body longer than declared is refused, and a table list that is not its CID stops the run', async () => {
  const b = bytesOf(3_000, 7);
  const parts = [{ cid: unixfsCid(b), bytes: b.length }];
  const { index, blocks } = await indexWith(parts);
  const long = gateway({ blocks, files: { [parts[0].cid]: Buffer.concat([b, Buffer.from('x')]) } });
  const { d, tmp } = deps(long, bucket());
  const result = await syncParts(index, d);
  assert.match(result.failed[0].reason, /runs past the declared 3000 bytes/);

  const [cid] = Object.keys(blocks);
  const forged = gateway({ blocks: { [cid]: Buffer.concat([blocks[cid], Buffer.from(' ')]) } });
  const second = deps(forged, bucket());
  await assert.rejects(syncParts(index, second.d), /do not hash to it/);
  for (const dir of [tmp, second.tmp]) rmSync(dir, { recursive: true, force: true });
});

test('a part two table lists declare with different sizes is refused, as Persist refuses it', () => {
  assert.throws(() => distinctParts([[{ cid: 'bafyA', bytes: 10 }], [{ cid: 'bafyA', bytes: 11 }]]), /declared as 10 and 11 bytes/);
  assert.deepEqual(distinctParts([[{ cid: 'bafyA', bytes: 10 }], [{ cid: 'bafyA', bytes: 10 }]]), [{ cid: 'bafyA', bytes: 10 }]);
});

test('unixfsHasher gives unixfsCid however the stream is cut', () => {
  for (const n of [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES, (LINKS_PER_NODE + 2) * CHUNK_BYTES + 17]) {
    const bytes = bytesOf(n, n % 13);
    for (const piece of [1 << 10, 65_536, CHUNK_BYTES, CHUNK_BYTES + 3, 1 << 20]) {
      const h = unixfsHasher();
      for (let at = 0; at < n; at += piece) h.update(bytes.subarray(at, at + piece));
      assert.equal(h.digest(), unixfsCid(bytes), `${n} bytes in pieces of ${piece}`);
      assert.equal(h.size, n);
    }
  }
});

test('parts come from the private gateway only, and the cache keys are Persist\'s', () => {
  assert.throws(() => partGateways({}), /ATLAS_GATEWAYS is not set/);
  assert.deepEqual(partGateways({ ATLAS_GATEWAYS: `${PRIVATE}/` }), [PRIVATE]);
  assert.equal(partsPrefix(PREFIX), PREFIX);
  for (const bad of [undefined, '', 'no-slash', '/leading/', 'a//b/']) assert.throws(() => partsPrefix(bad), /ATLAS_PARTS_S3_PREFIX/, String(bad));
  const cid = 'bafybeibxtqbabpz2f2v5jmrii4gc5qx5amgabkyz2jpsog2wb3g5iesoni';
  assert.equal(partKey(PREFIX, cid), `${PREFIX}${cid}.parquet`);
  assert.equal(partCidOfKey(PREFIX, partKey(PREFIX, cid)), cid);
  assert.equal(partCidOfKey(PREFIX, `${PREFIX}x/${cid}.parquet`), undefined);
  assert.equal(partCidOfKey(PREFIX, `${PREFIX}${cid}.json`), undefined);
  assert.deepEqual(putPartArgs({ bucket: BUCKET, key: partKey(PREFIX, cid), file: '/t/p', md5: 'bWQ1', cid }), [
    's3api', 'put-object', '--bucket', BUCKET, '--key', partKey(PREFIX, cid), '--body', '/t/p',
    '--content-type', 'application/vnd.apache.parquet', '--content-md5', 'bWQ1', '--metadata', `ipfs-cid=${cid}`,
  ]);
});

test('the index-s3 job copies the parts, with the private gateway, before it uploads index.json', () => {
  const yml = readFileSync(fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url)), 'utf8');
  const job = yml.slice(yml.indexOf('\n  index-s3:'));
  const parts = job.indexOf('run: node scripts/upload-parts-s3.mjs index.json');
  const index = job.indexOf('run: node scripts/upload-index-s3.mjs index.json');
  assert.ok(parts > 0 && index > parts, 'parts first, then index.json');
  const step = job.slice(job.lastIndexOf('- name:', parts), parts);
  assert.match(step, /if: \$\{\{ vars\.ATLAS_PERSIST_PARTS_PREFIX != '' \}\}/);
  assert.match(step, /ATLAS_GATEWAYS: \$\{\{ secrets\.ATLAS_GATEWAYS \}\}/);
  assert.match(step, /ATLAS_GATEWAY_TOKEN: \$\{\{ secrets\.ATLAS_GATEWAY_TOKEN \}\}/);
  assert.match(step, /ATLAS_PARTS_S3_PREFIX: \$\{\{ vars\.ATLAS_PERSIST_PARTS_PREFIX \}\}/);
  assert.ok(!/continue-on-error/.test(job.slice(0, index)), 'a failed part stops index.json');
});
