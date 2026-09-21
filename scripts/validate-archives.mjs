#!/usr/bin/env node
// Full validation of every archive a pull request adds: for each group whose cid is new
// relative to origin/main (or every group with --all), stream `<cid>?format=car` from the first
// gateway that answers to a temp file and run `elephant-cli validate` on it, which checks every
// block hashes to its CID, the root, the index, every link, every data-group root, and every
// property against the lexicon schemas. Exit 0 requires every check clean. The error CSV is left
// at ATLAS_VALIDATION_CSV (default validation-errors.csv) for the workflow to upload; the CAR is
// deleted after validation. The CLI comes from ELEPHANT_CLI (default: elephant-cli on PATH).
import { spawnSync } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fetchFromAny, gatewayList } from './gateways.mjs';
import { newArchives, pagesAt, readPages } from './lib.mjs';

const CLI = process.env.ELEPHANT_CLI ?? 'elephant-cli';
const CSV = process.env.ATLAS_VALIDATION_CSV ?? 'validation-errors.csv';

/** Run the CLI on a CAR; returns { ok, report } where report is the CLI's stdout/stderr. */
export function validateCar(file, csv, cli = CLI, run = spawnSync) {
  const r = run(cli, ['validate', file, '--output-csv', csv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const report = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => l && !/browserslist|update-browserslist-db|unknown format/i.test(l)).join('\n');
  return { ok: r.status === 0, report: r.error ? `${r.error.message}\n${report}` : report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const all = process.argv.includes('--all');
  const targets = newArchives(readPages(root), all ? null : pagesAt('origin/main', root));
  if (!targets.length) console.log('no new archives to validate');
  else console.log(`gateways, in order: ${gatewayList().join(', ')}`);
  let failed = 0;
  for (const t of targets) {
    console.log(`validating ${t.path} group ${t.key} archive ${t.cid}`);
    const dir = await mkdtemp(join(tmpdir(), 'atlas-validate-'));
    const file = join(dir, `${t.cid}.car`);
    try {
      const { res, url } = await fetchFromAny(`${t.cid}?format=car`, { headers: { accept: 'application/vnd.ipld.car' }, requestMs: 60 * 60_000 });
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
      console.log(`downloaded ${url} (${statSync(file).size} bytes)`);
      const { ok, report } = validateCar(file, CSV);
      console.log(report);
      if (ok) console.log(`ok ${t.path} group ${t.key}: archive ${t.cid} validates clean`);
      else {
        failed++;
        console.error(`FAIL ${t.path} group ${t.key}: archive ${t.cid} did not validate; see ${CSV}`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${t.path} group ${t.key}: ${e.message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}
