#!/usr/bin/env node
// withdraw: withdraw.mjs's withdraw() for the county's withdrawn holds on its own page. The caller
// opens the Publication reverted issue.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withdraw } from '../scripts/withdraw.mjs';
import { HELD_FILE, WITHDRAWN, checkoutMain, configurePush, runCommand } from './lib.mjs';

/** The page a county's holds must name: counties/<ST>/<name>.json. */
const pageOf = (county) => `counties/${county}.json`;

export const command = {
  name: 'withdraw',
  parameters: [
    { name: 'ATLAS_COUNTY', required: true },
    { name: 'ATLAS_MAIN_SHA', required: true },
  ],
  async run({ parameters, env, work, repository, inputs }, deps) {
    const county = parameters.ATLAS_COUNTY;
    const file = join(inputs, HELD_FILE);
    if (!existsSync(file)) throw new Error(`input ${HELD_FILE} is required: the holds transfer wrote`);
    const held = JSON.parse(readFileSync(file, 'utf8')).filter((h) => h.kind === WITHDRAWN && h.county === county);
    if (!held.length) throw new Error(`${HELD_FILE} names no withdrawn group of ${county}`);
    const elsewhere = held.find((h) => h.path !== pageOf(county));
    if (elsewhere) throw new Error(`${HELD_FILE} holds ${county} ${elsewhere.key} on ${elsewhere.path}, not ${pageOf(county)}; nothing is withdrawn`);
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
