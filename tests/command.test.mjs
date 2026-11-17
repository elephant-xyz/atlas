import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { command as checkPage } from '../command/check-page.mjs';
import { command as verify } from '../command/verify.mjs';
import { command as transfer } from '../command/transfer.mjs';
import { command as publishIndex } from '../command/publish-index.mjs';
import { command as withdraw } from '../command/withdraw.mjs';
import { IMAGE_ROOT, imageFiles, runCommand, runNode } from '../command/lib.mjs';
import { token as filebaseToken } from '../scripts/filebase.mjs';
import { buildEntries } from '../scripts/lib.mjs';
import { CID_A, CID_B, CID_C, CID_D, group, page } from './helpers.mjs';

const configurationFile = (id) => JSON.parse(readFileSync(new URL(`../command/${id}.json`, import.meta.url), 'utf8'));
const CONFIGURATION_IDS = ['atlas-command-validation-public', 'atlas-command-validation', 'atlas-command-transfer', 'atlas-command-index', 'atlas-command-withdrawal'];
const CONFIGURATIONS = CONFIGURATION_IDS.map(configurationFile);
const [VALIDATION_PUBLIC, VALIDATION] = CONFIGURATIONS;
const COMMANDS = { 'check-page': checkPage, verify, transfer, 'publish-index': publishIndex, withdraw };
/** The first configuration listing the command: for verify, the one without secrets. */
const configurationOf = (name) => CONFIGURATIONS.find((c) => Object.hasOwn(c.commands, name));
/** The arguments a configuration starts an entry point with, after `node <entry point>`. */
const startedUnder = (configuration) => ['--configuration', configuration.id];
/** The most result.json may hold: under the executor's 60 KiB result limit. */
const MAX_RESULT_BYTES = 60_000;
/** The longest summary: what the Connect flows that post it to GitHub accept. */
const MAX_SUMMARY_CHARACTERS = 16_000;
const SHORTENED = /\n… \(shortened to fit the result; the run's log has all of it\)$/;

const HENNEPIN = 'counties/MN/hennepin.json';
/** A page path the configurations accept and check-page refuses: the state is not in capitals. */
const WRONGLY_SHAPED = 'counties/mn/hennepin.json';
const LEE = 'counties/FL/lee.json';
const hennepin = (overrides = {}) => page({ county: 'hennepin', state: 'MN', fips: '27053', ...overrides });
const lee = page({ groups: { county: group({ cid: CID_C, tables: CID_D }) } });
const indexOf = (...pages) => ({ version: 1, generated_from: 'x', counties: buildEntries(pages.map((page) => ({ page })), () => undefined) });
const PRIVATE_GATEWAY = 'https://private-gateway.test';
const SECRETS = { ATLAS_GATEWAYS: PRIVATE_GATEWAY, ATLAS_GATEWAY_TOKEN: 'gateway-token-value', FILEBASE_ACCESS_KEY: 'filebase-access-value', FILEBASE_SECRET_KEY: 'filebase-secret-value', ATLAS_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-deploy-key\n-----END OPENSSH PRIVATE KEY-----' };
/** The secrets a task started under `configuration` receives. */
const secretsOf = (configuration) => Object.fromEntries(Object.keys(configuration.secretEnvironment).map((name) => [name, SECRETS[name]]));
const withdrawnHold = (overrides = {}) => ({ path: HENNEPIN, county: 'MN/hennepin', key: 'county', kind: 'withdrawn', cid: CID_A, tables: CID_B, root: CID_A, reason: `/ipfs/${CID_A}?format=car not available from any gateway within 20 min`, ...overrides });

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LINK = Symbol('link');
/** A change that commits `path` as a symbolic link to `target`. */
const symlinkTo = (target) => ({ [LINK]: target });

/**
 * A local stand-in for github.com/elephant-xyz/atlas: main holds the image's own Atlas files
 * (this working tree's) and `files`; a pull request's head is pushed to refs/pull/<n>/head and
 * fetchable by SHA, as on GitHub.
 */
function atlasRemote(files) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-remote-'));
  const remote = join(dir, 'atlas.git');
  g(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  g(remote, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const dev = join(dir, 'dev');
  g(dir, 'init', '-q', '-b', 'main', dev);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) g(dev, 'config', k, v);
  g(dev, 'remote', 'add', 'origin', remote);
  /** Commit `changes` in the local clone (null removes a path, symlinkTo() links it); returns the commit. */
  const write = (changes) => {
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) rmSync(join(dev, path));
      else {
        mkdirSync(dirname(join(dev, path)), { recursive: true });
        if (value[LINK]) symlinkSync(value[LINK], join(dev, path));
        else writeFileSync(join(dev, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
      }
    }
    g(dev, 'add', '-A');
    g(dev, 'commit', '-q', '-m', 'change');
    return g(dev, 'rev-parse', 'HEAD');
  };
  /** Commit `changes` ({ path: object | string | symlinkTo() | null }) on main and push it: one merge. */
  const merge = (changes) => {
    const sha = write(changes);
    g(dev, 'push', '-q', 'origin', 'HEAD:main');
    return sha;
  };
  let pulls = 0;
  /** A pull request's head: `changes` on top of main as it is now. */
  const pullRequest = (changes) => {
    g(dev, 'checkout', '-q', '--detach', 'main');
    const sha = write(changes);
    g(dev, 'push', '-q', 'origin', `HEAD:refs/pull/${++pulls}/head`);
    g(dev, 'checkout', '-q', 'main');
    return sha;
  };
  for (const path of imageFiles(IMAGE_ROOT)) {
    mkdirSync(dirname(join(dev, path)), { recursive: true });
    copyFileSync(join(IMAGE_ROOT, path), join(dev, path));
  }
  merge(files);
  return { url: remote, merge, pullRequest, main: () => g(remote, 'rev-parse', 'main'), onMain: (path) => g(remote, 'ls-tree', '--name-only', 'main', '--', path) };
}

/** Run `command` in process as the executor would, under `configuration`, with `inputs` ({ name: object }) staged; returns its exit code, outputs and log. */
async function run(command, { env, inputs = {}, deps, configuration = configurationOf(command.name), argv = startedUnder(configuration) } = {}) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'atlas-inputs-'));
  const outputs = mkdtempSync(join(tmpdir(), 'atlas-outputs-'));
  for (const [name, value] of Object.entries(inputs)) writeFileSync(join(inputsDir, name), JSON.stringify(value));
  const out = [];
  const err = [];
  const code = await runCommand(command, { argv, env: { ...env }, inputs: inputsDir, outputs, deps, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  const read = (name) => (existsSync(join(outputs, name)) ? JSON.parse(readFileSync(join(outputs, name), 'utf8')) : undefined);
  // What the executor requires of every run: exit 0 exactly when the command finished and wrote
  // its result, and that result one JSON object that fits.
  const resultFile = join(outputs, 'result.json');
  assert.equal(code === 0, existsSync(resultFile), `exit ${code} ${existsSync(resultFile) ? 'with' : 'without'} result.json`);
  if (existsSync(resultFile)) {
    assert.ok(statSync(resultFile).size <= MAX_RESULT_BYTES, `result.json is ${statSync(resultFile).size} bytes`);
    const result = read('result.json');
    assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result), 'result.json holds one JSON object');
    assert.ok(!(result.summary?.length > MAX_SUMMARY_CHARACTERS), `the summary has ${result.summary?.length} characters`);
  }
  return { code, result: read('result.json'), held: read('held.json'), outputs, out: out.join(''), err: err.join('') };
}

