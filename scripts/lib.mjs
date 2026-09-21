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

/**
 * The list consumers read: one entry per county with a published run; `groups` maps each
 * data-group key to the newest published run carrying it (roots and property count only).
 */
export function buildEntries(pages) {
  const entries = [];
  for (const { page } of pages) {
    const groups = {};
    for (const run of page.runs) {
      if (run.status !== 'published') continue;
      for (const key of run.groups ?? []) { // ponytail: pre-v2 base pages have no groups; only matters during a schema migration
        groups[key] = { run: run.run, county_root: run.county_root, ...(run.tables_root && { tables_root: run.tables_root }), properties: run.properties };
      }
    }
    const keys = Object.keys(groups).sort();
    if (keys.length) entries.push({ county: page.county, state: page.state, fips: page.fips, groups: Object.fromEntries(keys.map((k) => [k, groups[k]])) });
  }
  return entries.sort((a, b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county));
}

/** Roots held by non-withdrawn runs. A withdrawn run releases its roots: they may be published again. */
export function rootsOf(pages) {
  const roots = new Set();
  for (const { page } of pages) for (const run of page.runs) if (run.status !== 'withdrawn') for (const k of ['county_root', 'tables_root']) if (run[k]) roots.add(run[k]);
  return roots;
}

export const relPath = (root, path) => relative(root, path).replaceAll('\\', '/');
