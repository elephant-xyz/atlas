#!/usr/bin/env node
// Take the publications the transfer withdrew (ATLAS_HELD, kind `withdrawn`) off main and open an
// issue for each. A withdrawal is not a `git revert`: each failed group is put back to what the
// registry last published (the index's cid and tables, the group taken verbatim from history) or
// removed when it was never published or another group holds those roots by now, a page with a held group gets its published `fips` back,
// and a page left without groups is deleted. That cannot
// conflict with a later merge to the same page, leaves the page's other groups alone, and always
// ends at the published state, so repeating it changes nothing.
//
// main moves while a run works, so the edit is made on main as it is now and redone when the
// push is rejected. A group that no longer holds the roots this run saw was changed by someone
// since and is left alone, and so is one the index lists after all. The commit carries
// [skip ci]: the workflow runs this only after the index step published, and whatever is still
// owed is picked up by the next run (a merge, a dispatch, or the schedule).
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readIndex } from './build-index.mjs';
import { redactGateways } from './gateways.mjs';
import { git, groupsOf, holdBack, isOwed, publishedGroup, readPages, rootsOf, sleep as wait } from './lib.mjs';

/** Withdraw `held` groups on origin/main; returns { sha, done } (sha undefined when nothing was left to withdraw). */
export function withdraw(root, held, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    git(root, 'fetch', 'origin', 'main');
    git(root, 'reset', '--hard', 'origin/main');
    const pages = readPages(root);
    const index = readIndex(root);
    // Still the publication this run saw, and still not in the index: the index step asks
    // Filebase itself, and a group it listed after all is published, not withdrawn.
    const done = held.filter((h) => {
      const g = pages.find((p) => p.path === h.path)?.page.groups?.[h.key];
      return g && g.cid === h.cid && g.tables === h.tables && isOwed(publishedGroup(index)(h.path, h.key), g);
    });
    // A group goes back to its published roots only if main has not given them to another group
    // in the meantime (a merge during this run, valid when it was made): then it is dropped
    // instead, and nobody else's publication becomes a duplicate.
    const published = publishedGroup(index, root);
    const taken = rootsOf(holdBack(pages, done, () => undefined));
    const free = (path, key) => {
      const g = published(path, key);
      return g && !taken.has(g.cid) && !taken.has(g.tables) ? g : undefined;
    };
    free.fips = published.fips;
    for (const { path, page } of holdBack(pages, done, free)) {
      if (!done.some((h) => h.path === path)) continue;
      if (groupsOf(page).length) writeFileSync(`${root}/${path}`, JSON.stringify(page, null, 2) + '\n');
      else rmSync(`${root}/${path}`);
    }
    if (!git(root, 'status', '--porcelain', '--', 'counties').trim()) return { done: [] };
    git(root, 'add', '-A', 'counties');
    git(root, 'commit', '-m', `Withdraw ${done.map((h) => `${h.county} ${h.key}`).join(', ')}: not publishable [skip ci]`);
    try {
      git(root, 'push', 'origin', 'HEAD:main');
      return { sha: git(root, 'rev-parse', 'HEAD').trim(), done };
    } catch (e) {
      if (attempt === attempts) throw e;
    }
  }
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/**
 * Open `issues` ([{ title, body }]); returns the titles that could not be opened. Each is tried
 * three times and one failing does not stop the others: after a withdrawal is pushed a re-run
 * finds nothing to withdraw, so this is the only time an author can be told. Bodies are posted
 * in public, so private gateway origins are taken out of them.
 */
export async function openIssues(issues, { create = (title, body) => gh('issue', 'create', '--title', title, '--body', body), sleep = wait, error = console.error } = {}) {
  const unopened = [];
  for (const { title, body: text } of issues) {
    const body = redactGateways(text);
    for (let attempt = 1; ; attempt++) {
      try {
        create(title, body);
        break;
      } catch (e) {
        if (attempt < 3) {
          await sleep(15_000);
          continue;
        }
        unopened.push(title);
        // An annotation on the run, with everything needed to open the issue by hand.
        error(`::error title=Issue not opened: ${title}::${`${e.message}. Open it by hand: ${body}`.replaceAll('\n', '%0A')}`);
        break;
      }
    }
  }
  return unopened;
}

/** The issue for a group taken off main. */
export const revertedIssue = (h, sha, runUrl) => ({
  title: `Publication reverted: ${h.county} ${h.root}`,
  body: `The publish workflow could not publish \`${h.root}\` (${h.county}, group \`${h.key}\`) into the \`elephant-atlas\` bucket.\n\n- reason: ${h.reason}\n- withdrawn from \`main\` in ${sha}\n- run: ${runUrl}\n\nFix the cause (re-upload the archive and confirm a public gateway serves it, or use a root no other page holds), then open a new pull request.`,
});

/**
 * The issues for groups that have sat on main unpublished since before `olderThan` (a time in
 * ms; `since(path, cid)` is when main got the root), less the ones that already have an open
 * issue (`isOpen(title)`). A group that is only deferred is tried again by every run and never
 * taken off main, so without this nobody is told when it never gets through.
 */
export function pendingIssues(left, runUrl, { since, olderThan, isOpen = (title) => gh('issue', 'list', '--state', 'open', '--search', `"${title}" in:title`, '--json', 'title', '--jq', '.[].title').split('\n').includes(title) }) {
  return left
    .filter((h) => h.kind !== 'withdrawn' && Date.parse(since(h.path, h.cid) ?? '') < olderThan)
    .map((h) => ({
      title: `Publication pending: ${h.county} ${h.key}`,
      body: `\`${h.cid}\` (${h.county}, group \`${h.key}\`) has been on \`main\` since ${since(h.path, h.cid)} and is not published.\n\n- last reason: ${h.reason}\n- run: ${runUrl}\n\nEvery publish run tries it again and it stays on \`main\` meanwhile. If the reason does not go away by itself it needs a person: fix what the reason names, or take the publication off \`main\` with a pull request.`,
    }))
    .filter(({ title }) => !isOpen(title));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const held = JSON.parse(readFileSync(process.env.ATLAS_HELD, 'utf8')).filter((h) => h.kind === 'withdrawn');
  const { sha, done } = withdraw(process.cwd(), held);
  console.log(sha ? `withdrew ${done.map((h) => `${h.county} ${h.key}`).join(', ')} in ${sha}` : 'nothing left to withdraw on main');
  const unopened = await openIssues(done.map((h) => revertedIssue(h, sha, process.env.RUN_URL)));
  if (unopened.length) process.exit(1);
}
