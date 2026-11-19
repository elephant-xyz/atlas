import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { command as checkPage } from '../command/check-page.mjs';
import { command as verify } from '../command/verify.mjs';
import { command as transfer } from '../command/transfer.mjs';
import { command as publishIndex } from '../command/publish-index.mjs';
import { command as withdraw } from '../command/withdraw.mjs';
import { COUNTY_PATTERN, SECRET_NAMES, runCommand, runNode } from '../command/lib.mjs';
import { token as filebaseToken } from '../scripts/filebase.mjs';
import { buildEntries } from '../scripts/lib.mjs';
import { CID_A, CID_B, CID_C, CID_D, group, page } from './helpers.mjs';

const CONFIGURATIONS = ['atlas-command-validation-public', 'atlas-command-validation', 'atlas-command-transfer', 'atlas-command-index', 'atlas-command-withdrawal'].map((id) => JSON.parse(readFileSync(new URL(`../command/${id}.json`, import.meta.url), 'utf8')));
const MAX_RESULT_BYTES = 60_000;
const MAX_SUMMARY_CHARACTERS = 16_000;
const SHORTENED = /\n… \(shortened to fit the result; the run's log has all of it\)$/;

const HENNEPIN = 'counties/MN/hennepin.json';
const LEE = 'counties/FL/lee.json';
const hennepin = (overrides = {}) => page({ county: 'hennepin', state: 'MN', fips: '27053', ...overrides });
const lee = page({ groups: { county: group({ cid: CID_C, tables: CID_D }) } });
const indexOf = (...pages) => ({ version: 1, generated_from: 'x', counties: buildEntries(pages.map((page) => ({ page })), () => undefined) });
const PRIVATE_GATEWAY = 'https://private-gateway.test';
const SECRETS = { ATLAS_GATEWAYS: PRIVATE_GATEWAY, ATLAS_GATEWAY_TOKEN: 'gateway-token-value', FILEBASE_ACCESS_KEY: 'filebase-access-value', FILEBASE_SECRET_KEY: 'filebase-secret-value', ATLAS_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-deploy-key\n-----END OPENSSH PRIVATE KEY-----' };
const withdrawnHold = (overrides = {}) => ({ path: HENNEPIN, county: 'MN/hennepin', key: 'county', kind: 'withdrawn', cid: CID_A, tables: CID_B, root: CID_A, reason: `/ipfs/${CID_A}?format=car not available from any gateway within 20 min`, ...overrides });

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LINK = Symbol('link');
/** A change that commits a path as a symbolic link to `target`. */
const symlinkTo = (target) => ({ [LINK]: target });

/**
 * A local stand-in for github.com/elephant-xyz/atlas whose main holds `files`; its first commit is
 * the revision the image under test was built from. A pull request's head is pushed to
 * refs/pull/<n>/head and fetchable by SHA, as on GitHub.
 */
function atlasRemote(files) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-remote-'));
  const url = join(dir, 'atlas.git');
  const dev = join(dir, 'dev');
  g(dir, 'init', '-q', '--bare', '-b', 'main', url);
  g(url, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  g(dir, 'clone', '-q', url, dev);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) g(dev, 'config', k, v);
  let commits = 0;
  /** Commit `changes` ({ path: object | string | symlinkTo() | null }) and push them to `ref`; each commit is distinct. */
  const commit = (changes, ref) => {
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) rmSync(join(dev, path));
      else {
        mkdirSync(dirname(join(dev, path)), { recursive: true });
        if (value[LINK]) symlinkSync(value[LINK], join(dev, path));
        else writeFileSync(join(dev, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
      }
    }
    g(dev, 'add', '-A');
    g(dev, 'commit', '-q', '-m', `change ${++commits}`);
    g(dev, 'push', '-q', 'origin', `HEAD:${ref}`);
    return g(dev, 'rev-parse', 'HEAD');
  };
  let pulls = 0;
  const remote = {
    url,
    merge: (changes) => commit(changes, 'main'),
    /** A pull request's head: `changes` on top of main as it is now. */
    pullRequest: (changes) => {
      g(dev, 'checkout', '-q', '--detach', 'main');
      const head = commit(changes, `refs/pull/${++pulls}/head`);
      g(dev, 'checkout', '-q', 'main');
      return head;
    },
    main: () => g(url, 'rev-parse', 'main'),
    onMain: (path) => g(url, 'ls-tree', '--name-only', 'main', '--', path),
  };
  remote.revision = remote.merge(files);
  return remote;
}
const registryWithLee = () => atlasRemote({ [LEE]: lee, 'index.json': indexOf(lee) });

/**
 * Run `command` in process as the executor would, against `remote`, with `inputs` ({ name: JSON })
 * staged. Asserts what the executor requires of every run: result.json exactly on exit 0, one JSON
 * object within both caps.
 */
async function run(command, { remote, env = {}, inputs = {}, deps, revision = remote?.revision } = {}) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'atlas-inputs-'));
  const outputs = mkdtempSync(join(tmpdir(), 'atlas-outputs-'));
  for (const [name, value] of Object.entries(inputs)) writeFileSync(join(inputsDir, name), JSON.stringify(value));
  const log = [];
  const stream = { write: (s) => log.push(s) };
  const code = await runCommand(command, { env: { ...(remote && { ATLAS_REPOSITORY_URL: remote.url }), ...env }, inputs: inputsDir, outputs, deps, revision, stdout: stream, stderr: stream });
  const resultFile = join(outputs, 'result.json');
  assert.equal(code === 0, existsSync(resultFile), `exit ${code} ${existsSync(resultFile) ? 'with' : 'without'} result.json`);
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : undefined;
  if (result !== undefined) {
    assert.ok(statSync(resultFile).size <= MAX_RESULT_BYTES, `result.json is ${statSync(resultFile).size} bytes`);
    assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result), 'result.json holds one JSON object');
    assert.ok(!(result.summary?.length > MAX_SUMMARY_CHARACTERS), `the summary has ${result.summary?.length} characters`);
  }
  return { code, result, outputs, log: log.join('') };
}

