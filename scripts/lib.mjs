import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const COUNTIES = 'counties';

/** Pages in the working tree: [{ path: 'counties/FL/lee.json', page }], sorted by path. */
export function readPages(root) {
  let names;
  try {
    names = readdirSync(join(root, COUNTIES), { recursive: true });
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => join(COUNTIES, n).replaceAll('\\', '/'))
    .sort()
    .map((path) => ({ path, page: JSON.parse(readFileSync(join(root, path), 'utf8')) }));
}

/** Pages committed at a git ref, or null when the ref does not resolve. */
export function pagesAt(ref, root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    return null;
  }
  return git('ls-tree', '-r', '--name-only', ref, '--', COUNTIES)
    .split('\n')
    .filter((p) => p.endsWith('.json'))
    .sort()
    .map((path) => ({ path, page: JSON.parse(git('show', `${ref}:${path}`)) }));
}

/** The flat list consumers read: the `latest` run of every page, sorted by state then county. */
export function buildEntries(pages) {
  return pages
    .filter(({ page }) => page.latest)
    .map(({ page }) => {
      const run = page.runs.find((r) => r.run === page.latest);
      return { county: page.county, state: page.state, fips: page.fips, ...run };
    })
    .sort((a, b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county));
}

export function rootsOf(pages) {
  const roots = new Set();
  for (const { page } of pages) for (const run of page.runs) for (const k of ['county_root', 'tables_root']) if (run[k]) roots.add(run[k]);
  return roots;
}

export const relPath = (root, path) => relative(root, path).replaceAll('\\', '/');
