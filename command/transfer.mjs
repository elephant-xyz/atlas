#!/usr/bin/env node
// transfer: transfer-roots.mjs --county <ST/name> on main as it is now, with publish.yml's
// settings: every root of the county again (pinned ones are skipped) and what other counties are
// owed, which a failure never withdraws. The county's withdrawn hold is the output held.json,
// for withdraw. A county that is only deferred, or a service that is down, is a verdict to try
// again (deferred: true), so nothing is withdrawn and a later run transfers it, as publish.yml
// leaves it for the next run. A hold on a group the index already lists at those roots is no
// part of the publication: it is reported, and does not fail the run.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexAt, isOwed, pagesAt, publishedGroup, rootsOf } from '../scripts/lib.mjs';
import { HELD_FILE, IMAGE_ROOT, PUBLICATION_SETTINGS, Reason, WITHDRAWN, checkoutMain, ended, runCommand, runNode } from './lib.mjs';

const TRANSFER_ROOTS = join(IMAGE_ROOT, 'scripts/transfer-roots.mjs');
/** transfer-roots.mjs exits 1 when it held a group back and 2 when the service was down before the first root. */
const HELD_EXIT = 1;
const OUTAGE_EXIT = 2;

/** One line per hold: `<county> <key> (<kind>): <reason>`. */
const describe = (holds) => holds.map((h) => `${h.county} ${h.key} (${h.kind}): ${h.reason}`).join('; ');

export const command = {
  name: 'transfer',
  summary: "transfer-roots.mjs --county on main's tip: copy every root of the county into the elephant-atlas bucket and require Filebase to pin it",
  returns: '{ ok, reason?, withdraw, deferred, root?, summary }: withdraw is true when the county must come off main (held.json then holds its hold, root is the root that failed); deferred is true when a later run must try again',
  parameters: [
    { name: 'ATLAS_COUNTY', required: true },
    { name: 'ATLAS_MAIN_SHA', required: true },
    { name: 'ATLAS_GATEWAY_DEADLINE_MINUTES', required: false },
  ],
  secrets: { required: ['FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'], optional: ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN'] },
  inputs: [],
  outputs: ['result.json', HELD_FILE],
  /** transfer-roots.mjs's command line, read back through the holds it writes (ATLAS_HELD) and its exit code. */
  async run({ parameters, env, work, repository }, { runScript }) {
    const county = parameters.ATLAS_COUNTY;
    const root = checkoutMain(work, repository, parameters.ATLAS_MAIN_SHA);
    const heldFile = join(work, HELD_FILE);
    const outcome = await runScript(TRANSFER_ROOTS, ['--county', county], { cwd: root, env: { ...env, ...PUBLICATION_SETTINGS, ATLAS_HELD: heldFile } });
    if (outcome.code === OUTAGE_EXIT) return { result: { ok: false, reason: Reason.OUTAGE, withdraw: false, deferred: true, summary: 'nothing transferred: the gateways or Filebase were down before the first root (see the log); nothing is withdrawn' } };
    if (![0, HELD_EXIT].includes(outcome.code) || !existsSync(heldFile)) throw new Error(`transfer-roots.mjs ended with ${ended(outcome)} and wrote no holds`);
    const holds = JSON.parse(readFileSync(heldFile, 'utf8'));
    for (const h of holds.filter((h) => h.county !== county)) console.log(`held, another county's run settles it: ${describe([h])}`);
    const published = publishedGroup(JSON.parse(indexAt('HEAD', root) ?? 'null'));
    const mine = holds.filter((h) => h.county === county);
    const owed = mine.filter((h) => isOwed(published(h.path, h.key), h));
    const stale = mine.filter((h) => !owed.includes(h));
    const withdrawn = owed.filter((h) => h.kind === WITHDRAWN);
    if (withdrawn.length) return { result: { ok: false, reason: Reason.WITHDRAWN, withdraw: true, deferred: false, root: withdrawn[0].root, summary: describe(withdrawn) }, files: { [HELD_FILE]: withdrawn } };
    if (owed.length) return { result: { ok: false, reason: Reason.DEFERRED, withdraw: false, deferred: true, summary: `${describe(owed)}; nothing is withdrawn, a later run transfers it again` } };
    const pages = pagesAt('HEAD', root).filter(({ page }) => `${page.state}/${page.county}` === county);
    const summary = stale.length ? `every root ${county} owes is pinned; already published, but not pinned again: ${describe(stale)}` : `${rootsOf(pages).size} root(s) pinned`;
    return { result: { ok: true, withdraw: false, deferred: false, summary } };
  },
  deps: { runScript: runNode },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