const pullRequestEnv = (head, page = HENNEPIN) => ({ ATLAS_HEAD_SHA: head, ATLAS_PAGE: page });
const mainEnv = (remote) => ({ ATLAS_COUNTY: 'MN/hennepin', ATLAS_MAIN_SHA: remote.main(), ...SECRETS });

test("each configuration gives its commands only the secrets they use, returns result.json, and matches the image's constants", () => {
  const argv = (name) => ['node', `/opt/atlas/command/${name}.mjs`];
  const each = (pick) => Object.fromEntries(CONFIGURATIONS.map((c) => [c.id, pick(c)]));
  assert.deepEqual(each((c) => c.commands), {
    'atlas-command-validation-public': { 'check-page': argv('check-page'), verify: argv('verify') },
    'atlas-command-validation': { verify: argv('verify') },
    'atlas-command-transfer': { transfer: argv('transfer') },
    'atlas-command-index': { 'publish-index': argv('publish-index') },
    'atlas-command-withdrawal': { withdraw: argv('withdraw') },
  });
  assert.deepEqual(each((c) => Object.keys(c.secretEnvironment).sort()), {
    'atlas-command-validation-public': [],
    'atlas-command-validation': ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN'],
    'atlas-command-transfer': ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'],
    'atlas-command-index': ['ATLAS_DEPLOY_KEY', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'],
    'atlas-command-withdrawal': ['ATLAS_DEPLOY_KEY'],
  });
  for (const { id, result, outputs } of CONFIGURATIONS) assert.ok(result === 'result.json' && outputs.some(({ name, required }) => name === result && required), `${id} returns result.json`);
  assert.deepEqual([...SECRET_NAMES].sort(), [...new Set(CONFIGURATIONS.flatMap((c) => Object.keys(c.secretEnvironment)))].sort());
  const counties = CONFIGURATIONS.filter((c) => c.parameters.ATLAS_COUNTY);
  assert.ok(counties.length && counties.every((c) => c.parameters.ATLAS_COUNTY.pattern === COUNTY_PATTERN));
});

test('secrets never reach the log, result.json or another output, not even from a script in a process of its own', async () => {
  const script = join(mkdtempSync(join(tmpdir(), 'atlas-script-')), 'leak.mjs');
  writeFileSync(script, 'console.log(process.env.LEAK); console.error(process.env.LEAK);\n');
  const bearer = filebaseToken({ ...SECRETS, FILEBASE_BUCKET: 'elephant-atlas' });
  const leak = `${SECRETS.ATLAS_GATEWAY_TOKEN} ${PRIVATE_GATEWAY}/ipfs/x ${SECRETS.ATLAS_DEPLOY_KEY} Bearer ${bearer} ${SECRETS.FILEBASE_SECRET_KEY}`;
  const leaking = {
    name: 'leak',
    parameters: [],
    run: async ({ env }) => {
      console.log(leak);
      await runNode(script, [], { cwd: dirname(script), env: { ...env, LEAK: leak } });
      return { result: { ok: true, summary: leak }, files: { 'validation-errors.csv': leak } };
    },
  };
  const { code, result, outputs, log } = await run(leaking, { env: { ...SECRETS } });
  assert.equal(code, 0);
  for (const text of [log, result.summary, readFileSync(join(outputs, 'validation-errors.csv'), 'utf8')]) {
    for (const secret of [...Object.values(SECRETS).flatMap((value) => value.split('\n')), bearer]) assert.ok(!text.includes(secret), `${secret} in ${text}`);
    assert.ok(text.includes('https://<private gateway>/ipfs/x') && text.includes('Bearer ***'), text);
  }
});

test('an untrusted pull request is a verdict before anything is fetched: a wrong page path, other files, a removed or linked page, a page that fails check-page', async () => {
  const remote = registryWithLee();
  const secret = join(mkdtempSync(join(tmpdir(), 'atlas-secret-')), 'environ');
  writeFileSync(secret, 'ATLAS_GATEWAY_TOKEN=read-through-the-link');
  for (const [changes, pagePath, reason, summary] of [
    [{ 'counties/mn/hennepin.json': hennepin() }, 'counties/mn/hennepin.json', 'invalid-page-path', /^counties\/mn\/hennepin\.json is not a county page path: a page is counties\/<ST>\/<county>\.json/],
    [{ [HENNEPIN]: hennepin(), 'docs/note.md': 'x\n' }, HENNEPIN, 'not-one-page', /changes 2 file\(s\) against its base [0-9a-f]{40}, not only counties\/MN\/hennepin\.json: counties\/MN\/hennepin\.json, docs\/note\.md$/],
    [{ [LEE]: page({ fips: '12999', groups: lee.groups }) }, HENNEPIN, 'not-one-page', /not only counties\/MN\/hennepin\.json: counties\/FL\/lee\.json$/],
    [{ [LEE]: null }, LEE, 'page-removed', /^counties\/FL\/lee\.json is removed/],
    [{ [HENNEPIN]: symlinkTo(secret) }, HENNEPIN, 'not-regular-file', /^counties\/MN\/hennepin\.json is not a regular file \(git mode 120000, expected 100644\)/],
    [{ [HENNEPIN]: hennepin({ groups: { county: group({ cid: '../../../../home/node/x', car: 'not-a-cid' }) } }) }, HENNEPIN, 'invalid-page', /^nothing verified: the page fails check-page\ncounties\/MN\/hennepin\.json: \/groups\/county\/cid must match pattern/],
  ]) {
    const head = remote.pullRequest(changes);
    const { code, result, log } = await run(verify, { remote, env: pullRequestEnv(head, pagePath), deps: { verifyGroup: async () => assert.fail('fetched') } });
    assert.equal(code, 0, log);
    assert.deepEqual([result.ok, result.reason], [false, reason]);
    assert.match(result.summary, summary);
    assert.ok(!log.includes('read-through-the-link'), 'nothing read through the link');
  }
});

test("a run refuses unless the image was built from a revision on main whose files are main's", async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const check = (revision) => run(checkPage, { remote, revision, env: pullRequestEnv(head) });
  assert.equal((await check(remote.revision)).result.ok, true, "main's files");
  for (const revision of ['', 'f'.repeat(40)]) {
    const { code, log } = await check(revision);
    assert.equal(code, 1);
    assert.match(log, /this image's revision \((none|f{40})\) is not on main; build and register an image from main/);
  }
  remote.merge({ 'scripts/lib.mjs': '// changed on main\n' });
  const { code, log } = await check(remote.revision);
  assert.equal(code, 1);
  assert.match(log, /this image was built from [0-9a-f]{40}, whose files are not main's at [0-9a-f]{40}; build and register an image from main/);
});

test('withdraw refuses a hold that names another page, and pushes nothing', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const tip = remote.main();
  const { code, log } = await run(withdraw, { remote, env: mainEnv(remote), inputs: { 'held.json': [withdrawnHold({ path: LEE, cid: CID_C, tables: CID_D })] } });
  assert.equal(code, 1);
  assert.ok(log.includes('held.json holds MN/hennepin county on counties/FL/lee.json, not counties/MN/hennepin.json'), log);
  assert.deepEqual([remote.main(), remote.onMain(LEE)], [tip, LEE]);
});

test("the deploy key reaches git as an owner-only file, used with GitHub's pinned host keys only, and is gone after the run", async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const seen = {};
  const inspect = (root) => {
    seen.ssh = g(root, 'config', 'core.sshCommand');
    seen.file = /-i '([^']+)'/.exec(seen.ssh)[1];
    Object.assign(seen, { key: readFileSync(seen.file, 'utf8'), mode: statSync(seen.file).mode & 0o777 });
    return { done: [] };
  };
  const { result } = await run(withdraw, { remote, env: mainEnv(remote), inputs: { 'held.json': [withdrawnHold()] }, deps: { withdraw: inspect } });
  assert.equal(result.withdrawn, false);
  assert.deepEqual([seen.key, seen.mode], [`${SECRETS.ATLAS_DEPLOY_KEY}\n`, 0o600]);
  const [, knownHosts] = /-o UserKnownHostsFile='([^']+)'/.exec(seen.ssh);
  assert.match(seen.ssh, /-o IdentitiesOnly=yes .* -o StrictHostKeyChecking=yes$/);
  assert.ok(readFileSync(knownHosts, 'utf8').trim().split('\n').every((line) => line.startsWith('[ssh.github.com]:443 ')));
  assert.equal(existsSync(seen.file), false);
});