/** A pull request check's environment: its parameters and the secrets of `configuration`. */
const prEnv = (remote, head, configuration = VALIDATION_PUBLIC, extra = {}) => ({ ATLAS_REPOSITORY_URL: remote.url, ATLAS_HEAD_SHA: head, ATLAS_PAGE: HENNEPIN, ...secretsOf(configuration), ...extra });
/** A publication command's environment: its parameters and the secrets of its configuration. */
const mainEnv = (remote, command, extra = {}) => ({ ATLAS_REPOSITORY_URL: remote.url, ATLAS_COUNTY: 'MN/hennepin', ATLAS_MAIN_SHA: remote.main(), ...secretsOf(configurationOf(command.name)), ...extra });
const registryWithLee = () => atlasRemote({ [LEE]: lee, 'index.json': indexOf(lee) });

// ---- the configurations

test('each configuration gives its commands only the secrets every one of them uses: none to a pull request from a fork, no deploy key to a transfer', () => {
  const each = (pick) => Object.fromEntries(CONFIGURATIONS.map((c) => [c.id, pick(c)]));
  assert.deepEqual(each((c) => Object.keys(c.commands)), {
    'atlas-command-validation-public': ['check-page', 'verify'],
    'atlas-command-validation': ['verify'],
    'atlas-command-transfer': ['transfer'],
    'atlas-command-index': ['publish-index'],
    'atlas-command-withdrawal': ['withdraw'],
  });
  assert.deepEqual(each((c) => Object.keys(c.secretEnvironment).sort()), {
    'atlas-command-validation-public': [],
    'atlas-command-validation': ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN'],
    'atlas-command-transfer': ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'],
    'atlas-command-index': ['ATLAS_DEPLOY_KEY', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'],
    'atlas-command-withdrawal': ['ATLAS_DEPLOY_KEY'],
  });
  for (const configuration of CONFIGURATIONS) {
    assert.ok(configuration.id.length <= 64, `${configuration.id} fits Transform's 64-character id`);
    assert.equal(configuration.image, VALIDATION.image, 'the same image');
    const commands = Object.keys(configuration.commands).map((name) => COMMANDS[name]);
    for (const command of commands) assert.deepEqual(configuration.commands[command.name], ['node', `/opt/atlas/command/${command.name}.mjs`, ...startedUnder(configuration)]);
    // The executor returns this output's JSON as the run's `result`.
    assert.equal(configuration.result, 'result.json');
    assert.ok(configuration.outputs.some(({ name, required }) => name === configuration.result && required), `${configuration.id} requires its result output`);
    const used = (pick) => [...new Set(commands.flatMap(pick))].sort();
    assert.deepEqual(Object.keys(configuration.parameters).sort(), used((c) => c.parameters.map(({ name }) => name)), `${configuration.id} parameters`);
    assert.deepEqual(configuration.inputs.map(({ name }) => name).sort(), used((c) => c.inputs), `${configuration.id} inputs`);
    assert.deepEqual(configuration.outputs.map(({ name }) => name).sort(), used((c) => c.outputs), `${configuration.id} outputs`);
  }
});

test('the image runs the elephant-cli release validate.yml pins, installs no dependency scripts, and carries its Dockerfile for the image check', () => {
  const dockerfile = readFileSync(new URL('../command/Dockerfile', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
  const [, version] = /VERSION: (\S+)/.exec(workflow);
  const [, digest] = /SHA256: ([0-9a-f]{64})/.exec(workflow);
  assert.match(dockerfile, /^WORKDIR \/opt\/atlas$/m);
  assert.ok(dockerfile.includes(`ADD --checksum=sha256:${digest}`) && dockerfile.includes(`/releases/download/${version}/`), 'the CLI validate.yml pins');
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.ok(imageFiles(IMAGE_ROOT).includes('command/Dockerfile'));
});

test("parameter patterns accept the consumer's values as whole values only: every page on main, and no gateway deadline beyond the configuration's time limit", () => {
  const whole = (pattern) => new RegExp(`^(?:${pattern})$`, 'u');
  const patterns = {};
  for (const configuration of CONFIGURATIONS) {
    for (const [name, { pattern }] of Object.entries(configuration.parameters)) {
      if (name === 'ATLAS_GATEWAY_DEADLINE_MINUTES') {
        const limit = configuration.limits.timeoutMinutes;
        for (let minutes = 1; minutes <= limit; minutes++) assert.ok(whole(pattern).test(String(minutes)), `${configuration.id} accepts ${minutes} minutes`);
        for (const value of [String(limit + 1), '1000', '0', '020', '20m', '-1']) assert.ok(!whole(pattern).test(value), `${configuration.id} refuses ${value} minutes`);
        continue;
      }
      assert.equal(patterns[name] ?? pattern, pattern, `${name} has one pattern`);
      patterns[name] = pattern;
    }
  }
  const pages = readdirSync(join(IMAGE_ROOT, 'counties'), { recursive: true }).filter((n) => n.endsWith('.json')).map((n) => `counties/${n.replaceAll('\\', '/')}`);
  assert.equal(pages.length, 50);
  for (const path of pages) {
    assert.ok(whole(patterns.ATLAS_PAGE).test(path), `ATLAS_PAGE accepts ${path}`);
    assert.ok(whole(patterns.ATLAS_COUNTY).test(path.slice('counties/'.length, -'.json'.length)), `ATLAS_COUNTY accepts the county of ${path}`);
  }
  const samples = {
    ATLAS_HEAD_SHA: ['5d3c1f0e9a2b4c6d8e0f1a2b3c4d5e6f7a8b9c0d', ['5d3c1f0e', '5D3C1F0E9A2B4C6D8E0F1A2B3C4D5E6F7A8B9C0D']],
    ATLAS_MAIN_SHA: ['fd148cd58a79ed54cbbc6df3459695646a55d4a2', ['main', 'fd148cd']],
    ATLAS_PAGE: [HENNEPIN, ['counties/MN/hennepin/extra.json', 'index.json', 'counties/MN/:(top)x.json', 'counties/../x.json', 'counties/MN/.hennepin.json']],
    ATLAS_COUNTY: ['MN/hennepin', ['MN/Hennepin', 'mn/hennepin', 'MN/hennepin/x']],
  };
  assert.deepEqual(Object.keys(patterns).sort(), Object.keys(samples).sort());
  for (const [name, [good, bad]] of Object.entries(samples)) {
    assert.ok(whole(patterns[name]).test(good), `${name} accepts ${good}`);
    for (const value of [...bad, `${good}\n`, ` ${good}`]) assert.ok(!whole(patterns[name]).test(value), `${name} refuses ${JSON.stringify(value)}`);
  }
  // A badly shaped page path still starts a task, so check-page answers it with a verdict.
  assert.ok(whole(patterns.ATLAS_PAGE).test(WRONGLY_SHAPED));
});

test('the committed configurations never name an image digest: the image is pinned when they are registered', () => {
  for (const { image } of CONFIGURATIONS) {
    assert.doesNotMatch(image, /@sha256:[a-f0-9]{64}$/);
    assert.equal(image, 'PLACEHOLDER_ATLAS_COMMAND_IMAGE_PINNED_BY_DIGEST');
  }
});

// ---- what every command does before it runs anything

test('a run started without its configuration, or with a missing, malformed or foreign parameter, fails before anything is fetched, and writes no result', async () => {
  const env = { ATLAS_REPOSITORY_URL: '/nonexistent/atlas.git', ATLAS_HEAD_SHA: 'a'.repeat(40), ATLAS_PAGE: HENNEPIN };
  for (const [changed, message, argv] of [
    [{ ATLAS_PAGE: undefined }, 'ATLAS_PAGE is required'],
    [{ ATLAS_HEAD_SHA: 'main' }, 'ATLAS_HEAD_SHA does not match its pattern'],
    [{ ATLAS_COUNTY: 'MN/hennepin' }, 'ATLAS_COUNTY is not a parameter of check-page'],
    [{}, 'must be started with --configuration <id>', []],
    [{}, 'must be started with --configuration <id>', ['--configuration', 'atlas-command']],
  ]) {
    const { code, result, err } = await run(checkPage, { argv, env: Object.fromEntries(Object.entries({ ...env, ...changed }).filter(([, v]) => v !== undefined)) });
    assert.equal(code, 1);
    assert.equal(result, undefined);
    assert.ok(err.includes(message), err);
    assert.ok(!err.includes('clone'), 'nothing was fetched');
  }
});

// ---- check-page

test('check-page passes a valid page with the same line validate-entry prints', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const { code, result } = await run(checkPage, { env: prEnv(remote, head) });
  assert.equal(code, 0);
  assert.deepEqual(result, { ok: true, summary: 'ok: 2 page(s) valid' });
  // The same checkout through the script itself.
  const clone = mkdtempSync(join(tmpdir(), 'atlas-clone-'));
  g(clone, 'clone', '-q', remote.url, '.');
  g(clone, 'fetch', '-q', 'origin', head);
  g(clone, 'checkout', '-q', '--detach', head);
  const said = execFileSync(process.execPath, [join(IMAGE_ROOT, 'scripts/validate-entry.mjs')], { cwd: clone, encoding: 'utf8' }).trim();
  assert.equal(result.summary, said);
});

test("a page that fails validate-entry, in its own words, or a head that is not exactly one added or modified regular county page, is a verdict of check-page and verify, which fetches nothing and reads nothing through a link", async () => {
  const remote = registryWithLee();
  const secret = join(mkdtempSync(join(tmpdir(), 'atlas-secret-')), 'environ');
  writeFileSync(secret, 'ATLAS_GATEWAY_TOKEN=gateway-token-value');
  for (const [changes, pagePath, reason, summary] of [
    [{ [HENNEPIN]: hennepin({ county: 'hennepin-county' }) }, HENNEPIN, 'invalid-page', /^counties\/MN\/hennepin\.json: path must be counties\/MN\/hennepin-county\.json$/],
    [{ [HENNEPIN]: hennepin({ groups: { county: group({ cid: '../../../../home/node/x', car: 'not-a-cid' }) } }) }, HENNEPIN, 'invalid-page', /^counties\/MN\/hennepin\.json: \/groups\/county\/cid must match pattern/],
    [{ [HENNEPIN]: hennepin(), 'docs/note.md': 'x\n' }, HENNEPIN, 'not-one-page', /^the pull request changes 2 file\(s\) against its base [0-9a-f]{40}, not only counties\/MN\/hennepin\.json: counties\/MN\/hennepin\.json, docs\/note\.md$/],
    [{ [LEE]: page({ fips: '12999', groups: lee.groups }) }, HENNEPIN, 'not-one-page', /not only counties\/MN\/hennepin\.json: counties\/FL\/lee\.json$/],
    [{ [LEE]: null }, LEE, 'page-removed', /^counties\/FL\/lee\.json is removed; a pull request that removes a page has nothing to check here$/],
    [{ [HENNEPIN]: symlinkTo(secret) }, HENNEPIN, 'not-regular-file', /^counties\/MN\/hennepin\.json is not a regular file \(git mode 120000, expected 100644\); nothing was read from it$/],
    [{ [WRONGLY_SHAPED]: hennepin() }, WRONGLY_SHAPED, 'invalid-page-path', /^counties\/mn\/hennepin\.json is not a county page path: a page is counties\/<ST>\/<county>\.json, <ST> two capital letters and <county> lowercase letters and digits in words joined by hyphens, such as counties\/MN\/hennepin\.json$/],
  ]) {
    const head = remote.pullRequest(changes);
    const checked = await run(checkPage, { env: prEnv(remote, head, VALIDATION_PUBLIC, { ATLAS_PAGE: pagePath }) });
    assert.equal(checked.code, 0, 'a page that fails its checks is a result, not an error');
    const { summary: said, ...verdict } = checked.result;
    assert.deepEqual(verdict, { ok: false, reason });
    assert.match(said, summary);
    const verified = await run(verify, { configuration: VALIDATION, env: prEnv(remote, head, VALIDATION, { ATLAS_PAGE: pagePath }), deps: { verifyGroup: async () => assert.fail('fetched') } });
    assert.deepEqual(verified.result, reason === 'invalid-page' ? { ...checked.result, summary: `nothing verified: the page fails check-page\n${said}` } : checked.result);
    for (const { out, err } of [checked, verified]) assert.ok(!`${out}${err}`.includes('ATLAS_GATE'), 'nothing read through the link');
  }
});

test("check-page judges a pull request with main's scripts, as validate.yml judges the merge commit, and refuses to run on an image that is not main's", async () => {
  const remote = registryWithLee();
  const original = readFileSync(join(IMAGE_ROOT, 'scripts/lib.mjs'), 'utf8');
  remote.merge({ 'scripts/lib.mjs': `${original}// changed on main\n`, 'scripts/new-check.mjs': '// new on main\n' });
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const refused = await run(checkPage, { env: prEnv(remote, head) });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /this image's Atlas files are not main's at [0-9a-f]{40}/);
  assert.match(refused.err, /scripts\/lib\.mjs differs/);
  assert.match(refused.err, /scripts\/new-check\.mjs is not in the image/);
  assert.doesNotMatch(refused.err, /update the pull request/);
  // main takes the change back: the same head, forked from the changed main, is judged by main's scripts.
  remote.merge({ 'scripts/lib.mjs': original, 'scripts/new-check.mjs': null });
  const judged = await run(checkPage, { env: prEnv(remote, head) });
  assert.deepEqual(judged.result, { ok: true, summary: 'ok: 2 page(s) valid' });
});

// ---- verify

test('verify checks each changed group with the scripts, the CLI error CSV redacted in the outputs', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const seen = [];
  const deps = {
    verifyGroup: async (target, d) => {
      seen.push({ target: `${target.path} ${target.key} ${target.cid}`, csv: d.csv });
      d.validateCar('archive.car');
    },
    validateCar: (file, csv) => {
      seen.push({ file });
      writeFileSync(csv, `cid,error\n${PRIVATE_GATEWAY} ${SECRETS.ATLAS_GATEWAY_TOKEN}\n`);
    },
  };
  const { code, result, outputs } = await run(verify, { configuration: VALIDATION, env: prEnv(remote, head, VALIDATION), deps });
  assert.equal(code, 0);
  assert.deepEqual(result, { ok: true, summary: 'ok counties/MN/hennepin.json group county' });
  assert.deepEqual(seen, [{ target: `${HENNEPIN} county ${CID_A}`, csv: 'validation-errors.csv' }, { file: 'archive.car' }]);
  assert.equal(readFileSync(join(outputs, 'validation-errors.csv'), 'utf8'), 'cid,error\nhttps://<private gateway> ***\n');
});

