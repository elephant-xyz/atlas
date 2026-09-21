import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * When the registry observed a root: committer date (UTC) of the first commit on `ref`'s
 * first-parent history in which the root appears in the page file. That is the merge commit,
 * whatever the branch history looked like. Returns undefined when the root is not on `ref` yet
 * (or `root` is not a git checkout).
 */
export function gitPublishedAt(root, ref = 'origin/main') {
  return (path, cid) => {
    try {
      const out = execFileSync('git', ['-C', root, 'log', '--first-parent', '--reverse', '--format=%cI', `-S${cid}`, ref, '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.split('\n')[0];
      return first ? new Date(first).toISOString() : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Every (key, group) of a page, keys sorted. */
export const groupsOf = (page) => Object.keys(page.groups ?? {}).sort().map((key) => [key, page.groups[key]]);

/**
 * The list consumers read: one entry per county with at least one group; each group is copied
 * from the page plus `published_at` from `publishedAt(path, cid)` (undefined leaves it out).
 */
export function buildEntries(pages, publishedAt) {
  return pages
    .filter(({ page }) => groupsOf(page).length)
    .map(({ path, page }) => ({
      county: page.county,
      state: page.state,
      fips: page.fips,
      groups: Object.fromEntries(groupsOf(page).map(([key, g]) => [key, { cid: g.cid, schema: g.schema, tables: g.tables, published_at: publishedAt(path, g.cid) }])),
    }))
    .sort((a, b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county));
}

/** Every archive and tables root held by any group on any page. */
export function rootsOf(pages) {
  const roots = new Set();
  for (const { page } of pages) for (const [, g] of groupsOf(page)) roots.add(g.cid).add(g.tables);
  return roots;
}

/** Groups whose (cid, schema, tables) differ from the same group on the base pages: [{ path, key, ...group }]. */
export function changedGroups(pages, basePages) {
  const base = new Map((basePages ?? []).map(({ path, page }) => [path, page]));
  const out = [];
  for (const { path, page } of pages) {
    for (const [key, g] of groupsOf(page)) {
      const before = base.get(path)?.groups?.[key];
      if (!before || before.cid !== g.cid || before.schema !== g.schema || before.tables !== g.tables) out.push({ path, key, ...g });
    }
  }
  return out;
}

/** Groups whose archive cid is not held by any group on the base pages: [{ path, key, ...group }]. */
export function newArchives(pages, basePages) {
  const known = rootsOf(basePages ?? []);
  return changedGroups(pages, basePages).filter((t) => !known.has(t.cid));
}
