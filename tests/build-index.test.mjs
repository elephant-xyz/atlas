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
  assert.deepEqual(entries[1], { county: 'lee', state: 'FL', fips: '12071', groups: { county: { run: '2026-09-22-a', county_root: CID_C, tables_root: entries[1].groups.county.tables_root, properties: 3 } } });
  assert.deepEqual(Object.keys(entries[1].groups.county), ['run', 'county_root', 'tables_root', 'properties']);
});

test('an archive-only run has no tables_root in its group', () => {
  const r = run();
  delete r.tables_root;
  assert.deepEqual(buildEntries([{ page: page({ runs: [r] }) }])[0].groups.county, { run: '2026-09-21-a', county_root: r.county_root, properties: 3 });
});

test('two runs carrying different groups resolve to two groups under one county', () => {
  const p = page({ latest: '2026-09-22-a', runs: [run({ groups: ['seed'] }), run({ run: '2026-09-22-a', groups: ['county'], county_root: CID_C, tables_root: undefined })] });
  const [entry] = buildEntries([{ page: p }]);
  assert.deepEqual(Object.keys(entry.groups), ['county', 'seed']);
  assert.equal(entry.groups.seed.run, '2026-09-21-a');
  assert.equal(entry.groups.county.run, '2026-09-22-a');
});

test('a newer run carrying only property_improvement does not replace the county group', () => {
  const p = page({ latest: '2026-09-22-a', runs: [run(), run({ run: '2026-09-22-a', groups: ['property_improvement'], county_root: CID_C, tables_root: undefined })] });
  const [entry] = buildEntries([{ page: p }]);
  assert.equal(entry.groups.county.run, '2026-09-21-a');
  assert.equal(entry.groups.county.county_root, run().county_root);
  assert.equal(entry.groups.property_improvement.run, '2026-09-22-a');
});

test('a withdrawn newest run falls back to the previous published run', () => {
  const p = page({ runs: [run(), run({ run: '2026-09-22-a', county_root: CID_C, status: 'withdrawn' })] });
  const [entry] = buildEntries([{ page: p }]);
  assert.equal(entry.groups.county.run, '2026-09-21-a');
  const superseded = page({ runs: [run({ status: 'superseded' })] });
  delete superseded.latest;
  assert.deepEqual(buildEntries([{ page: superseded }]), []);
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
  assert.equal(JSON.parse(first).version, 2);
});
