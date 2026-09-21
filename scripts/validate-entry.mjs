#!/usr/bin/env node
// Validate every county page under counties/ and the committed index.json.
// Prints one line per problem and exits 1 if there are any.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { CID } from 'multiformats/cid';
import { checkIndex } from './build-index.mjs';
import { groupsOf, pagesAt, readPages } from './lib.mjs';

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
  const seen = new Map(); // cid -> where it was first used
  for (const { path, page } of pages) {
    const say = (msg) => problems.push(`${path}: ${msg}`);
    if (!validateSchema(page)) {
      for (const e of validateSchema.errors) say(`${e.instancePath || '/'} ${e.message}`);
      continue;
    }
    if (path !== `counties/${page.state}/${page.county}.json`) say(`path must be counties/${page.state}/${page.county}.json`);
    for (const [key, g] of groupsOf(page)) {
      for (const field of ['cid', 'schema', 'tables']) {
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
  problems.push(...checkIndex(root, basePages ?? pages));
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const problems = validateRegistry(root, pagesAt('origin/main', root));
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(`ok: ${readPages(root).length} page(s) valid`);
}