test('a summary keeps at most 16,000 characters and a result at most 60,000 bytes; a result that cannot fit or is not one object fails the run', async () => {
  const longest = 'x'.repeat(MAX_SUMMARY_CHARACTERS);
  const groups = (n) => Array.from({ length: n }, (_, i) => ({ group: `group_${i}`, archiveCid: CID_A }));
  const returning = (result) => ({ name: 'fixed', parameters: [], run: async () => ({ result }) });
  for (const [result, expected] of [
    [{ ok: true, summary: longest }, (summary) => assert.equal(summary, longest)],
    [{ ok: true, summary: `${longest}x` }, (summary) => assert.ok(SHORTENED.test(summary) && summary.startsWith('x'.repeat(MAX_SUMMARY_CHARACTERS - 100)), summary.slice(-100))],
    [{ ok: true, groups: groups(400), summary: longest }, (summary) => assert.ok(SHORTENED.test(summary) && summary.length < MAX_SUMMARY_CHARACTERS - 1_000, `${summary.length}`)],
    [{ groups: groups(10_000) }, `at most ${MAX_RESULT_BYTES} fit`],
    [['not', 'an', 'object'], 'the result must be one JSON object'],
  ]) {
    const outcome = await run(returning(result));
    if (typeof expected === 'string') assert.ok(outcome.code === 1 && outcome.log.includes(expected), outcome.log);
    else expected(outcome.result.summary);
  }
});

