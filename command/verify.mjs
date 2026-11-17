#!/usr/bin/env node
// verify: Atlas's archive checks on a pull request's head: verifyGroup from verify-roots.mjs on
// every group whose cid, schema, tables or car differ from the merge base, as that script's own
// command line runs it (the archive by root, elephant-cli validate, the shape and schema claim,
// the schema, tables and every Parquet part by CID). The CLI's error CSV is the output
// validation-errors.csv. A group that fails is a result (ok: false), not an error.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayList } from '../scripts/gateways.mjs';
import { changedGroups, pagesAt, readPages } from '../scripts/lib.mjs';
import { validateCar, verifyGroup } from '../scripts/verify-roots.mjs';
import { checkoutPullRequest, runCommand } from './lib.mjs';

const VALIDATION_CSV = 'validation-errors.csv';

export const command = {
  name: 'verify',
  summary: "verify-roots.mjs (with the image's elephant-cli) on every group the pull request's head changes against its merge base",
  returns: '{ ok, summary }: summary has one `ok <page> group <key>` or `FAIL <page> group <key>: <reason>` line per group',
  parameters: [
    { name: 'ATLAS_HEAD_SHA', required: true },
    { name: 'ATLAS_PAGE', required: true },
    { name: 'ATLAS_GATEWAY_DEADLINE_MINUTES', required: false },
  ],
  secrets: { required: [], optional: ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN'] },
  inputs: [],
  outputs: ['result.json', VALIDATION_CSV],
  /** verify-roots.mjs's command line, on a checkout of the head, with the CSV in the outputs. */
  async run({ parameters, work, repository, outputs }, deps) {
    const { root, base } = checkoutPullRequest(work, repository, parameters.ATLAS_HEAD_SHA, parameters.ATLAS_PAGE);
    const targets = changedGroups(readPages(root), pagesAt(base, root));
    if (!targets.length) return { result: { ok: true, summary: 'no changed groups to verify' } };
    console.log(`gateways, in order: ${gatewayList().join(', ')}`);
    const csv = join(outputs, VALIDATION_CSV);
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
    return { result: { ok: failed === 0, summary: lines.join('\n') } };
  },
  deps: { verifyGroup, validateCar },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
