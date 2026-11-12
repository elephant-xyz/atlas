#!/usr/bin/env node
// Validate every county page under counties/ and the committed index.json.
// Prints one line per problem and exits 1 if there are any.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { CID } from 'multiformats/cid';
import { baseRef, groupsOf, indexAt, readPages, refExists } from './lib.mjs';

const schema = JSON.parse(readFileSync(new URL('../schema/entry.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ allErrors: true }).compile(schema);

/**
 * Problems with index.json on a pull request: it must be the file main has, byte for byte, line
 * endings aside, because only the publish workflow writes it. `baseIndex` is that file's text,
 * null when main has no index.json yet (then the pull request must not add one), and undefined
 * when there is no main to compare with, which is a problem in itself: the check is the only
 * guard on a hand edit, so it is never skipped. It is not compared with a regeneration from the
 * pages: main's index lags main's pages while a publication is transferred or waits for another
 * run, and a pull request is not at fault for that.
 */
export function checkIndexUntouched(root, baseIndex) {
  if (baseIndex === undefined) return ['index.json: cannot be checked, origin/main is not in this checkout; run `git fetch origin main`'];
  // A checkout with core.autocrlf has CRLF on disk and LF in the commit.
  const text = (s) => s.replaceAll('\r\n', '\n');
  const file = `${root}/index.json`;
  const mine = existsSync(file) ? text(readFileSync(file, 'utf8')) : null;
  if (mine === (baseIndex === null ? null : text(baseIndex))) return [];
  return ['index.json: differs from the one on main; never edit it by hand, it is generated on merge'];
}

/**
 * Problems across the whole registry rooted at `root`. `baseIndex` is main's index.json, which a
 * pull request must not change (see checkIndexUntouched for null and undefined).
 */
export function validateRegistry(root, baseIndex) {
  const problems = [];
  let pages;
  try {
    pages = readPages(root);
  } catch (e) {
    return [`counties/: ${e.message}`];
  }
  const seen = new Map(); // cid -> where it was first used
  for (const { path, page } of pages) {
    const say = (msg) => problems.push(`${path}: ${msg}`);
    if (!validateSchema(page)) {
      for (const e of validateSchema.errors) say(`${e.instancePath || '/'} ${e.message}`);
      continue;
    }
    if (path !== `counties/${page.state}/${page.county}.json`) say(`path must be counties/${page.state}/${page.county}.json`);
    for (const [key, g] of groupsOf(page)) {
      for (const field of ['cid', 'schema', 'tables', ...(g.car === undefined ? [] : ['car'])]) {
        try {
          CID.parse(g[field]);
        } catch {
          say(`groups.${key}.${field} is not a valid CID`);
        }
      }
      for (const field of ['cid', 'tables']) {
        const where = `${path} groups.${key}.${field}`;
        if (seen.has(g[field])) say(`groups.${key}.${field} ${g[field]} is already used by ${seen.get(g[field])}`);
        else seen.set(g[field], where);
      }
    }
  }
  problems.push(...checkIndexUntouched(root, baseIndex));
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const base = baseRef(root);
  const problems = validateRegistry(root, refExists(root, base) ? indexAt(base, root) : undefined);
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(`ok: ${readPages(root).length} page(s) valid`);
}
