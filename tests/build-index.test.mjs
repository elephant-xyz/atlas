import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildEntries, gitPublishedAt, readPages } from '../scripts/lib.mjs';
import { VERSION, writeIndex } from '../scripts/build-index.mjs';
import { CID_A, CID_B, CID_C, CID_D, SCHEMA, group, page, registry, stamps } from './helpers.mjs';

const T_A = '2026-09-21T17:23:52.000Z';
const T_C = '2026-09-22T00:00:00.000Z';
const at = stamps({ [CID_A]: T_A, [CID_C]: T_C });
const LEE = 'counties/FL/lee.json';

test('entries are sorted by state then county; a group holds cid, schema, tables, published_at only', () => {
  const pages = [
    { path: 'counties/GA/fulton.json', page: page({ state: 'GA', county: 'fulton', fips: '13121', groups: { county: group({ cid: CID_C, tables: CID_D }) } }) },
    { path: LEE, page: page({ county: 'lee', groups: { hoa: group({ cid: CID_C, tables: CID_D }), county: group() } }) },
    { path: 'counties/FL/collier.json', page: page({ county: 'collier', fips: '12021', groups: {} }) },
  ];
  const entries = buildEntries(pages, at);
  assert.deepEqual(entries.map((e) => `${e.state}/${e.county}`), ['FL/lee', 'GA/fulton']);
  assert.deepEqual(entries[0], {
    county: 'lee', state: 'FL', fips: '12071',
    groups: {
      county: { cid: CID_A, schema: SCHEMA, tables: CID_B, published_at: T_A },
      hoa: { cid: CID_C, schema: SCHEMA, tables: CID_D, published_at: T_C },
    },
  });
  assert.deepEqual(Object.keys(entries[0].groups), ['county', 'hoa']);
});

test('published_at comes from the lookup, never from the page', () => {
  const p = page({ groups: { county: group({ published_at: '1999-01-01T00:00:00Z' }) } });
  assert.equal(buildEntries([{ path: LEE, page: p }], at)[0].groups.county.published_at, T_A);
  assert.equal(JSON.stringify(buildEntries([{ path: LEE, page: page() }], stamps())).includes('published_at'), false);
});

const commit = (root, message, date) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', message], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });

test('gitPublishedAt is the committer date of the first main commit adding the cid to the page', () => {
  const root = registry({ [LEE]: page() });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  commit(root, 'first', '2026-09-21T20:23:52+03:00');
  writeFileSync(`${root}/${LEE}`, JSON.stringify(page({ groups: { county: group({ cid: CID_C, tables: CID_D }) } })));
  commit(root, 'second', '2026-09-22T00:00:00Z');
  const lookup = gitPublishedAt(root, 'main');
  assert.equal(lookup(LEE, CID_A), '2026-09-21T17:23:52.000Z');
  assert.equal(lookup(LEE, CID_C), '2026-09-22T00:00:00.000Z');
  assert.equal(lookup(LEE, CID_B.replace(/.$/, 'z')), undefined);
  assert.equal(gitPublishedAt('/nonexistent', 'main')(LEE, CID_A), undefined);
});

test('generation is deterministic and a no-op on an unchanged registry', () => {
  const root = registry({ [LEE]: page(), 'counties/GA/fulton.json': page({ state: 'GA', county: 'fulton', fips: '13121', groups: { county: group({ cid: CID_C, tables: CID_D }) } }) });
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
