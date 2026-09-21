import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildEntries, gitPublishedAt, readPages } from '../scripts/lib.mjs';
import { VERSION, writeIndex } from '../scripts/build-index.mjs';
import { CID_A, CID_B, CID_C, page, registry, run, stamps } from './helpers.mjs';

const later = (overrides) => run({ county_root: CID_C, tables_root: undefined, ...overrides });
const T_A = '2026-09-21T17:23:52.000Z';
const T_C = '2026-09-22T00:00:00.000Z';
const at = stamps({ [CID_A]: T_A, [CID_C]: T_C });

test('entries are sorted by state then county; a group holds root, tables_root, properties, published_at only', () => {
  const pages = [
    { page: page({ state: 'GA', county: 'fulton', fips: '13121' }) },
    { page: page({ county: 'lee', runs: [run({ status: 'superseded' }), later()] }) },
    { page: page({ county: 'collier', fips: '12021' }) },
  ];
  const entries = buildEntries(pages, at);
  assert.deepEqual(entries.map((e) => `${e.state}/${e.county}`), ['FL/collier', 'FL/lee', 'GA/fulton']);
  assert.deepEqual(entries[1], { county: 'lee', state: 'FL', fips: '12071', groups: { county: { county_root: CID_C, properties: 3, published_at: T_C } } });
  assert.deepEqual(Object.keys(entries[0].groups.county), ['county_root', 'tables_root', 'properties', 'published_at']);
  assert.equal(entries[0].groups.county.tables_root, CID_B);
  assert.equal(entries[0].groups.county.published_at, T_A);
});

test('published_at comes from the lookup, never from the page', () => {
  const p = page({ runs: [run({ published_at: '1999-01-01T00:00:00Z' })] });
  assert.equal(buildEntries([{ page: p }], at)[0].groups.county.published_at, T_A);
  assert.equal('published_at' in buildEntries([{ page: page() }], stamps())[0].groups.county, true);
  assert.equal(JSON.stringify(buildEntries([{ page: page() }], stamps())).includes('published_at'), false);
});

test('order is array position: the last published run carrying a group wins', () => {
  const p = page({ runs: [run({ status: 'superseded' }), later()] });
  assert.equal(buildEntries([{ page: p }], at)[0].groups.county.county_root, CID_C);
});

test('two runs carrying different groups resolve to two groups under one county', () => {
  const p = page({ runs: [run({ groups: ['seed'] }), later({ groups: ['county'] })] });
  const [entry] = buildEntries([{ page: p }], at);
  assert.deepEqual(Object.keys(entry.groups), ['county', 'seed']);
  assert.equal(entry.groups.seed.county_root, CID_A);
  assert.equal(entry.groups.county.county_root, CID_C);
});

test('a newer run carrying only property_improvement does not replace the county group', () => {
  const p = page({ runs: [run(), later({ groups: ['property_improvement'] })] });
  const [entry] = buildEntries([{ page: p }], at);
  assert.equal(entry.groups.county.county_root, CID_A);
  assert.equal(entry.groups.property_improvement.county_root, CID_C);
});

test('only published runs surface: withdrawn and superseded newest runs fall back to the previous published run', () => {
  for (const status of ['withdrawn', 'superseded']) {
    const p = page({ runs: [run(), later({ status })] });
    assert.equal(buildEntries([{ page: p }], at)[0].groups.county.county_root, CID_A, status);
    assert.deepEqual(buildEntries([{ page: page({ runs: [run({ status })] }) }], at), [], status);
  }
});

test('withdrawn then republished with the same root yields the new run', () => {
  const p = page({ runs: [run({ status: 'withdrawn' }), run()] });
  assert.deepEqual(buildEntries([{ page: p }], at)[0].groups.county, { county_root: CID_A, tables_root: CID_B, properties: 3, published_at: T_A });
});

const commit = (root, message, date) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', message], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });

test('gitPublishedAt is the committer date of the first main commit adding the root to the page', () => {
  const path = 'counties/FL/lee.json';
  const root = registry({ [path]: page({ runs: [run({ evidence: {} })] }) }); // CID_C is the fixture evidence CID; keep it out of commit one
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  commit(root, 'first', '2026-09-21T20:23:52+03:00');
  writeFileSync(`${root}/${path}`, JSON.stringify(page({ runs: [run({ evidence: {}, status: 'superseded' }), later({ evidence: {} })] })));
  commit(root, 'second', '2026-09-22T00:00:00Z');
  const lookup = gitPublishedAt(root, 'main');
  assert.equal(lookup(path, CID_A), '2026-09-21T17:23:52.000Z');
  assert.equal(lookup(path, CID_C), '2026-09-22T00:00:00.000Z');
  assert.equal(lookup(path, CID_B.replace(/.$/, 'z')), undefined);
  assert.equal(gitPublishedAt('/nonexistent', 'main')(path, CID_A), undefined);
});

test('generation is deterministic and a no-op on an unchanged registry', () => {
  const root = registry({ 'counties/FL/lee.json': page(), 'counties/GA/fulton.json': page({ state: 'GA', county: 'fulton', fips: '13121', runs: [later()] }) });
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  commit(root, 'x', '2026-09-22T00:00:00Z');
  assert.equal(writeIndex(root), true);
  const first = readFileSync(`${root}/index.json`, 'utf8');
  assert.equal(writeIndex(root), false);
  assert.equal(readFileSync(`${root}/index.json`, 'utf8'), first);
  const index = JSON.parse(first);
  assert.deepEqual(index.counties, buildEntries(readPages(root), gitPublishedAt(root, 'HEAD')));
  assert.equal(index.counties[0].groups.county.published_at, '2026-09-22T00:00:00.000Z');
  assert.match(index.generated_from, /^[0-9a-f]{40}$/);
  assert.equal(index.version, VERSION);
});
