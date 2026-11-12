import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const COUNTIES = 'counties';

/**
 * Run git in `root` and return its stdout as it is (callers trim). stderr is captured, so it
 * shows in the thrown error's message and nowhere else. No output limit: index.json and
 * `git log` grow with the registry, and the default 1 MiB would turn into a silent failure.
 */
export const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });

/** Wait `ms` milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An abort signal for a request: after `ms`, or as soon as `signal` (optional) aborts. */
export const timeoutSignal = (ms, signal) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);

/**
 * Run `jobs` (functions returning promises), `n` at a time. Each job is called with a signal;
 * on the first rejection no further job starts and the signal is aborted, so the jobs still
 * running can stop their requests instead of finishing work that will be discarded. The pool
 * rejects with that first error once they have settled: nothing keeps working behind it.
 */
export async function pool(jobs, n) {
  const stop = new AbortController();
  let next = 0;
  let failed;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      try {
        await jobs[next++](stop.signal);
      } catch (e) {
        failed ??= { error: e };
        stop.abort(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, worker));
  if (failed) throw failed.error;
}

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

/** Whether `ref` names a commit in the checkout at `root`. */
export function refExists(root, ref) {
  try {
    git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Pages committed at a git ref, or null when the ref does not resolve. */
export function pagesAt(ref, root) {
  if (!refExists(root, ref)) return null;
  return git(root, 'ls-tree', '-r', '--name-only', ref, '--', COUNTIES)
    .split('\n')
    .filter((p) => p.endsWith('.json'))
    .sort()
    .map((path) => ({ path, page: JSON.parse(git(root, 'show', `${ref}:${path}`)) }));
}

/**
 * index.json as committed at a git ref (text), or null when the ref or the file is not there
 * (git exits 128, also outside a checkout). Any other failure is thrown, never read as "no index".
 */
export function indexAt(ref, root) {
  try {
    return git(root, 'show', `${ref}:index.json`);
  } catch (e) {
    if (e.status === 128) return null;
    throw e;
  }
}

/**
 * The commit a pull request is compared with: where HEAD left origin/main. On a pull-request
 * merge commit that is the main the merge was built on, so a check re-run days later is still
 * compared with that main, not with what main has become since. origin/main itself when git
 * finds no common ancestor (the caller then treats a ref that does not resolve as "no base").
 */
export function baseRef(root) {
  try {
    return git(root, 'merge-base', 'origin/main', 'HEAD').trim();
  } catch {
    return 'origin/main';
  }
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
      const out = git(root, 'log', '--first-parent', '--reverse', '--format=%cI', `-S${cid}`, ref, '--', path);
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

/** Groups whose (cid, schema, tables, car) differ from the same group on the base pages: [{ path, key, ...group }]. */
export function changedGroups(pages, basePages) {
  const base = new Map((basePages ?? []).map(({ path, page }) => [path, page]));
  const out = [];
  for (const { path, page } of pages) {
    for (const [key, g] of groupsOf(page)) {
      const before = base.get(path)?.groups?.[key];
      if (!before || before.cid !== g.cid || before.schema !== g.schema || before.tables !== g.tables || before.car !== g.car) out.push({ path, key, ...g });
    }
  }
  return out;
}

/** Groups whose archive cid is not held by any group on the base pages: [{ path, key, ...group }]. */
export function newArchives(pages, basePages) {
  const known = rootsOf(basePages ?? []);
  return changedGroups(pages, basePages).filter((t) => !known.has(t.cid));
}

/**
 * Every version of a page on `ref`'s first-parent history, newest first: { sha, page }, with
 * `page` undefined at a commit that deleted it (a withdrawal does) or left it unreadable.
 */
export function* pageHistory(root, path, ref = 'HEAD') {
  for (const sha of git(root, 'log', '--first-parent', '--format=%H', ref, '--', path).split('\n').filter(Boolean)) {
    let page;
    try {
      page = JSON.parse(git(root, 'show', `${sha}:${path}`));
    } catch {
      page = undefined;
    }
    yield { sha, page };
  }
}

/** The page path of an index entry: counties/<STATE>/<county>.json (the validator enforces it). */
const pathOf = ({ state, county }) => `${COUNTIES}/${state}/${county}.json`;

/**
 * Lookup `(path, key) => group` of a group as the registry last published it, or undefined when
 * `index` (a parsed index.json) does not list it. With `root` the group comes verbatim from the
 * newest version of the page on HEAD's first-parent history that holds the indexed cid and
 * tables, so fields the index does not carry (`car`) survive; without it, or when history has
 * no such version, it is the index's own { cid, schema, tables }. `.fips(path)` is the page's
 * published fips, the one page-level field a publication can change.
 */
export function publishedGroup(index, root) {
  const entries = new Map((index?.counties ?? []).map((entry) => [pathOf(entry), entry]));
  const lookup = (path, key) => {
    const was = entries.get(path)?.groups?.[key];
    if (!was) return undefined;
    if (root) {
      for (const { page } of pageHistory(root, path)) {
        const g = page?.groups?.[key];
        if (g?.cid === was.cid && g?.tables === was.tables) return g;
      }
    }
    return { cid: was.cid, schema: was.schema, tables: was.tables };
  };
  lookup.fips = (path) => entries.get(path)?.fips;
  return lookup;
}

/** The archive roots the registry published last, newest first, at most `n`: the ones most recently proven pinned and served. */
export function latestPublished(index, n = 3) {
  return (index?.counties ?? [])
    .flatMap((county) => Object.values(county.groups))
    .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
    .slice(0, n)
    .map((g) => g.cid);
}

/** The hold on a group, if any. A hold is { path, county, key, kind, cid, tables, root, reason }. */
export const heldFor = (held, path, key) => held.find((h) => h.path === path && h.key === key);

/** A hold on group `key` of a page entry; cid and tables are the group's as the run saw them. */
export const holdOf = ({ path, page }, key, kind, root, reason) => ({ path, county: `${page.state}/${page.county}`, key, kind, cid: page.groups[key].cid, tables: page.groups[key].tables, root, reason });

/** Whether the registry still owes group `g` a publication: `was` (its published version) does not hold its cid and tables. */
export const isOwed = (was, g) => was?.cid !== g.cid || was?.tables !== g.tables;

/**
 * `pages` with every held group put back to what `published(path, key)` returns, or dropped
 * when it returns nothing (the group was never published). A page left with nothing new on it
 * also gets its published `fips` back (`published.fips`), so nothing of a failed publication
 * stays; while another of its groups is still being published the page's own fips stands, since
 * that publication carries it. Used to write an index that lists only what was transferred, and
 * to withdraw a publication that failed.
 */
export function holdBack(pages, held, published) {
  return pages.map(({ path, page }) => {
    const keys = held.filter((h) => h.path === path).map((h) => h.key);
    if (!keys.length) return { path, page };
    const groups = { ...page.groups };
    for (const key of keys) {
      const g = published(path, key);
      if (g) groups[key] = g;
      else delete groups[key];
    }
    const publishing = groupsOf(page).some(([key, g]) => !keys.includes(key) && isOwed(published(path, key), g));
    const fips = publishing ? undefined : published.fips?.(path);
    return { path, page: { ...page, ...(fips ? { fips } : {}), groups } };
  });
}

/**
 * Lookup `(path, key) => n`: where on `ref`'s first-parent history the group got the cid and
 * tables it has now, as that commit's distance from the root commit (larger is later), or
 * undefined when it cannot be told. Per group, not per page: two groups of one page that claim
 * the same root still have an order. The walk stops at the first older version that differs,
 * a deleted page included, so a publication made again after a withdrawal counts from the
 * second time.
 */
export function claimOrder(root, ref = 'HEAD') {
  const known = new Map(); // one history walk per group, however often the order is asked for
  const find = (path, key) => {
    try {
      let now;
      let since;
      for (const { sha, page } of pageHistory(root, path, ref)) {
        const g = page?.groups?.[key];
        now ??= g;
        if (!g || g.cid !== now.cid || g.tables !== now.tables) break;
        since = sha;
      }
      return since && Number(git(root, 'rev-list', '--first-parent', '--count', since));
    } catch {
      return undefined;
    }
  };
  return (path, key) => {
    const id = `${path} ${key}`;
    if (!known.has(id)) known.set(id, find(path, key));
    return known.get(id);
  };
}

/**
 * Hold every owed group that cannot be published without a root appearing twice, and return
 * `held` with those holds added. Two pull requests can each pass and still merge the same root
 * twice; and a root freed by a superseding publication is taken again when that publication
 * fails. Groups are taken in the order they got their current roots (`claimed(path, key)`,
 * smaller first, see claimOrder; unknown last, then page order). A group whose turn has not
 * come is expected to go through: it blocks nobody, neither with the roots it is giving up
 * (so two groups may exchange roots) nor with the ones it claims (the earlier claim wins).
 * Everything else holds roots: published groups and the ones let through their current roots,
 * held groups the roots of their published version.
 *   - No other group holds any of its roots: the group is let through.
 *   - Another group holds one for good (it is published, was let through, or is withdrawn back to
 *     it): the group is withdrawn. That also turns a group the caller held as deferred into a
 *     withdrawn one: left on main it would duplicate a root there for good.
 *   - The holder may still let go (it is itself deferred, or an earlier group that
 *     waits wants the root too): the group is deferred to the next run.
 * A hold puts a group back on its published roots, which can collide with a group that was let
 * through before it, so the pass is repeated until it changes nothing.
 */
export function holdConflicts(pages, index, held, { claimed = () => undefined } = {}) {
  const published = publishedGroup(index);
  const roots = (group) => (group ? [...new Set([group.cid, group.tables])] : []);
  for (;;) {
    let changed = false;
    const all = pages.flatMap((entry) =>
      groupsOf(entry.page).map(([key, head]) => {
        const was = published(entry.path, key);
        const hold = heldFor(held, entry.path, key);
        // published: not owed. withdrawn: back to its published version for good. waiting: held, but still on main. pending: its turn has not come.
        const status = !isOwed(was, head) ? 'published' : hold ? (hold.kind === 'withdrawn' ? 'withdrawn' : 'waiting') : 'pending';
        return { entry, key, head, was, hold, status };
      }),
    );
    const holds = (x) => (x.status === 'pending' ? [] : roots(x.status === 'published' || x.status === 'through' ? x.head : x.was));
    const turns = all
      .filter((x) => x.status === 'pending' || x.status === 'waiting')
      .map((x) => ({ x, at: claimed(x.entry.path, x.key) ?? Infinity }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map(({ x }) => x);
    const passed = new Set();
    for (const y of turns) {
      const wanted = roots(y.head);
      const blockers = [];
      for (const o of all) {
        if (o === y) continue;
        const taken = holds(o).find((r) => wanted.includes(r));
        const reserved = !taken && o.status === 'waiting' && passed.has(o) && roots(o.head).find((r) => wanted.includes(r));
        if (taken) blockers.push({ o, root: taken, forGood: o.status !== 'waiting' });
        else if (reserved) blockers.push({ o, root: reserved, forGood: false });
      }
      passed.add(y);
      if (!blockers.length) {
        if (y.status === 'pending') y.status = 'through';
        continue;
      }
      const forGood = blockers.find((b) => b.forGood);
      const { root } = forGood ?? blockers[0];
      const reason = `root ${root} is also held by ${blockers.map((b) => `${b.o.entry.path} group ${b.o.key}`).join(', ')}; a root appears once in the registry`;
      if (!y.hold) {
        y.hold = holdOf(y.entry, y.key, forGood ? 'withdrawn' : 'deferred', root, reason);
        held.push(y.hold);
        changed = true;
      } else if (forGood) {
        Object.assign(y.hold, { kind: 'withdrawn', root, reason: y.hold.reason ? `${y.hold.reason}; and ${reason}` : reason });
        changed = true;
      }
      y.status = forGood ? 'withdrawn' : 'waiting';
    }
    if (!changed) return held;
  }
}