test('verify reports a failing group as ok: false, with private gateways and secrets taken out', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const verifyGroup = async () => {
    console.log(`fetched ${PRIVATE_GATEWAY}/ipfs/${CID_A}?format=car with ${SECRETS.ATLAS_GATEWAY_TOKEN}`);
    throw new Error(`/ipfs/${CID_A}?format=car not available from any gateway within 20 min: ${PRIVATE_GATEWAY}/ipfs/${CID_A}?format=car: HTTP 504`);
  };
  const { code, result, out } = await run(verify, { configuration: VALIDATION, env: prEnv(remote, head, VALIDATION), deps: { verifyGroup } });
  assert.equal(code, 0);
  assert.deepEqual(result, { ok: false, reason: 'group-failed', summary: `FAIL counties/MN/hennepin.json group county: /ipfs/${CID_A}?format=car not available from any gateway within 20 min: https://<private gateway>/ipfs/${CID_A}?format=car: HTTP 504` });
  assert.ok(!out.includes(PRIVATE_GATEWAY) && !out.includes(SECRETS.ATLAS_GATEWAY_TOKEN), out);
});

// ---- transfer

test('transfer runs transfer-roots for the county on main as it is now, with the publish settings and no deploy key', async () => {
  const remote = registryWithLee();
  const merged = remote.merge({ [HENNEPIN]: hennepin() });
  remote.merge({ 'counties/GA/fulton.json': page({ state: 'GA', county: 'fulton', fips: '13121', groups: {} }) });
  const calls = [];
  const runScript = async (script, args, { cwd, env }) => {
    calls.push({ script, args, head: g(cwd, 'rev-parse', 'HEAD'), env });
    writeFileSync(env.ATLAS_HELD, '[]');
    return { code: 0, stderr: [] };
  };
  const { code, result, held } = await run(transfer, { env: mainEnv(remote, transfer, { ATLAS_MAIN_SHA: merged, ATLAS_GATEWAY_DEADLINE_MINUTES: '5' }), deps: { runScript } });
  assert.equal(code, 0);
  assert.deepEqual(result, { ok: true, withdraw: false, deferred: false, summary: '2 root(s) pinned' });
  assert.equal(held, undefined);
  const [{ script, args, head, env }] = calls;
  assert.equal(script, join(IMAGE_ROOT, 'scripts/transfer-roots.mjs'));
  assert.deepEqual(args, ['--county', 'MN/hennepin']);
  assert.equal(head, remote.main(), "main's tip, not the merge commit");
  assert.equal(env.FILEBASE_ACCESS_KEY, SECRETS.FILEBASE_ACCESS_KEY);
  assert.equal(env.ATLAS_GATEWAYS, PRIVATE_GATEWAY);
  assert.equal(env.ATLAS_DEPLOY_KEY, undefined);
  assert.equal(env.ATLAS_GATEWAY_DEADLINE_MINUTES, '5');
  assert.equal(env.FILEBASE_BUCKET, 'elephant-atlas');
  assert.equal(env.ATLAS_TRANSFER_PARALLEL, '8');
});

