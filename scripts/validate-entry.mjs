#!/usr/bin/env node
// Validate every county page under counties/ and the committed index.json.
// Prints one line per problem and exits 1 if there are any.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { CID } from 'multiformats/cid';
import { checkIndex } from './build-index.mjs';
import { pagesAt, readPages } from './lib.mjs';

const schema = JSON.parse(readFileSync(new URL('../schema/entry.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

/** Problems across the whole registry rooted at `root`. `basePages` is what main holds, for the index check. */
export function validateRegistry(root, basePages) {
  const problems = [];
  let pages;
  try {
    pages = readPages(root);
  } catch (e) {
    return [`counties/: ${e.message}`];
  }
  const roots = new Map(); // cid -> first location
  for (const { path, page } of pages) {
    const say = (msg) => problems.push(`${path}: ${msg}`);
    if (!validateSchema(page)) {
      for (const e of validateSchema.errors) say(`${e.instancePath || '/'} ${e.message}`);
      continue;
    }
    if (path !== `counties/${page.state}/${page.county}.json`) say(`path must be counties/${page.state}/${page.county}.json`);
    const ids = new Set();
    let prev = '';
    for (const run of page.runs) {
      if (ids.has(run.run)) say(`run ${run.run} appears twice`);
      ids.add(run.run);
      if (run.run <= prev) say(`run ${run.run} is not after ${prev}; runs must be ascending`);
      prev = run.run;
      for (const key of ['county_root', 'tables_root']) {
        const cid = run[key];
        if (!cid) continue;
        try {
          CID.parse(cid);
        } catch {
          say(`run ${run.run} ${key} is not a valid CID`);
        }
        const where = `${path} run ${run.run} ${key}`;
        if (roots.has(cid)) say(`run ${run.run} ${key} ${cid} already used by ${roots.get(cid)}`);
        else roots.set(cid, where);
      }
    }
    if (page.latest !== undefined) {
      const latest = page.runs.find((r) => r.run === page.latest);
      if (!latest) say(`latest ${page.latest} is not a run on this page`);
      else if (latest.status === 'withdrawn') say(`latest ${page.latest} is withdrawn`);
    }
  }
  if (basePages) problems.push(...checkAppendOnly(pages, basePages));
  problems.push(...checkIndex(root, basePages ?? pages));
  return problems;
}

/** Runs already on main are history: they may change `status`, nothing else, and never disappear. */
export function checkAppendOnly(pages, basePages) {
  const problems = [];
  const current = new Map(pages.map(({ path, page }) => [path, page]));
  const frozen = ({ status, ...rest }) => JSON.stringify(rest); // ponytail: key order counts as a change
  for (const { path, page: base } of basePages) {
    const now = current.get(path);
    if (!now) {
      problems.push(`${path}: page was deleted; pages are never removed`);
      continue;
    }
    for (const baseRun of base.runs) {
      const run = now.runs?.find((r) => r.run === baseRun.run);
      if (!run) problems.push(`${path}: run ${baseRun.run} was removed; runs are append-only`);
      else if (frozen(run) !== frozen(baseRun)) problems.push(`${path}: run ${baseRun.run} was edited in place; only status may change, supersede it instead`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const problems = validateRegistry(root, pagesAt('origin/main', root));
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(`ok: ${readPages(root).length} page(s) valid`);
}
