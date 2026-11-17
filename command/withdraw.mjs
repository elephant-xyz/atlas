#!/usr/bin/env node
// withdraw: take the county's withdrawn group off main with withdraw() from withdraw.mjs (back to
// what was last published, or removed; never a revert), pushed through the deploy key. Its
// input is the held.json transfer wrote. When main no longer holds what failed (a new version
// of the page merged, or the index lists it after all), withdraw.mjs leaves it alone and so does
// this: a finished run with withdrawn false. The `Publication reverted` issue is the caller's to
// open (System, through Connect), and only when withdrawn is true; withdraw.mjs's own command
// line would open it with gh.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withdraw } from '../scripts/withdraw.mjs';
import { HELD_FILE, WITHDRAWN, checkoutMain, configurePush, runCommand } from './lib.mjs';

export const command = {
  name: 'withdraw',
  summary: "withdraw.mjs's withdraw() on main: put the county's withdrawn group back to what was last published, and push",
  returns: '{ withdrawn, commitSha, root, summary }: whether it came off main, the commit that took it off (null when not), the root that failed, what was withdrawn and why',
  parameters: [
    { name: 'ATLAS_COUNTY', required: true },
    { name: 'ATLAS_MAIN_SHA', required: true },
  ],
  secrets: { required: ['ATLAS_DEPLOY_KEY'], optional: [] },
  inputs: [HELD_FILE],
  outputs: ['result.json'],
  /** withdraw() on a checkout of main, for the county's withdrawn holds only. */
  async run({ parameters, env, work, repository, inputs }, deps) {
    const county = parameters.ATLAS_COUNTY;
    const file = join(inputs, HELD_FILE);
    if (!existsSync(file)) throw new Error(`input ${HELD_FILE} is required: the holds transfer wrote`);
    const held = JSON.parse(readFileSync(file, 'utf8')).filter((h) => h.kind === WITHDRAWN && h.county === county);
    if (!held.length) throw new Error(`${HELD_FILE} names no withdrawn group of ${county}`);
    const root = checkoutMain(work, repository, parameters.ATLAS_MAIN_SHA);
    configurePush(root, work, repository, env);
    const { sha, done } = deps.withdraw(root, held);
    if (!sha) {
      const summary = `Nothing left to withdraw on main for ${county}: main no longer holds the roots that failed, or the index lists them.`;
      console.log(summary);
      return { result: { withdrawn: false, commitSha: null, root: held[0].root, summary } };
    }
    console.log(`withdrew ${done.map((h) => `${h.county} ${h.key}`).join(', ')} in ${sha}`);
    return { result: { withdrawn: true, commitSha: sha, root: done[0].root, summary: done.map((h) => `Withdrew ${h.county} ${h.key}: ${h.reason}.`).join(' ') } };
  },
  deps: { withdraw },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
