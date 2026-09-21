import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRegistry } from '../scripts/validate-entry.mjs';
import { VERSION } from '../scripts/build-index.mjs';
import { buildEntries, readPages } from '../scripts/lib.mjs';
import { CID_A, CID_C, page, registry, run, stamps } from './helpers.mjs';

const indexFor = (pages) => ({ version: VERSION, generated_from: 'x', counties: buildEntries(pages, stamps()) });
const check = (files) => {
  const root = registry(files);
  return validateRegistry(root, readPages(root));
};
const withIndex = (files, ...pages) => ({ ...files, 'index.json': indexFor(pages.map((page) => ({ page }))) });

test('valid page passes', () => {
  const lee = page();
  assert.deepEqual(check(withIndex({ 'counties/FL/lee.json': lee }, lee)), []);
});

test('archive-only run without tables_root passes', () => {
  const r = run();
  delete r.tables_root;
  const lee = page({ runs: [r] });
  assert.deepEqual(check(withIndex({ 'counties/FL/lee.json': lee }, lee)), []);
});

test('schema rejects bad keys, a run key, a latest pointer, and a published_at', () => {
  let problems = check(withIndex({ 'counties/FL/Lee.json': page({ county: 'Lee', fips: '1207' }) }));
  assert.ok(problems.some((p) => p.includes('/county')));
  assert.ok(problems.some((p) => p.includes('/fips')));
  problems = check(withIndex({ 'counties/FL/lee.json': page({ latest: 'x', runs: [run({ run: '2026-09-21-a', published_at: '2026-09-21T12:07:53Z' })] }) }));
  assert.ok(problems.some((p) => p.includes("must NOT have additional properties") && p.startsWith('counties/FL/lee.json: /')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('/runs/0 must NOT have additional properties')), problems.join('\n'));
});

test('path must match state and county', () => {
  const problems = check(withIndex({ 'counties/GA/lee.json': page() }));
  assert.ok(problems.some((p) => p.includes('path must be counties/FL/lee.json')), problems.join('\n'));
});

test('the same root on two pages is rejected', () => {
  const lee = page();
  const collier = page({ county: 'collier', fips: '12021' });
  const problems = check(withIndex({ 'counties/FL/lee.json': lee, 'counties/FL/collier.json': collier }, collier, lee));
  assert.ok(problems.some((p) => p.includes(`county_root ${CID_A} is already published by counties/FL/collier.json`)), problems.join('\n'));
});

test('appending a run with the root of an existing non-withdrawn run is rejected', () => {
  const lee = page({ runs: [run({ status: 'superseded' }), run({ blocks: 134 })] });
  const problems = check(withIndex({ 'counties/FL/lee.json': lee }, lee));
  assert.ok(problems.some((p) => p.includes('the same root is the same publication')), problems.join('\n'));
});

test('a withdrawn run releases its roots for a later run on the same page', () => {
  const lee = page({ runs: [run({ status: 'withdrawn' }), run({ blocks: 134 })] });
  assert.deepEqual(check(withIndex({ 'counties/FL/lee.json': lee }, lee)), []);
});

test('hand-edited index fails', () => {
  const lee = page();
  const index = indexFor([{ page: lee }]);
  index.counties[0].groups.county.properties = 999;
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': index });
  assert.deepEqual(problems, ['index.json: differs from a regeneration; never edit it by hand, it is generated on merge']);
});

