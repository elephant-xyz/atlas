#!/usr/bin/env node
// Regenerate index.json from every group on HEAD that is publishable: already listed, or with
// both roots pinned in the bucket (asked of Filebase here, not taken from what the transfer step
// reported, so a transfer that failed, crashed, or never ran cannot put a root in the index),
// and not colliding with another group on a root. Exits 1, after publishing the rest, when a
// group on main was left out, and opens a `Publication pending` issue for one left out for more
// than ATLAS_PENDING_HOURS (default 12). Commit it if it changed, add it to the bucket, point the IPNS name at
// it, and require the name to resolve and the gateway to serve the committed bytes.
// Idempotent: the add is content-addressed, the commit is skipped when unchanged, and the IPNS
// publish is skipped when the name already resolves to the CID (so a re-dispatch after a
// network failure finishes the job). Exits 1 on any failure; nothing here is a revert.
// Once the name serves the index it writes GITHUB_OUTPUT cid=<index CID>, which upload-index-s3
// holds its copy to.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIndex, writeIndex } from './build-index.mjs';
import { pinStatus, poll, rpc } from './filebase.mjs';
import { claimOrder, git, gitPublishedAt, groupsOf, holdBack, holdConflicts, holdOf, indexAt, isOwed, latestPublished, pool, publishedGroup, readPages } from './lib.mjs';
import { openIssues, pendingIssues } from './withdraw.mjs';

const GATEWAY = (process.env.ATLAS_GATEWAY || 'https://ipfs.filebase.io').replace(/\/$/, '');
const KEY = process.env.ATLAS_IPNS_KEY ?? 'elephant-atlas';
const ID = process.env.ATLAS_IPNS_ID ?? 'k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04';
const IPNS_DEADLINE_MS = Number(process.env.ATLAS_IPNS_DEADLINE_MS ?? 600_000);

/**
 * What the index may be written from: `pages` with every owed group put back to its published
 * version unless `pinned(cid)` resolves to { pinned: true } for both its roots, and likewise
 * every group that collides with another on a root (see holdConflicts; `claimed` orders them).
 * `left` lists the groups left out, each with the `reason`: they are on main and not published,
 * which the caller must not pass over in silence, least of all when Filebase only failed to
 * answer for a root that is in fact pinned. Four groups are asked about at a time.
 */
export async function publishable(pages, index, { pinned, claimed }) {
  const published = publishedGroup(index);
  const owed = pages.flatMap((entry) => groupsOf(entry.page).filter(([key, g]) => isOwed(published(entry.path, key), g)).map(([key, g]) => ({ entry, key, g })));
  const held = new Array(owed.length);
  await pool(owed.map(({ entry, key, g }, i) => async () => {
    for (const cid of new Set([g.cid, g.tables])) {
      const status = await pinned(cid);
      if (status.pinned) continue;
      held[i] = holdOf(entry, key, 'deferred', cid, `Filebase does not list ${cid} as pinned (${status.why})`);
      return;
    }
  }), 4);
  const left = holdConflicts(pages, index, held.filter(Boolean), { claimed });
  return { pages: holdBack(pages, left, published), left };
}

/**
 * How to ask Filebase whether a root is pinned: three tries each, so one failed call does not
 * leave a transferred county out of the index. Unless Filebase cannot even list one of
 * `canaries`, roots it certainly pins: then it is not answering, and asking about every owed
 * root would only wait out each timeout in turn, so none is asked and all are left out.
 */
export async function pinLookup(canaries, status = pinStatus) {
  for (const cid of canaries) if ((await status(cid)).pinned) return (root) => status(root, { tries: 3 });
  if (!canaries.length) return (root) => status(root, { tries: 3 });
  return async () => ({ pinned: false, why: 'not asked: Filebase does not list the roots it published last either' });
}

/**
 * Refuse to go on unless `bytes` is the index.json main has now: the IPNS name must only ever
 * point at main's index. A checkout that is not main (a dispatch from a branch, a stale clone)
 * regenerates an index of its own, and publishing that would roll consumers back.
 */
export function requireMainIndex(root, bytes) {
  git(root, 'fetch', 'origin', 'main');
  if (indexAt('origin/main', root) !== bytes.toString('utf8')) throw new Error('the index.json here is not the one on main; the IPNS name was not touched. Run publish from main.');
}

/**
 * Push HEAD, the one commit this run made, to main. main moves while a run transfers (another
 * publication merged), so a rejected push is rebased onto the new main and tried again. The
 * commit touches only index.json, which nothing but this workflow writes, one run at a time, so
 * the rebase does not conflict. Refused when the commit under HEAD is not on main: a run
 * dispatched from another branch must not push that branch's commits there.
 */
