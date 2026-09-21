#!/usr/bin/env node
// Regenerate index.json from every group of every county page.
//   build-index          write index.json (exit 0 whether or not it changed)
//   build-index --check  exit 1 if the committed index.json differs from a regeneration
//
// `published_at` per group comes from git history (see gitPublishedAt), never from the page.
// `generated_from` is the main commit the entries were generated from. It is kept as-is when
// the entries did not change, so re-running on an unchanged registry is a no-op.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEntries, gitPublishedAt, pagesAt, readPages } from './lib.mjs';

export function readIndex(root) {
  const file = `${root}/index.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export const VERSION = 5;
const body = (index) => JSON.stringify({ version: index?.version, counties: index?.counties });

export function render(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

/** Problems with the committed index.json relative to a regeneration from `pages`. */
export function checkIndex(root, pages, publishedAt = gitPublishedAt(root, mainRef(root))) {
  const committed = readIndex(root);
  if (!committed) return ['index.json: missing; run `npm run index`'];
  if (body(committed) !== body({ version: VERSION, counties: buildEntries(pages, publishedAt) })) {
    return ['index.json: differs from a regeneration; never edit it by hand, it is generated on merge'];
  }
  return [];
}

/** origin/main when the checkout has it, else HEAD (the publish job runs on main itself). */
function mainRef(root) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}'], { stdio: 'ignore' });
    return 'origin/main';
  } catch {
    return 'HEAD';
  }
}

export function writeIndex(root) {
  const next = { version: VERSION, counties: buildEntries(readPages(root), gitPublishedAt(root, mainRef(root))) };
  const current = readIndex(root);
  const unchanged = current && body(current) === body(next);
  const sha = unchanged ? current.generated_from : execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(`${root}/index.json`, render({ version: VERSION, generated_from: sha, ...next }));
  return !unchanged;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  if (process.argv.includes('--check')) {
    // On a pull request the index must match the pages already on main: the publish workflow
    // regenerates it after merge, so a PR that changes it was edited by hand.
    const problems = checkIndex(root, pagesAt('origin/main', root) ?? readPages(root));
    for (const p of problems) console.error(p);
    process.exit(problems.length ? 1 : 0);
  }
  console.log(writeIndex(root) ? 'index.json updated' : 'index.json unchanged');
}
