import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const CID_A = 'baguqeerakenv6uzkrga4lx6jntgqe4ftdrqjgqiigm4h5gedrqopujfa6sda'; // smoke CountyIndex
export const CID_B = 'baguqeerasxkelzdxtkgdrii54zoanz3t7qznf72niikqmiyer4dlb2k2xfhq'; // smoke CountyTables
export const CID_C = 'baguqeerad32anku3fwoiex7gw4se6kybbujphmxmea3g2ztnytaatdpb43aq'; // smoke shard 0
export const CID_D = 'baguqeeraek5eh2ihcujvsmbv5i6jwmkqvvc3z46qegpyo7mdgm4w2j2z4qda'; // a data-group root
export const SCHEMA = 'bafkreia6tjziby3upxmidymud5iusd32urrztslgrudkwysc7ydmxoekuq'; // County data-group schema

export const group = (overrides = {}) => ({ cid: CID_A, schema: SCHEMA, tables: CID_B, ...overrides });

export function page(overrides = {}) {
  return { county: 'lee', state: 'FL', fips: '12071', groups: { county: group() }, ...overrides };
}

/** publishedAt stub for buildEntries: cid -> timestamp map. */
export const stamps = (map = {}) => (_path, cid) => map[cid];

/** Write a registry into a temp dir: files is { 'counties/FL/lee.json': obj, 'index.json': obj }. */
export function registry(files) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-'));
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
  }
  return root;
}