test("transfer turns the holds transfer-roots wrote into its verdict: this county's withdrawal, a deferral or an outage to retry, an old group's hold that does not fail a new publication; and fails when the script wrote none", async () => {
  const merged = registryWithLee();
  merged.merge({ [HENNEPIN]: hennepin() });
  const published = hennepin();
  const republished = atlasRemote({ [HENNEPIN]: published, 'index.json': indexOf(published) });
  republished.merge({ [HENNEPIN]: hennepin({ groups: { ...published.groups, property_improvement: group({ cid: CID_C, tables: CID_D }) } }) });
  const old = withdrawnHold({ kind: 'deferred', reason: 'already published, but it would not transfer again: pin/ls: HTTP 500' });
  for (const { remote = merged, code, holds, result, held, error } of [
    { code: 1, holds: [withdrawnHold(), withdrawnHold({ path: LEE, county: 'FL/lee', kind: 'deferred', root: CID_C })], result: { ok: false, reason: 'withdrawn', withdraw: true, deferred: false, root: CID_A, summary: `MN/hennepin county (withdrawn): ${withdrawnHold().reason}` }, held: [withdrawnHold()] },
    { code: 1, holds: [withdrawnHold({ kind: 'deferred', reason: 'pin/ls: HTTP 500' })], result: { ok: false, reason: 'deferred', withdraw: false, deferred: true, summary: 'MN/hennepin county (deferred): pin/ls: HTTP 500; nothing is withdrawn, a later run transfers it again' } },
    { code: 2, result: { ok: false, reason: 'outage', withdraw: false, deferred: true, summary: 'nothing transferred: the gateways or Filebase were down before the first root (see the log); nothing is withdrawn' } },
    { remote: republished, code: 1, holds: [old], result: { ok: true, withdraw: false, deferred: false, summary: `every root MN/hennepin owes is pinned; already published, but not pinned again: MN/hennepin county (deferred): ${old.reason}` } },
    { code: 1, error: 'transfer-roots.mjs ended with exit code 1 and wrote no holds' },
  ]) {
    const runScript = async (_script, _args, { env }) => (holds && writeFileSync(env.ATLAS_HELD, JSON.stringify(holds)), { code, stderr: [] });
    const outcome = await run(transfer, { env: mainEnv(remote, transfer), deps: { runScript } });
    if (error) {
      assert.equal(outcome.code, 1);
      assert.ok(outcome.err.includes(error), outcome.err);
      continue;
    }
    assert.equal(outcome.code, 0, outcome.err);
    assert.deepEqual(outcome.result, result);
    assert.deepEqual(outcome.held, held);
  }
});

