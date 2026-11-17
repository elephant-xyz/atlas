#!/usr/bin/env node
// check-page: Atlas's page checks on a pull request's head, compared with its merge base:
// validateRegistry from validate-entry.mjs, run as that script's own command line runs it, so
// the rules and their wording stay the script's. A page that fails is a result (ok: false), not
// an error; an error is anything that keeps the checks from running.
import { fileURLToPath } from 'node:url';
import { indexAt, readPages } from '../scripts/lib.mjs';
import { validateRegistry } from '../scripts/validate-entry.mjs';
import { checkoutPullRequest, runCommand } from './lib.mjs';

export const command = {
  name: 'check-page',
  summary: "validate-entry.mjs on the pull request's head against its merge base: schema, path, CIDs, roots used once, index.json untouched",
  returns: '{ ok, summary }: summary is the ok line, or every problem, one per line',
  parameters: [
    { name: 'ATLAS_HEAD_SHA', required: true },
    { name: 'ATLAS_PAGE', required: true },
  ],
  secrets: { required: [], optional: [] },
  inputs: [],
  outputs: ['result.json'],
  /** The checks of validate-entry.mjs's command line, on a checkout of the head. */
  async run({ parameters, work, repository }) {
    const { root, base } = checkoutPullRequest(work, repository, parameters.ATLAS_HEAD_SHA, parameters.ATLAS_PAGE);
    const problems = validateRegistry(root, indexAt(base, root));
    for (const problem of problems) console.error(problem);
    if (problems.length) return { result: { ok: false, summary: problems.join('\n') } };
    return { result: { ok: true, summary: `ok: ${readPages(root).length} page(s) valid` } };
  },
  deps: {},
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
