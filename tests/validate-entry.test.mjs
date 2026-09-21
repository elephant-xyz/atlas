import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRegistry } from '../scripts/validate-entry.mjs';
import { VERSION } from '../scripts/build-index.mjs';
import { buildEntries, changedGroups, readPages } from '../scripts/lib.mjs';
import { CID_A, CID_B, CID_C, CID_D, group, page, registry, stamps } from './helpers.mjs';

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

test('a page with no groups passes and publishes nothing', () => {
  const lee = page({ groups: {} });
  assert.deepEqual(check(withIndex({ 'counties/FL/lee.json': lee }, lee)), []);
  assert.deepEqual(buildEntries([{ path: 'counties/FL/lee.json', page: lee }], stamps()), []);
});

test('schema rejects bad keys, bad group keys, missing tables, and extra fields', () => {
  let problems = check(withIndex({ 'counties/FL/Lee.json': page({ county: 'Lee', fips: '1207' }) }));
  assert.ok(problems.some((p) => p.includes('/county')));
  assert.ok(problems.some((p) => p.includes('/fips')));
  for (const key of ['County', 'property-improvement', '_x']) {
    problems = check(withIndex({ 'counties/FL/lee.json': page({ groups: { [key]: group() } }) }));
    assert.ok(problems.some((p) => p.includes('/groups must NOT have additional properties')), key + ' -> ' + problems.join('\n'));
  }
  const noTables = group();
  delete noTables.tables;
  problems = check(withIndex({ 'counties/FL/lee.json': page({ groups: { county: noTables } }) }));
  assert.ok(problems.some((p) => p.includes("/groups/county must have required property 'tables'")), problems.join('\n'));
  problems = check(withIndex({ 'counties/FL/lee.json': page({ runs: [], groups: { county: group({ blocks: 1 }) } }) }));
  assert.ok(problems.some((p) => p.includes('/ must NOT have additional properties')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('/groups/county must NOT have additional properties')), problems.join('\n'));
});

test('path must match state and county', () => {
  const problems = check(withIndex({ 'counties/GA/lee.json': page() }));
  assert.ok(problems.some((p) => p.includes('path must be counties/FL/lee.json')), problems.join('\n'));
});

test('a cid or tables root never appears under two groups or two pages', () => {
  const lee = page();
  const collier = page({ county: 'collier', fips: '12021' });
  let problems = check(withIndex({ 'counties/FL/lee.json': lee, 'counties/FL/collier.json': collier }, collier, lee));
  assert.ok(problems.some((p) => p === `counties/FL/lee.json: groups.county.cid ${CID_A} is already used by counties/FL/collier.json groups.county.cid`), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes(`groups.county.tables ${CID_B} is already used by`)), problems.join('\n'));

  const twoGroups = page({ groups: { county: group(), property_improvement: group({ cid: CID_C }) } });
  problems = check(withIndex({ 'counties/FL/lee.json': twoGroups }, twoGroups));
  assert.deepEqual(problems, [`counties/FL/lee.json: groups.property_improvement.tables ${CID_B} is already used by counties/FL/lee.json groups.county.tables`]);

  const crossed = page({ groups: { county: group(), hoa: group({ cid: CID_C, tables: CID_A }) } });
  problems = check(withIndex({ 'counties/FL/lee.json': crossed }, crossed));
  assert.ok(problems.some((p) => p.includes(`groups.hoa.tables ${CID_A} is already used by counties/FL/lee.json groups.county.cid`)), problems.join('\n'));
});

test('hand-edited index fails', () => {
  const lee = page();
  const index = indexFor([{ page: lee }]);
  index.counties[0].groups.county.cid = CID_D;
  const problems = check({ 'counties/FL/lee.json': lee, 'index.json': index });
  assert.deepEqual(problems, ['index.json: differs from a regeneration; never edit it by hand, it is generated on merge']);
});

test('changedGroups picks groups whose cid, schema, or tables differ from main', () => {
  const at = (path, page) => ({ path, page });
  const base = [at('counties/FL/lee.json', page({ groups: { county: group(), hoa: group({ cid: CID_C, tables: CID_D }) } }))];
  const same = changedGroups(base, base);
  assert.deepEqual(same, []);
  const head = [
    at('counties/FL/lee.json', page({ groups: { county: group({ schema: CID_D }), hoa: group({ cid: CID_C, tables: CID_D }) } })),
    at('counties/GA/fulton.json', page({ state: 'GA', county: 'fulton', fips: '13121', groups: { county: group({ cid: CID_D, tables: CID_C }) } })),
  ];
  assert.deepEqual(changedGroups(head, base).map((t) => `${t.path} ${t.key}`), ['counties/FL/lee.json county', 'counties/GA/fulton.json county']);
  assert.equal(changedGroups(head, null).length, 3);
});