test("a publication command refuses a commit that is not on main, and an image whose files, Dockerfile included, are not main's", async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  let ran = false;
  const runScript = async () => (ran = true);
  const notOnMain = await run(transfer, { env: mainEnv(remote, transfer, { ATLAS_MAIN_SHA: head }), deps: { runScript } });
  assert.equal(notOnMain.code, 1);
  assert.ok(notOnMain.err.includes(`${head} is not on main`), notOnMain.err);
  const dockerfile = readFileSync(join(IMAGE_ROOT, 'command/Dockerfile'), 'utf8');
  remote.merge({ 'scripts/s3.mjs': null, 'command/Dockerfile': `${dockerfile}# changed on main\n` });
  for (const command of [transfer, publishIndex]) {
    const { code, err } = await run(command, { env: mainEnv(remote, command), deps: { runScript } });
    assert.equal(code, 1);
    assert.match(err, /this image's Atlas files are not main's at [0-9a-f]{40} \(command\/Dockerfile differs; scripts\/s3\.mjs is not on main\); build and register an image from main/);
  }
  assert.equal(ran, false);
});

// ---- publish-index

test('publish-index publishes from main with the deploy key on SSH, reports the groups the index lists for the county, and leaves no key or secret behind', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const seen = {};
  const runScript = async (script, args, { cwd, env }) => {
    Object.assign(seen, { script, args, env, pushUrl: g(cwd, 'config', 'remote.origin.pushurl'), ssh: g(cwd, 'config', 'core.sshCommand'), user: g(cwd, 'config', 'user.name') });
    seen.keyFile = /-i '([^']+)'/.exec(seen.ssh)[1];
    Object.assign(seen, { key: readFileSync(seen.keyFile, 'utf8'), mode: statSync(seen.keyFile).mode & 0o777 });
    console.log(`${SECRETS.ATLAS_DEPLOY_KEY} ${env.FILEBASE_ACCESS_KEY} ${env.FILEBASE_SECRET_KEY} Bearer ${filebaseToken(env)}`);
    writeFileSync(join(cwd, 'index.json'), JSON.stringify(indexOf(lee, hennepin()), null, 2) + '\n');
    writeFileSync(env.GITHUB_OUTPUT, 'indexed=true\ncid=bafkreiindex\n');
    writeFileSync(env.GITHUB_STEP_SUMMARY, `Published index.json bafkreiindex (updated); ipns k51 -> /ipfs/bafkreiindex with ${env.FILEBASE_SECRET_KEY}\n`);
    return { code: 0, stderr: [] };
  };
  const { code, result, out, err } = await run(publishIndex, { env: mainEnv(remote, publishIndex), deps: { runScript } });
  assert.equal(code, 0);
  assert.deepEqual(result, { ok: true, indexed: true, indexCid: 'bafkreiindex', groups: [{ group: 'county', archiveCid: CID_A }], countyIndexed: true, summary: 'Published index.json bafkreiindex (updated); ipns k51 -> /ipfs/bafkreiindex with ***' });
  assert.equal(seen.script, join(IMAGE_ROOT, 'scripts/publish-index.mjs'));
  assert.deepEqual(seen.args, []);
  assert.equal(seen.pushUrl, remote.url);
  assert.match(seen.ssh, /-o IdentitiesOnly=yes/);
  assert.match(seen.ssh, /-o UserKnownHostsFile='[^']+\/command\/known_hosts'/);
  assert.match(seen.ssh, /-o StrictHostKeyChecking=yes/);
  assert.equal(seen.key, `${SECRETS.ATLAS_DEPLOY_KEY}\n`);
  assert.equal(seen.mode, 0o600);
  assert.equal(existsSync(seen.keyFile), false, 'the deploy key file is removed after the run');
  assert.ok(seen.user);
  assert.equal(seen.env.ATLAS_DEPLOY_KEY, undefined, 'the key reaches git as a file, not the script as a variable');
  assert.equal(seen.env.FILEBASE_SECRET_KEY, SECRETS.FILEBASE_SECRET_KEY);
  assert.equal(seen.env.ATLAS_IPNS_ID, 'k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04');
  assert.equal(seen.env.ATLAS_PENDING_HOURS, 'Infinity', 'Publication pending issues are not opened from the executor');
  const log = `${out}${err}`;
  for (const secret of [...SECRETS.ATLAS_DEPLOY_KEY.split('\n'), SECRETS.FILEBASE_ACCESS_KEY, SECRETS.FILEBASE_SECRET_KEY, filebaseToken(seen.env)]) assert.ok(!log.includes(secret), `the log shows ${secret}`);
  assert.ok(log.includes('*** *** *** Bearer ***'), log);
});

