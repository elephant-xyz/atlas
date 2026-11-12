#!/usr/bin/env node
// Regenerate index.json from every group of every county page.
//   build-index            write index.json (exit 0 whether or not it changed)
//   build-index --lagging  print `true` when index.json does not say what the pages say, else
//                          `false`; writes nothing and needs no dependencies installed
// That a pull request leaves index.json alone is checked by validate-entry.mjs.
//
// `published_at` per group comes from git history (see gitPublishedAt), never from the page.
// `generated_from` is the main commit the entries were generated from. It is kept as-is when
// the entries did not change, so re-running on an unchanged registry is a no-op.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEntries, git, gitPublishedAt, readPages } from './lib.mjs';

export function readIndex(root) {
  const file = `${root}/index.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export const VERSION = 1;
const body = (index) => JSON.stringify({ version: index?.version, counties: index?.counties });

export function render(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

/**
 * Whether `index` (a parsed index.json) does not say what `pages` say: a group, a root, a schema,
 * a fips differs, or a page or group is gone. Publication dates aside, so it needs no history.
 * True means the publish workflow has work to do.
 */
export function lagging(pages, index) {
  const bare = (counties) => (counties ?? []).map((c) => ({ ...c, groups: Object.fromEntries(Object.entries(c.groups).map(([key, g]) => [key, { cid: g.cid, schema: g.schema, tables: g.tables }])) }));
  return JSON.stringify(bare(buildEntries(pages, () => undefined))) !== JSON.stringify(bare(index?.counties));
}

/** origin/main when the checkout has it, else HEAD (the publish job runs on main itself). */
function mainRef(root) {
  try {
    git(root, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}');
    return 'origin/main';
  } catch {
    return 'HEAD';
  }
}

/** Write index.json from `pages` (the working tree's by default); true when its entries changed. */
export function writeIndex(root, pages = readPages(root)) {
  const next = { version: VERSION, counties: buildEntries(pages, gitPublishedAt(root, mainRef(root))) };
  const current = readIndex(root);
  const unchanged = current && body(current) === body(next);
  const sha = unchanged ? current.generated_from : git(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(`${root}/index.json`, render({ version: VERSION, generated_from: sha, ...next }));
  return !unchanged;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  // --lagging: print whether index.json lags the pages (see lagging) and change nothing.
  if (process.argv.includes('--lagging')) {
    console.log(String(lagging(readPages(root), readIndex(root))));
    process.exit(0);
  }
  console.log(writeIndex(root) ? 'index.json updated' : 'index.json unchanged');
}
