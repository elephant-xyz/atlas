#!/usr/bin/env node
// check-page: validate-entry.mjs on a pull request head that changes only its county page.
import { fileURLToPath } from 'node:url';
import { indexAt, readPages } from '../scripts/lib.mjs';
import { validateRegistry } from '../scripts/validate-entry.mjs';
import { Reason, checkoutPullRequest, runCommand } from './lib.mjs';

export const command = {
  name: 'check-page',
  parameters: [
    { name: 'ATLAS_HEAD_SHA', required: true },
    { name: 'ATLAS_PAGE', required: true },
  ],
  async run({ parameters, work, repository }) {
    const { root, base, refused } = checkoutPullRequest(work, repository, parameters.ATLAS_HEAD_SHA, parameters.ATLAS_PAGE);
    if (refused) return { result: { ok: false, ...refused } };
    const problems = validateRegistry(root, indexAt(base, root));
    for (const problem of problems) console.error(problem);
    if (problems.length) return { result: { ok: false, reason: Reason.INVALID_PAGE, summary: problems.join('\n') } };
    return { result: { ok: true, summary: `ok: ${readPages(root).length} page(s) valid` } };
  },
  deps: {},
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
