#!/usr/bin/env node
// publish-index: publish-index.mjs on main as it is now, as publish.yml's index step runs it:
// regenerate index.json from what Filebase lists as pinned, commit and push it through the
// deploy key, add it to the bucket, point the IPNS name at it, and require the gateway to serve
// it. Done once the name serves the index (the script's `cid` output), also when the script
// then exits 1 for groups it left out, such as the county transfer withdrew: those are named in
// the summary, and countyIndexed says whether one was this county's. Publication pending issues
// are not opened here; nothing in the image can.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIndex } from '../scripts/build-index.mjs';
import { IMAGE_ROOT, PUBLICATION_SETTINGS, checkoutMain, configurePush, ended, runCommand, runNode } from './lib.mjs';

const PUBLISH_INDEX = join(IMAGE_ROOT, 'scripts/publish-index.mjs');
/** publish-index.mjs exits 1, after publishing, when a group on main is not in the index. */
const LEFT_OUT_EXIT = 1;
const LEFT_OUT = 'not indexed: ';
/** ATLAS_PENDING_HOURS so large no group is ever old enough for a Publication pending issue. */
const NO_PENDING_ISSUES = 'Infinity';
const GITHUB_OUTPUT = 'github-output';
const STEP_SUMMARY = 'step-summary';

/** The `name=value` lines the script wrote to GITHUB_OUTPUT. */
function outputsOf(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

export const command = {
  name: 'publish-index',
  summary: "publish-index.mjs on main's tip: commit index.json, add it to the bucket, point the IPNS name elephant-atlas at it",
  returns: "{ indexCid, groups: [{ group, archiveCid }], countyIndexed, summary }: groups are the county's groups as the published index lists them; countyIndexed is false when the script left one of them out",
  parameters: [
    { name: 'ATLAS_COUNTY', required: true },
    { name: 'ATLAS_MAIN_SHA', required: true },
  ],
  secrets: { required: ['ATLAS_DEPLOY_KEY', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'], optional: [] },
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
    if (!said.cid) throw new Error(`index.json was not published: publish-index.mjs ended with ${ended(outcome)}${said.indexed === 'true' ? ' after committing it to main' : ''} (see the log)`);
    if (outcome.code !== 0 && !(outcome.code === LEFT_OUT_EXIT && left.length)) throw new Error(`publish-index.mjs ended with ${ended(outcome)} without leaving a group out (see the log)`);
    const entry = readIndex(root)?.counties?.find((c) => `${c.state}/${c.county}` === county);
    const groups = Object.entries(entry?.groups ?? {}).map(([group, g]) => ({ group, archiveCid: g.cid }));
    const published = existsSync(summary) ? readFileSync(summary, 'utf8').trim() : `Published index.json ${said.cid}`;
    const countyIndexed = !left.some((line) => line.startsWith(`${LEFT_OUT}${county} `));
    return { result: { indexCid: said.cid, groups, countyIndexed, summary: [published, ...left].join('\n') } };
  },
  deps: { runScript: runNode },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runCommand(command);