test('publish-index tells a county left out, or an index on main the name does not serve yet, from a failure', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const left = `not indexed: MN/hennepin county (deferred): Filebase does not list ${CID_A} as pinned (not listed)`;
  const otherLeft = left.replace('MN/hennepin', 'GA/fulton');
  const published = 'Published index.json bafkreiprevious (unchanged)';
  const served = 'indexed=true\ncid=bafkreiprevious\n';
  for (const { output, stderr = [], result, error } of [
    { output: served, stderr: [left, '1 publication(s) on main are not in the index'], result: { ok: false, reason: 'county-left-out', indexed: true, indexCid: 'bafkreiprevious', groups: [], countyIndexed: false, summary: `${published}\n${left}` } },
    // Another county left out does not hold this one's publication back.
    { output: served, stderr: [otherLeft], result: { ok: true, indexed: true, indexCid: 'bafkreiprevious', groups: [], countyIndexed: true, summary: `${published}\n${otherLeft}` } },
    { output: 'indexed=true\n', stderr: [left], result: { ok: false, reason: 'not-served', indexed: true, indexCid: null, groups: [], countyIndexed: false, summary: `index.json is on main, but publish-index.mjs ended with exit code 1 before the IPNS name served it (see the log)\n${left}` } },
    { output: '', error: 'index.json did not reach main: publish-index.mjs ended with exit code 1' },
    { output: served, error: 'publish-index.mjs ended with exit code 1 without leaving a group out' },
  ]) {
    const runScript = async (_script, _args, { env }) => (writeFileSync(env.GITHUB_OUTPUT, output), output.includes('cid=') && writeFileSync(env.GITHUB_STEP_SUMMARY, `${published}\n`), { code: 1, stderr });
    const outcome = await run(publishIndex, { env: mainEnv(remote, publishIndex), deps: { runScript } });
    assert.equal(outcome.code, error ? 1 : 0, outcome.err);
    assert.deepEqual(outcome.result, result);
    if (error) assert.ok(outcome.err.includes(error), outcome.err);
  }
});

