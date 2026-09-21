#!/usr/bin/env node
// Regenerate index.json, commit it if it changed, add it to the bucket, point the IPNS name at
// it, and require the name to resolve and the gateway to serve the committed bytes.
// Idempotent: the add is content-addressed, the commit is skipped when unchanged, and the IPNS
// publish is skipped when the name already resolves to the CID (so a re-dispatch after a
// network failure finishes the job). Exits 1 on any failure; nothing here is a revert.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeIndex } from './build-index.mjs';
import { poll, rpc } from './filebase.mjs';

const GATEWAY = (process.env.ATLAS_GATEWAY ?? 'https://ipfs.filebase.io').replace(/\/$/, '');
const KEY = process.env.ATLAS_IPNS_KEY ?? 'elephant-atlas';
const ID = process.env.ATLAS_IPNS_ID ?? 'k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04';
const IPNS_DEADLINE_MS = Number(process.env.ATLAS_IPNS_DEADLINE_MS ?? 600_000);

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

async function resolved() {
  try {
    return (await rpc(`name/resolve?arg=/ipns/${ID}&nocache=true`))[0]?.Path;
  } catch (e) {
    console.log(`name/resolve: ${e.message}`);
    return undefined;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const changed = writeIndex(root);
  const bytes = readFileSync(`${root}/index.json`);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/json' }), 'index.json');
  const [{ Hash: cid }] = await rpc('add?pin=true&cid-version=1&raw-leaves=true', { body: form });
  console.log(`index.json ${changed ? 'updated' : 'unchanged'}; cid ${cid}`);

  if (changed) {
    git(root, 'add', 'index.json');
    git(root, 'commit', '-m', `Publish index.json ${cid} from ${git(root, 'rev-parse', 'HEAD')}`);
    git(root, 'push', 'origin', 'HEAD:main');
    console.log(`committed ${git(root, 'rev-parse', 'HEAD')}`);
  }

  const want = `/ipfs/${cid}`;
  if ((await resolved()) === want) {
    console.log(`ipns ${ID} already resolves to ${want}`);
  } else {
    const [published] = await rpc(`name/publish?arg=${want}&key=${KEY}`, { timeoutMs: 180_000 });
    console.log(`name/publish: ${JSON.stringify(published)}`);
    const path = await resolved();
    if (path !== want) throw new Error(`ipns ${ID} resolves to ${path}, expected ${want}`);
    console.log(`ipns ${ID} resolves to ${path}`);
  }

  const url = `${GATEWAY}/ipns/${ID}?format=raw`;
  const served = await poll(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/vnd.ipld.raw', 'cache-control': 'no-cache' } });
      if (!res.ok) {
        console.log(`${url}: HTTP ${res.status}`);
        return false;
      }
      const body = Buffer.from(await res.arrayBuffer());
      const same = Buffer.compare(body, bytes) === 0;
      console.log(`${url}: ${body.length} bytes, ${same ? 'matches index.json' : 'differs from index.json'}`);
      return same;
    } catch (e) {
      console.log(`${url}: ${e.message}`);
      return false;
    }
  }, { limitMs: IPNS_DEADLINE_MS, intervalMs: 15_000 });
  if (!served) throw new Error(`${url} did not serve the committed index.json within ${IPNS_DEADLINE_MS / 60_000} min`);

  const summary = `Published index.json ${cid} (${changed ? 'updated' : 'unchanged'}); ipns ${ID} -> ${want}; ${GATEWAY}/ipns/${ID}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
