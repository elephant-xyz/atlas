#!/usr/bin/env node
// publish-index: publish-index.mjs on main as it is now, as publish.yml's index step runs it:
// regenerate index.json from what Filebase lists as pinned, commit and push it through the
// deploy key, add it to the bucket, point the IPNS name at it, and require the gateway to serve
// it. A finished run once index.json is on main (the script's `indexed` output): ok when the name
// serves it (the `cid` output) with every group of the county in it; a county left out, such as
// the one transfer withdrew, or an index the name does not serve yet, is ok: false with its
// reason, and the caller still runs withdraw. An index that never reached main is an error.
// Publication pending issues are not opened here; nothing in the image can.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndex } from '../scripts/build-index.mjs';
import { IMAGE_ROOT, PUBLICATION_SETTINGS, Reason, checkoutMain, configurePush, ended, runCommand, runNode } from './lib.mjs';

const PUBLISH_INDEX = join(IMAGE_ROOT, 'scripts/publish-index.mjs');
/** publish-index.mjs exits 1, after publishing, when a group on main is not in the index. */
const LEFT_OUT_EXIT = 1;
const LEFT_OUT = 'not indexed: ';
/** ATLAS_PENDING_HOURS so large no group is ever old enough for a Publication pending issue. */
const NO_PENDING_ISSUES = 'Infinity';
const GITHUB_OUTPUT = 'github-output';
const STEP_SUMMARY = 'step-summary';
const INDEXED = 'true';

/** The `name=value` lines the script wrote to GITHUB_OUTPUT. */
function outputsOf(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

export const command = {
  name: 'publish-index',
  parameters: [
    { name: 'ATLAS_COUNTY', required: true },
    { name: 'ATLAS_MAIN_SHA', required: true },
  ],
  inputs: [],
  outputs: ['result.json'],
  /** publish-index.mjs's command line, read back through its GITHUB_OUTPUT, its step summary and the index it committed. */
  async run({ parameters, env, work, repository }, { runScript }) {
    const county = parameters.ATLAS_COUNTY;
    const root = checkoutMain(work, repository, parameters.ATLAS_MAIN_SHA);
    configurePush(root, work, repository, env);
    const output = join(work, GITHUB_OUTPUT);
    const summary = join(work, STEP_SUMMARY);
    const outcome = await runScript(PUBLISH_INDEX, [], { cwd: root, env: { ...env, ...PUBLICATION_SETTINGS, ATLAS_PENDING_HOURS: NO_PENDING_ISSUES, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    const said = outputsOf(output);
    const left = outcome.stderr.filter((line) => line.startsWith(LEFT_OUT));
    if (said.indexed !== INDEXED) throw new Error(`index.json did not reach main: publish-index.mjs ended with ${ended(outcome)} (see the log)`);
    if (said.cid && outcome.code !== 0 && !(outcome.code === LEFT_OUT_EXIT && left.length)) throw new Error(`publish-index.mjs ended with ${ended(outcome)} without leaving a group out (see the log)`);
    const entry = readIndex(root)?.counties?.find((c) => `${c.state}/${c.county}` === county);
    const groups = Object.entries(entry?.groups ?? {}).map(([group, g]) => ({ group, archiveCid: g.cid }));
    const countyIndexed = !left.some((line) => line.startsWith(`${LEFT_OUT}${county} `));
    const indexCid = said.cid ?? null;
    const reason = !indexCid ? Reason.NOT_SERVED : !countyIndexed ? Reason.COUNTY_LEFT_OUT : undefined;
    const published = !indexCid ? `index.json is on main, but publish-index.mjs ended with ${ended(outcome)} before the IPNS name served it (see the log)` : existsSync(summary) ? readFileSync(summary, 'utf8').trim() : `Published index.json ${indexCid}`;
    return { result: { ok: !reason, ...(reason ? { reason } : {}), indexed: true, indexCid, groups, countyIndexed, summary: [published, ...left].join('\n') } };
  },
  deps: { runScript: runNode },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