// ---- withdraw

test("withdraw takes the county's withdrawn group off main with the scripts and reports the commit", async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const { code, result } = await run(withdraw, { env: mainEnv(remote, withdraw), inputs: { 'held.json': [withdrawnHold(), withdrawnHold({ path: LEE, county: 'FL/lee', cid: CID_C, tables: CID_D, root: CID_C })] } });
  assert.equal(code, 0);
  assert.deepEqual(result, { withdrawn: true, commitSha: remote.main(), root: CID_A, summary: `Withdrew MN/hennepin county: ${withdrawnHold().reason}.` });
  assert.equal(remote.onMain(HENNEPIN), '', 'the page is gone from main');
  assert.equal(remote.onMain(LEE), LEE, "another county's hold is left to its own run");
});

test("withdraw fails without a hold of the county or with one on another page, and reports when main no longer holds what failed", async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const tip = remote.main();
  for (const [inputs, message] of [
    [{}, 'input held.json is required'],
    [{ 'held.json': [withdrawnHold({ kind: 'deferred' })] }, 'held.json names no withdrawn group of MN/hennepin'],
    [{ 'held.json': [withdrawnHold({ path: LEE, cid: CID_C, tables: CID_D })] }, 'held.json holds MN/hennepin county on counties/FL/lee.json, not counties/MN/hennepin.json'],
  ]) {
    const { code, err } = await run(withdraw, { env: mainEnv(remote, withdraw), inputs });
    assert.equal(code, 1);
    assert.ok(err.includes(message), err);
  }
  assert.deepEqual([remote.main(), remote.onMain(LEE)], [tip, LEE], 'nothing was pushed');
  remote.merge({ [HENNEPIN]: hennepin({ groups: { county: group({ cid: CID_D, tables: CID_C }) } }) });
  // Main moved on (a new version of the page merged): withdraw.mjs leaves it alone and says so; that is a finished run.
  const moved = remote.main();
  const changed = await run(withdraw, { env: mainEnv(remote, withdraw), inputs: { 'held.json': [withdrawnHold()] } });
  assert.equal(changed.code, 0);
  assert.deepEqual(changed.result, { withdrawn: false, commitSha: null, root: CID_A, summary: 'Nothing left to withdraw on main for MN/hennepin: main no longer holds the roots that failed, or the index lists them.' });
  assert.equal(remote.main(), moved, 'nothing was pushed');
});

// ---- results the executor can return