test('runs already on main may change status but nothing else, by array position', () => {
  const base = [{ path: 'counties/FL/lee.json', page: page() }];
  const superseded = page({ runs: [run({ status: 'superseded' })] });
  assert.deepEqual(validateRegistry(registry(withIndex({ 'counties/FL/lee.json': superseded }, ...base.map((b) => b.page))), base), []);

  const edited = page({ runs: [run({ blocks: 134 })] });
  assert.deepEqual(validateRegistry(registry(withIndex({ 'counties/FL/lee.json': edited }, ...base.map((b) => b.page))), base), [
    `counties/FL/lee.json: run 0 (${CID_A}) was edited in place; only status may change, supersede it instead`,
  ]);

  const inserted = page({ runs: [run({ county_root: CID_C, tables_root: undefined, status: 'withdrawn' }), run()] });
  const problems = validateRegistry(registry(withIndex({ 'counties/FL/lee.json': inserted }, ...base.map((b) => b.page))), base);
  assert.ok(problems.some((p) => p.includes('run 0') && p.includes('edited in place')), problems.join('\n'));

  const removed = page({ runs: [run({ county_root: CID_C, tables_root: undefined })] });
  const problems2 = validateRegistry(registry({ 'counties/FL/lee.json': removed, 'index.json': indexFor(base) }), base);
  assert.ok(problems2.some((p) => p.includes('edited in place')), problems2.join('\n'));

  const emptied = page({ runs: [] });
  const problems3 = validateRegistry(registry({ 'counties/FL/lee.json': emptied, 'index.json': indexFor(base) }), base);
  assert.ok(problems3.some((p) => p.includes('/runs must NOT have fewer than 1 items')), problems3.join('\n'));

  assert.deepEqual(validateRegistry(registry({ 'index.json': indexFor(base) }), base), ['counties/FL/lee.json: page was deleted; pages are never removed']);
});

test('groups must be non-empty, snake_case, unique', () => {
  for (const groups of [[], ['County'], ['county', 'county'], ['property-improvement']]) {
    const lee = page({ runs: [run({ groups })] });
    const problems = check(withIndex({ 'counties/FL/lee.json': lee }, lee));
    assert.ok(problems.some((p) => p.includes('/runs/0/groups')), JSON.stringify(groups) + ' -> ' + problems.join('\n'));
  }
});

test('evidence must be a CID or a path under evidence/<state>/<county>/<county_root>/ that exists', () => {
  const dir = `evidence/FL/lee/${CID_A}`;
  const abs = page({ runs: [run({ evidence: { car_upload: '/tmp/upload.json' } })] });
  let problems = check(withIndex({ 'counties/FL/lee.json': abs }, abs));
  assert.ok(problems.some((p) => p.includes('/runs/0/evidence/car_upload')), problems.join('\n'));

  const escaping = page({ runs: [run({ evidence: { car_upload: `${dir}/../../x.json` } })] });
  problems = check(withIndex({ 'counties/FL/lee.json': escaping }, escaping));
  assert.ok(problems.some((p) => p.includes('must be a CID or a repository-relative path')), problems.join('\n'));

  const elsewhere = page({ runs: [run({ evidence: { car_upload: 'evidence/FL/lee/x.json' } })] });
  problems = check(withIndex({ 'counties/FL/lee.json': elsewhere, 'evidence/FL/lee/x.json': {} }, elsewhere));
  assert.deepEqual(problems, [`counties/FL/lee.json: run ${CID_A} evidence.car_upload must live under ${dir}/`]);

  const missing = page({ runs: [run({ evidence: { car_upload: `${dir}/x.json` } })] });
  problems = check(withIndex({ 'counties/FL/lee.json': missing }, missing));
  assert.deepEqual(problems, [`counties/FL/lee.json: run ${CID_A} evidence.car_upload ${dir}/x.json is not in the repository`]);

  const present = page({ runs: [run({ evidence: { car_upload: `${dir}/x.json` } })] });
  assert.deepEqual(check(withIndex({ 'counties/FL/lee.json': present, [`${dir}/x.json`]: {} }, present)), []);
});

test('a page that predates the schema may be migrated', () => {
  const v2 = page();
  v2.runs[0].run = '2026-09-21-a';
  const migrated = page({ runs: [run({ blocks: 999 })] }); // any rewrite is accepted while the base fails the schema
  const root = registry({ 'counties/FL/lee.json': migrated, 'index.json': indexFor([{ page: v2 }]) });
  assert.deepEqual(validateRegistry(root, [{ path: 'counties/FL/lee.json', page: v2 }]), []);
});
