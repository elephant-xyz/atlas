#!/usr/bin/env node
// Validate every county page under counties/ and the committed index.json.
// Prints one line per problem and exits 1 if there are any.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
    for (const run of page.runs) {
      const dir = `evidence/${page.state}/${page.county}/${run.county_root}/`;
      for (const [kind, ref] of Object.entries(run.evidence)) {
        if (/^b[a-z2-7]{50,}$/.test(ref)) continue;
        if (isAbsolute(ref) || ref.split('/').includes('..')) say(`run ${run.county_root} evidence.${kind} must be a CID or a repository-relative path`);
        else if (!ref.startsWith(dir)) say(`run ${run.county_root} evidence.${kind} must live under ${dir}`);
        else if (!existsSync(join(root, ref))) say(`run ${run.county_root} evidence.${kind} ${ref} is not in the repository`);
      }
      for (const key of ['county_root', 'tables_root']) {
        const cid = run[key];
        if (!cid) continue;
        try {
          CID.parse(cid);
        } catch {
          say(`run ${run.county_root} ${key} is not a valid CID`);
        }
        if (run.status === 'withdrawn') continue; // a withdrawn run releases its roots
        if (roots.has(cid)) say(`${key} ${cid} is already published by ${roots.get(cid)}; the same root is the same publication`);
        else roots.set(cid, `${path} run ${run.county_root}`);
      }
    }
  }
  if (basePages) problems.push(...checkAppendOnly(pages, basePages));
  problems.push(...checkIndex(root, basePages ?? pages));
  return problems;
}

/** Runs already on main are history: by position, they may change `status`, nothing else, and never disappear. */
export function checkAppendOnly(pages, basePages) {
  const problems = [];
  const current = new Map(pages.map(({ path, page }) => [path, page]));
  const frozen = ({ status, ...rest }) => JSON.stringify(rest); // ponytail: key order counts as a change
  for (const { path, page: base } of basePages) {
    if (!validateSchema(base)) continue; // schema migration: the base predates the current schema, so the pull request must rewrite it
    const now = current.get(path);
    if (!now) {
      problems.push(`${path}: page was deleted; pages are never removed`);
      continue;
    }
    base.runs.forEach((baseRun, i) => {
      const run = now.runs?.[i];
      if (!run) problems.push(`${path}: run ${baseRun.county_root} was removed; runs are append-only`);
      else if (frozen(run) !== frozen(baseRun)) problems.push(`${path}: run ${i} (${baseRun.county_root}) was edited in place; only status may change, supersede it instead`);
    });
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