export function pushToMain(root, attempts = 5) {
  git(root, 'fetch', 'origin', 'main');
  try {
    git(root, 'merge-base', '--is-ancestor', 'HEAD~1', 'origin/main');
  } catch {
    throw new Error('this checkout is not main (the commit under HEAD is not on origin/main); nothing was pushed. Run publish from main.');
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return git(root, 'push', 'origin', 'HEAD:main');
    } catch (e) {
      if (attempt === attempts) throw e;
      git(root, 'fetch', 'origin', 'main');
      git(root, 'rebase', 'origin/main');
    }
  }
}

async function resolved() {
  try {
    return (await rpc(`name/resolve?arg=/ipns/${ID}&nocache=true`))[0]?.Path;
  } catch (e) {
    console.log(`name/resolve: ${e.message}`);
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const index = readIndex(root);
  const { pages, left } = await publishable(readPages(root), index, { pinned: await pinLookup(latestPublished(index)), claimed: claimOrder(root) });
  for (const h of left) console.error(`not indexed: ${h.county} ${h.key} (${h.kind}): ${h.reason}`);
  const changed = writeIndex(root, pages);
  const bytes = readFileSync(`${root}/index.json`);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/json' }), 'index.json');
  const [{ Hash: cid }] = await rpc('add?pin=true&cid-version=1&raw-leaves=true', { body: form });
  console.log(`index.json ${changed ? 'updated' : 'unchanged'}; cid ${cid}`);

  if (changed) {
    git(root, 'add', 'index.json');
    git(root, 'commit', '-m', `Publish index.json ${cid} from ${git(root, 'rev-parse', 'HEAD').trim()}`);
    pushToMain(root);
    console.log(`committed ${git(root, 'rev-parse', 'HEAD').trim()}`);
  }
  requireMainIndex(root, bytes);
  // main has the index: the workflow may now withdraw what the transfer found unpublishable,
  // whether or not the IPNS name and the gateway below keep up.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'indexed=true\n');

  const want = `/ipfs/${cid}`;
  if ((await resolved()) === want) {
    console.log(`ipns ${ID} already resolves to ${want}`);
  } else {
    const [published] = await rpc(`name/publish?arg=${want}&key=${KEY}`, { timeoutMs: 180_000 });
    console.log(`name/publish: ${JSON.stringify(published)}`);
    // name/resolve can lag name/publish by a few seconds on Filebase; poll instead of reading once.
    let path;
    const ok = await poll(async () => {
      path = await resolved();
      if (path !== want) console.log(`ipns ${ID} still resolves to ${path}`);
      return path === want;
    }, { limitMs: IPNS_DEADLINE_MS, intervalMs: 10_000 });
    if (!ok) throw new Error(`ipns ${ID} resolves to ${path}, expected ${want}, after ${IPNS_DEADLINE_MS / 60_000} min`);
    console.log(`ipns ${ID} resolves to ${path}`);
  }

  const url = `${GATEWAY}/ipns/${ID}?format=raw`;
  const served = await poll(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/vnd.ipld.raw', 'cache-control': 'no-cache' } });
      if (!res.ok) {
        console.log(`${url}: HTTP ${res.status}`);
        return false;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const same = Buffer.compare(body, bytes) === 0;
      console.log(`${url}: ${body.length} bytes, ${same ? 'matches index.json' : 'differs from index.json'}`);
      return same;
    } catch (e) {
      console.log(`${url}: ${e.message}`);
      return false;
    }
  }, { limitMs: IPNS_DEADLINE_MS, intervalMs: 15_000 });
  if (!served) throw new Error(`${url} did not serve the committed index.json within ${IPNS_DEADLINE_MS / 60_000} min`);

  const summary = `Published index.json ${cid} (${changed ? 'updated' : 'unchanged'}); ipns ${ID} -> ${want}; ${GATEWAY}/ipns/${ID}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `cid=${cid}\n`);
  // Red whenever main holds a publication the index does not list, whatever the transfer step
  // ended as: nobody should have to notice a missing county on a green run.
  if (left.length) {
    console.error(`${left.length} publication(s) on main are not in the index; the next run tries again (publish-retry starts one, or run publish now)`);
    const olderThan = Date.now() - Number(process.env.ATLAS_PENDING_HOURS ?? 12) * 3_600_000;
    await openIssues(pendingIssues(left, process.env.RUN_URL, { since: gitPublishedAt(root, 'HEAD'), olderThan }));
    process.exit(1);
  }
}
