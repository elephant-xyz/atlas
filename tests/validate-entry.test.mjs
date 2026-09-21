import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRegistry } from '../scripts/validate-entry.mjs';
import { buildEntries, readPages } from '../scripts/lib.mjs';
import { CID_C, page, registry, run } from './helpers.mjs';

const indexFor = (pages) => ({ generated_from: 'x', counties: buildEntries(pages) });
const check = (files) => {
  const root = registry(files);
  return validateRegistry(root, readPages(root));
};

test('valid page passes', () => {
  const lee = page();
  assert.deepEqual(check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) }), []);
});

test('archive-only run without tables_root passes', () => {
  const r = run();
  delete r.tables_root;
  const lee = page({ runs: [r] });
  assert.deepEqual(check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) }), []);
});

test('schema rejects bad keys', () => {
  const problems = check({ 'counties/FL/Lee.json': page({ county: 'Lee', fips: '1207' }), 'index.json': indexFor([]) });
  assert.ok(problems.some((p) => p.includes('/county')));
  assert.ok(problems.some((p) => p.includes('/fips')));
});

test('path must match state and county', () => {
  const problems = check({ 'counties/GA/lee.json': page(), 'index.json': indexFor([]) });
  assert.ok(problems.some((p) => p.includes('path must be counties/FL/lee.json')), problems.join('\n'));
});

test('duplicate root across the registry fails', () => {
  const lee = page();
  const collier = page({ county: 'collier', fips: '12021' });
  const problems = check({ 'counties/FL/lee.json': lee, 'counties/FL/collier.json': collier, 'index.json': indexFor([{ page: collier }, { page: lee }]) });
  assert.ok(problems.some((p) => p.includes('already used by')), problems.join('\n'));
});

test('out-of-order runs fail', () => {
  const lee = page({ latest: '2026-09-22-a', runs: [run({ run: '2026-09-22-a' }), run({ run: '2026-09-21-a', county_root: CID_C, tables_root: undefined })] });
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) });
  assert.ok(problems.some((p) => p.includes('must be ascending')), problems.join('\n'));
});

test('duplicate run id fails', () => {
  const lee = page({ runs: [run(), run({ county_root: CID_C, tables_root: undefined })] });
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) });
  assert.ok(problems.some((p) => p.includes('appears twice')), problems.join('\n'));
});

test('withdrawn latest fails', () => {
  const lee = page({ runs: [run({ status: 'withdrawn' })] });
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) });
  assert.deepEqual(problems, ['counties/FL/lee.json: latest 2026-09-21-a is withdrawn']);
});

test('latest must name an existing run', () => {
  const lee = page({ latest: '2026-09-22-a' });
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) });
  assert.ok(problems.some((p) => p.includes('is not a run on this page')), problems.join('\n'));
});

test('hand-edited index fails', () => {
  const lee = page();
  const index = indexFor([{ page: lee }]);
  index.counties[0].blocks = 999;
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': index });
  assert.deepEqual(problems, ['index.json: differs from a regeneration; never edit it by hand, it is generated on merge']);
});

test('a run already on main may change status but nothing else', () => {
  const base = [{ path: 'counties/FL/lee.json', page: page() }];
  const superseded = page({ runs: [run({ status: 'superseded' })] });
  const root = registry({ 'counties/FL/lee.json': superseded, 'index.json': indexFor(base) });
  assert.deepEqual(validateRegistry(root, base), []);

  const edited = page({ runs: [run({ blocks: 134 })] });
  const root2 = registry({ 'counties/FL/lee.json': edited, 'index.json': indexFor(base) });
  assert.deepEqual(validateRegistry(root2, base), ['counties/FL/lee.json: run 2026-09-21-a was edited in place; only status may change, supersede it instead']);

  const root3 = registry({ 'index.json': indexFor(base) });
  assert.deepEqual(validateRegistry(root3, base), ['counties/FL/lee.json: page was deleted; pages are never removed']);
});

test('a page whose only run is withdrawn passes when latest is absent', () => {
  const lee = page({ runs: [run({ status: 'withdrawn' })] });
  delete lee.latest;
  assert.deepEqual(check({ 'counties/FL/lee.json': lee, 'index.json': indexFor([{ page: lee }]) }), []);
});
