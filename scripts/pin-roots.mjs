#!/usr/bin/env node
// Pin every root that this push published: every group cid and tables root at HEAD that no
// group held at HEAD~1 (first parent). Roots only;
// the recursive pin covers everything beneath. Exits 1 with GITHUB_OUTPUT failed_root/
// failed_status/county when a pin fails or times out (the workflow reverts), 2 on any other
// error (credentials, network; re-dispatch instead).
//
// TODO: unpin roots of withdrawn runs; nothing is unpinned yet.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PinFailed, rpc, waitForPin } from './filebase.mjs';
import { groupsOf, pagesAt, rootsOf } from './lib.mjs';

/** [{ county: 'FL/lee', key, cid }] for every archive or tables root at HEAD that no group at base held. */
export function rootsToPin(headPages, basePages) {
  const known = rootsOf(basePages);
  const out = [];
  for (const { page } of headPages) {
    for (const [key, g] of groupsOf(page)) {
      for (const field of ['cid', 'tables']) if (!known.has(g[field])) out.push({ county: `${page.state}/${page.county}`, key: `${key}.${field}`, cid: g[field] });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const targets = rootsToPin(pagesAt('HEAD', root), pagesAt('HEAD~1', root) ?? []);
  if (!targets.length) console.log('no new roots to pin');
  const limitMs = Number(process.env.ATLAS_PIN_LIMIT_MINUTES ?? 45) * 60_000;
  for (const t of targets) {
    console.log(`pinning ${t.county} ${t.key} ${t.cid} (limit ${limitMs / 60_000} min)`);
    try {
      await rpc(`pin/add?arg=${t.cid}&recursive=true`);
    } catch (e) {
      console.log(`pin/add ${t.cid}: ${e.message}; polling the pin status anyway`);
    }
    try {
      await waitForPin(t.cid, { limitMs });
    } catch (e) {
      if (!(e instanceof PinFailed)) {
        console.error(e.message);
        process.exit(2);
      }
      console.error(`FAIL ${t.county} ${t.key}: ${e.message}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `failed_root=${t.cid}\nfailed_status=${e.status}\ncounty=${t.county}\n`);
      process.exit(1);
    }
  }
}