test('every command finishes with its verdict on exit 0, and exits 1 when it cannot finish', async () => {
  const remote = registryWithLee();
  const valid = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const invalid = remote.pullRequest({ [HENNEPIN]: hennepin({ county: 'hennepin-county' }) });
  remote.merge({ [HENNEPIN]: hennepin() });
  const transferring = (holds) => ({ runScript: async (_script, _args, { env }) => (holds && writeFileSync(env.ATLAS_HELD, JSON.stringify(holds)), { code: 1, stderr: [] }) });
  const indexing = (output, stderr = []) => ({ runScript: async (_script, _args, { env }) => (writeFileSync(env.GITHUB_OUTPUT, output), { code: stderr.length ? 1 : 0, stderr }) });
  const left = `not indexed: MN/hennepin county (deferred): Filebase does not list ${CID_A} as pinned (not listed)`;
  const deferred = withdrawnHold({ kind: 'deferred', reason: 'pin/ls: HTTP 500' });
  const held = { 'held.json': [withdrawnHold()] };
  for (const [command, options, expected] of [
    [checkPage, { env: pullRequestEnv(valid) }, { ok: true, summary: 'ok: 2 page(s) valid' }],
    [checkPage, { env: pullRequestEnv(invalid) }, { ok: false, reason: 'invalid-page', summary: 'counties/MN/hennepin.json: path must be counties/MN/hennepin-county.json' }],
    [verify, { env: pullRequestEnv(valid), deps: { verifyGroup: async () => assert.fail('HTTP 504') } }, { ok: false, reason: 'group-failed', summary: 'FAIL counties/MN/hennepin.json group county: HTTP 504' }],
    [transfer, { deps: transferring([withdrawnHold()]) }, { ok: false, reason: 'withdrawn', withdraw: true, deferred: false, root: CID_A, summary: `MN/hennepin county (withdrawn): ${withdrawnHold().reason}` }],
    [transfer, { deps: transferring([deferred]) }, { ok: false, reason: 'deferred', withdraw: false, deferred: true, summary: `MN/hennepin county (deferred): ${deferred.reason}; nothing is withdrawn, a later run transfers it again` }],
    [transfer, { deps: transferring(undefined) }, 'transfer-roots.mjs ended with exit code 1 and wrote no holds'],
    [publishIndex, { deps: indexing('indexed=true\ncid=bafkreiindex\n') }, { ok: true, indexed: true, indexCid: 'bafkreiindex', groups: [], countyIndexed: true, summary: 'Published index.json bafkreiindex' }],
    [publishIndex, { deps: indexing('indexed=true\n', [left]) }, { ok: false, reason: 'not-served', indexed: true, indexCid: null, groups: [], countyIndexed: false, summary: `index.json is on main, but publish-index.mjs ended with exit code 1 before the IPNS name served it (see the log)\n${left}` }],
    [withdraw, { inputs: held }, () => ({ withdrawn: true, commitSha: remote.main(), root: CID_A, summary: `Withdrew MN/hennepin county: ${withdrawnHold().reason}.` })],
    [withdraw, { inputs: held }, { withdrawn: false, commitSha: null, root: CID_A, summary: 'Nothing left to withdraw on main for MN/hennepin: main no longer holds the roots that failed, or the index lists them.' }],
  ]) {
    const { code, result, log } = await run(command, { remote, env: mainEnv(remote), ...options });
    if (typeof expected === 'string') assert.ok(code === 1 && log.includes(expected), log);
    else assert.deepEqual(result, typeof expected === 'function' ? expected() : expected, `${command.name}: ${log}`);
  }
});
