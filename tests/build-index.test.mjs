import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildEntries, readPages } from '../scripts/lib.mjs';
import { VERSION, writeIndex } from '../scripts/build-index.mjs';
import { CID_A, CID_B, CID_C, page, registry, run } from './helpers.mjs';

const later = (overrides) => run({ county_root: CID_C, tables_root: undefined, published_at: '2026-09-22T00:00:00Z', ...overrides });

test('entries are sorted by state then county; a group holds root, tables_root, properties, published_at only', () => {
  const pages = [
    { page: page({ state: 'GA', county: 'fulton', fips: '13121' }) },
    { page: page({ county: 'lee', runs: [run({ status: 'superseded' }), later()] }) },
    { page: page({ county: 'collier', fips: '12021' }) },
  ];
  const entries = buildEntries(pages);
  assert.deepEqual(entries.map((e) => `${e.state}/${e.county}`), ['FL/collier', 'FL/lee', 'GA/fulton']);
  assert.deepEqual(entries[1], { county: 'lee', state: 'FL', fips: '12071', groups: { county: { county_root: CID_C, properties: 3, published_at: '2026-09-22T00:00:00Z' } } });
  assert.deepEqual(Object.keys(entries[0].groups.county), ['county_root', 'tables_root', 'properties', 'published_at']);
  assert.equal(entries[0].groups.county.tables_root, CID_B);
});

test('order is array position: the last run carrying a group wins regardless of published_at', () => {
  const p = page({ runs: [run({ published_at: '2026-09-30T00:00:00Z', status: 'superseded' }), later({ published_at: '2026-09-01T00:00:00Z' })] });
  assert.equal(buildEntries([{ page: p }])[0].groups.county.county_root, CID_C);
});

test('two runs carrying different groups resolve to two groups under one county', () => {
  const p = page({ runs: [run({ groups: ['seed'] }), later({ groups: ['county'] })] });
  const [entry] = buildEntries([{ page: p }]);
  assert.deepEqual(Object.keys(entry.groups), ['county', 'seed']);
  assert.equal(entry.groups.seed.county_root, CID_A);
  assert.equal(entry.groups.county.county_root, CID_C);
});

test('a newer run carrying only property_improvement does not replace the county group', () => {
  const p = page({ runs: [run(), later({ groups: ['property_improvement'] })] });
  const [entry] = buildEntries([{ page: p }]);
  assert.equal(entry.groups.county.county_root, CID_A);
  assert.equal(entry.groups.property_improvement.county_root, CID_C);
});

test('a withdrawn newest run falls back to the previous non-withdrawn run; all withdrawn means no entry', () => {
  const p = page({ runs: [run(), later({ status: 'withdrawn' })] });
  assert.equal(buildEntries([{ page: p }])[0].groups.county.county_root, CID_A);
  assert.deepEqual(buildEntries([{ page: page({ runs: [run({ status: 'withdrawn' })] }) }]), []);
});

test('withdrawn then republished with the same root yields the new run', () => {
  const p = page({ runs: [run({ status: 'withdrawn' }), run({ published_at: '2026-09-22T00:00:00Z' })] });
  assert.deepEqual(buildEntries([{ page: p }])[0].groups.county, { county_root: CID_A, tables_root: CID_B, properties: 3, published_at: '2026-09-22T00:00:00Z' });
});

test('generation is deterministic and a no-op on an unchanged registry', () => {
  const root = registry({ 'counties/FL/lee.json': page(), 'counties/GA/fulton.json': page({ state: 'GA', county: 'fulton', fips: '13121', runs: [later()] }) });
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x']);
  assert.equal(writeIndex(root), true);
  const first = readFileSync(`${root}/index.json`, 'utf8');
  assert.equal(writeIndex(root), false);
  assert.equal(readFileSync(`${root}/index.json`, 'utf8'), first);
  assert.deepEqual(JSON.parse(first).counties, buildEntries(readPages(root)));
  assert.match(JSON.parse(first).generated_from, /^[0-9a-f]{40}$/);
  assert.equal(JSON.parse(first).version, VERSION);
});
