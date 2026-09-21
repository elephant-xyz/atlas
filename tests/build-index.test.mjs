import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildEntries, readPages } from '../scripts/lib.mjs';
import { writeIndex } from '../scripts/build-index.mjs';
import { page, registry, run, CID_C } from './helpers.mjs';

test('entries are the latest run per page, sorted by state then county', () => {
  const pages = [
    { page: page({ state: 'GA', county: 'fulton', fips: '13121' }) },
    { page: page({ county: 'lee', latest: '2026-09-22-a', runs: [run({ status: 'superseded' }), run({ run: '2026-09-22-a', county_root: CID_C })] }) },
    { page: page({ county: 'collier', fips: '12021' }) },
  ];
  const entries = buildEntries(pages);
  assert.deepEqual(entries.map((e) => `${e.state}/${e.county}`), ['FL/collier', 'FL/lee', 'GA/fulton']);
  assert.equal(entries[1].run, '2026-09-22-a');
  assert.equal(entries[1].county_root, CID_C);
});

test('a page without latest contributes nothing', () => {
  const p = page({ runs: [run({ status: 'withdrawn' })] });
  delete p.latest;
  assert.deepEqual(buildEntries([{ page: p }]), []);
});

test('generation is deterministic and a no-op on an unchanged registry', () => {
  const root = registry({ 'counties/FL/lee.json': page(), 'counties/GA/fulton.json': page({ state: 'GA', county: 'fulton', fips: '13121', runs: [run({ county_root: CID_C, tables_root: undefined })] }) });
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x']);
  assert.equal(writeIndex(root), true);
  const first = readFileSync(`${root}/index.json`, 'utf8');
  assert.equal(writeIndex(root), false);
  assert.equal(readFileSync(`${root}/index.json`, 'utf8'), first);
  assert.deepEqual(JSON.parse(first).counties, buildEntries(readPages(root)));
  assert.match(JSON.parse(first).generated_from, /^[0-9a-f]{40}$/);
});
