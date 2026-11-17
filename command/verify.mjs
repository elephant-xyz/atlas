#!/usr/bin/env node
// verify: check-page's checks first (validate.yml runs validate-entry before verify-roots), then
// verify-roots.mjs on every group the head changes; the CLI's error CSV is an output.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayList } from '../scripts/gateways.mjs';
import { changedGroups, indexAt, pagesAt, readPages } from '../scripts/lib.mjs';
import { validateRegistry } from '../scripts/validate-entry.mjs';
import { validateCar, verifyGroup } from '../scripts/verify-roots.mjs';
import { Reason, checkoutPullRequest, runCommand } from './lib.mjs';

const VALIDATION_CSV = 'validation-errors.csv';

export const command = {
  name: 'verify',
  parameters: [
    { name: 'ATLAS_HEAD_SHA', required: true },
    { name: 'ATLAS_PAGE', required: true },
    { name: 'ATLAS_GATEWAY_DEADLINE_MINUTES', required: false },
  ],
  async run({ parameters, work, repository }, deps) {
    const { root, base, refused } = checkoutPullRequest(work, repository, parameters.ATLAS_HEAD_SHA, parameters.ATLAS_PAGE);
    if (refused) return { result: { ok: false, ...refused } };
    const problems = validateRegistry(root, indexAt(base, root));
    if (problems.length) return { result: { ok: false, reason: Reason.INVALID_PAGE, summary: ['nothing verified: the page fails check-page', ...problems].join('\n') } };
    const targets = changedGroups(readPages(root), pagesAt(base, root));
    if (!targets.length) return { result: { ok: true, summary: 'no changed groups to verify' } };
    console.log(`gateways, in order: ${gatewayList().join(', ')}`);
    const csv = join(work, VALIDATION_CSV);
    const lines = [];
    let failed = 0;
    for (const t of targets) {
      console.log(`verifying ${t.path} group ${t.key} cid ${t.cid} schema ${t.schema} tables ${t.tables}${t.car ? ` car ${t.car}` : ''}`);
      try {
        await deps.verifyGroup(t, { validateCar: (file) => deps.validateCar(file, csv), csv: VALIDATION_CSV });
        lines.push(`ok ${t.path} group ${t.key}`);
        console.log(lines.at(-1));
      } catch (e) {
        failed++;
        lines.push(`FAIL ${t.path} group ${t.key}: ${e.message}`);
        console.error(lines.at(-1));
      }
    }
    const summary = lines.join('\n');
    const files = existsSync(csv) ? { [VALIDATION_CSV]: readFileSync(csv, 'utf8') } : {};
    return { result: failed ? { ok: false, reason: Reason.GROUP_FAILED, summary } : { ok: true, summary }, files };
  },
  deps: { verifyGroup, validateCar },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
