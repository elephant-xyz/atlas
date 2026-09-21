import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CID_A = 'baguqeerakenv6uzkrga4lx6jntgqe4ftdrqjgqiigm4h5gedrqopujfa6sda';
export const CID_B = 'baguqeerasxkelzdxtkgdrii54zoanz3t7qznf72niikqmiyer4dlb2k2xfhq';
export const CID_C = 'baguqeerad32anku3fwoiex7gw4se6kybbujphmxmea3g2ztnytaatdpb43aq';

export function run(overrides = {}) {
  return {
    groups: ['county'],
    county_root: CID_A,
    tables_root: CID_B,
    blocks: 133,
    properties: 3,
    parts: 40,
    cli: '994f96356c76b6697fb46dbe261d96b7a292c956',
    lexicon: { manifest_url: 'https://lexicon.elephant.xyz/api/manifest' },
    node: 'filebase',
    evidence: { car_upload: CID_C },
    status: 'published',
    ...overrides,
  };
}

/** publishedAt stub for buildEntries: root -> timestamp map. */
export const stamps = (map = {}) => (_path, cid) => map[cid];

export function page(overrides = {}) {
  return { county: 'lee', state: 'FL', fips: '12071', runs: [run()], ...overrides };
}

/** Write a registry into a temp dir: files is { 'counties/FL/lee.json': obj, 'index.json': obj, 'evidence/x.json': obj }. */
export function registry(files) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-'));
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  }
  return root;
}