test('a result always fits in 60,000 bytes as one JSON object, its summary shortened when it must be', async () => {
  // check-page on a page with thousands of broken groups: validate-entry reports three problems for each.
  const remote = registryWithLee();
  const broken = Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`g${i}`, group({ cid: 'not-a-cid', schema: 'not-a-cid', tables: 'not-a-cid' })]));
  const head = remote.pullRequest({ [HENNEPIN]: hennepin({ groups: broken }) });
  const checked = await run(checkPage, { env: prEnv(remote, head) });
  assert.equal(checked.result.ok, false);
  assert.ok(checked.result.summary.startsWith('counties/MN/hennepin.json: /groups/g0/cid must match pattern'), checked.result.summary.slice(0, 200));
  assert.match(checked.result.summary, SHORTENED);
  assert.ok(checked.err.split('\n').filter((line) => line.startsWith(`${HENNEPIN}: `)).length >= 12_000, 'the log keeps every problem');

  // publish-index while every county of a full registry is left out of the index.
  remote.merge({ [HENNEPIN]: hennepin() });
  const counties = Array.from({ length: 3_143 }, (_, i) => page({ state: 'TX', county: `county-${i}`, fips: String(10_000 + i), groups: { county: group(), property_improvement: group(), hoa: group() } }));
  const everyCountyLeft = async (_script, _args, { cwd, env }) => {
    writeFileSync(join(cwd, 'index.json'), JSON.stringify(indexOf(...counties, hennepin()), null, 2) + '\n');
    writeFileSync(env.GITHUB_OUTPUT, 'indexed=true\ncid=bafkreiindex\n');
    const stderr = [...counties, hennepin()].flatMap((p) => Object.keys(p.groups).map((key) => `not indexed: ${p.state}/${p.county} ${key} (deferred): Filebase does not list ${CID_A} as pinned (not listed)`));
    return { code: 1, stderr };
  };
  const published = await run(publishIndex, { env: mainEnv(remote, publishIndex), deps: { runScript: everyCountyLeft } });
  assert.deepEqual(published.result.groups, [{ group: 'county', archiveCid: CID_A }], 'only the county asked about');
  assert.equal(published.result.countyIndexed, false, 'judged on every line, not the shortened summary');
  assert.match(published.result.summary, SHORTENED);

  // transfer with thousands of holds and a withdrawal whose reason is one very long line.
  const reason = `/ipfs/${CID_A}?format=car not available from any gateway within 20 min: ${Array.from({ length: 5_000 }, (_, i) => `https://gw${i}.test/ipfs/${CID_A}?format=car: HTTP 504`).join('; ')}`;
  const holds = [withdrawnHold({ reason }), ...Array.from({ length: 3_000 }, (_, i) => withdrawnHold({ county: `TX/county-${i}`, path: `counties/TX/county-${i}.json`, kind: 'deferred', reason: 'pin/ls: HTTP 500' }))];
  const runScript = async (_script, _args, { env }) => (writeFileSync(env.ATLAS_HELD, JSON.stringify(holds)), { code: 1, stderr: [] });
  const transferred = await run(transfer, { env: mainEnv(remote, transfer), deps: { runScript } });
  assert.deepEqual([transferred.result.withdraw, transferred.result.root], [true, CID_A]);
  assert.match(transferred.result.summary, SHORTENED);
  assert.equal(transferred.held[0].reason, reason, 'held.json is an output, not the result: it keeps the whole reason');
});

test('a summary keeps at most 16,000 characters, and less beside a large result; a result that cannot fit 60,000 bytes, or is not one JSON object, fails the run and writes nothing', async () => {
  const longest = 'x'.repeat(MAX_SUMMARY_CHARACTERS);
  const groups = (n) => Array.from({ length: n }, (_, i) => ({ group: `group_${i}`, archiveCid: CID_A }));
  for (const [result, expected] of [
    [{ ok: true, summary: longest }, (summary) => assert.equal(summary, longest, 'kept as it is at the limit')],
    [{ ok: true, summary: `${longest}x` }, (summary) => {
      assert.equal(summary.length, MAX_SUMMARY_CHARACTERS);
      assert.match(summary, SHORTENED);
      assert.ok(summary.startsWith('x'.repeat(MAX_SUMMARY_CHARACTERS - 100)), 'as much of its start as fits');
    }],
    [{ ok: true, groups: groups(400), summary: longest }, (summary) => {
      assert.match(summary, SHORTENED);
      assert.ok(summary.length < MAX_SUMMARY_CHARACTERS - 1_000, `${summary.length} characters beside 400 groups`);
    }],
    [{ groups: groups(10_000) }, `bytes; at most ${MAX_RESULT_BYTES} fit`],
    [['not', 'an', 'object'], 'result must be one JSON object'],
    [null, 'result must be one JSON object'],
  ]) {
    const outcome = await run({ ...checkPage, parameters: [], run: async () => ({ result }) }, { env: {} });
    if (typeof expected === 'function') expected(outcome.result.summary);
    else {
      assert.equal(outcome.code, 1);
      assert.ok(outcome.err.includes(expected), outcome.err);
    }
  }
});

// ---- running a script

test('a script runs in a process of its own, its output redacted and its stderr kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-script-'));
  const script = join(dir, 'script.mjs');
  writeFileSync(script, `console.log('stdout ' + process.env.TOKEN); console.error('stderr line'); process.exit(3);\n`);
  const out = [];
  const code = await runCommand({ ...verify, parameters: [], run: async ({ env }) => ({ result: await runNode(script, [], { cwd: dir, env: { ...env, TOKEN: SECRETS.ATLAS_GATEWAY_TOKEN } }) }) }, { argv: startedUnder(VALIDATION), env: secretsOf(VALIDATION), outputs: dir, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), { code: 3, signal: null, stderr: ['stderr line'] });
  assert.ok(out.join('').includes('stdout ***'), out.join(''));
});
