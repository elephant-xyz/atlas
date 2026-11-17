import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { command as checkPage } from '../command/check-page.mjs';
import { command as verify } from '../command/verify.mjs';
import { command as transfer } from '../command/transfer.mjs';
import { command as publishIndex } from '../command/publish-index.mjs';
import { command as withdraw } from '../command/withdraw.mjs';
import { IMAGE_ROOT, imageFiles, runCommand, runNode } from '../command/lib.mjs';
import { buildEntries } from '../scripts/lib.mjs';
import { CID_A, CID_B, CID_C, CID_D, group, page } from './helpers.mjs';

const configurationFile = (id) => JSON.parse(readFileSync(new URL(`../command/${id}.json`, import.meta.url), 'utf8'));
const VALIDATION = configurationFile('atlas-command-validation');
const PUBLICATION = configurationFile('atlas-command-publication');
const CONFIGURATIONS = [VALIDATION, PUBLICATION];
const COMMANDS = { 'check-page': checkPage, verify, transfer, 'publish-index': publishIndex, withdraw };
const configurationOf = (name) => CONFIGURATIONS.find((c) => Object.hasOwn(c.commands, name));
/** The arguments a configuration starts an entry point with, after `node <entry point>`. */
const startedUnder = (configuration) => ['--configuration', configuration.id];
const PUBLICATION_ONLY_SECRETS = ['ATLAS_DEPLOY_KEY', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'];

const HENNEPIN = 'counties/MN/hennepin.json';
const LEE = 'counties/FL/lee.json';
const hennepin = (overrides = {}) => page({ county: 'hennepin', state: 'MN', fips: '27053', ...overrides });
const lee = page({ groups: { county: group({ cid: CID_C, tables: CID_D }) } });
const indexOf = (...pages) => ({ version: 1, generated_from: 'x', counties: buildEntries(pages.map((page) => ({ page })), () => undefined) });
const PRIVATE_GATEWAY = 'https://private-gateway.test';
const GATEWAY_SECRETS = { ATLAS_GATEWAYS: PRIVATE_GATEWAY, ATLAS_GATEWAY_TOKEN: 'gateway-token-value' };
const SECRETS = { ...GATEWAY_SECRETS, FILEBASE_ACCESS_KEY: 'filebase-access-value', FILEBASE_SECRET_KEY: 'filebase-secret-value', ATLAS_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-deploy-key\n-----END OPENSSH PRIVATE KEY-----' };
const withdrawnHold = (overrides = {}) => ({ path: HENNEPIN, county: 'MN/hennepin', key: 'county', kind: 'withdrawn', cid: CID_A, tables: CID_B, root: CID_A, reason: `/ipfs/${CID_A}?format=car not available from any gateway within 20 min`, ...overrides });

const g = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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
  const write = (changes) => {
    for (const [path, value] of Object.entries(changes)) {
      if (value === null) rmSync(join(dev, path));
      else {
        mkdirSync(dirname(join(dev, path)), { recursive: true });
        writeFileSync(join(dev, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
      }
    }
    g(dev, 'add', '-A');
    g(dev, 'commit', '-q', '-m', 'change');
    return g(dev, 'rev-parse', 'HEAD');
  };
  /** Commit `changes` ({ path: object | string | null }) on main and push it: one merge. */
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

/** Run `command` in process as the executor would, with `inputs` ({ name: object }) staged; returns its exit code, outputs and log. */
async function run(command, { env, inputs = {}, deps, argv = startedUnder(configurationOf(command.name)) } = {}) {
  const inputsDir = mkdtempSync(join(tmpdir(), 'atlas-inputs-'));
  const outputs = mkdtempSync(join(tmpdir(), 'atlas-outputs-'));
  for (const [name, value] of Object.entries(inputs)) writeFileSync(join(inputsDir, name), JSON.stringify(value));
  const out = [];
  const err = [];
  const code = await runCommand(command, { argv, env: { ...env }, inputs: inputsDir, outputs, deps, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  const read = (name) => (existsSync(join(outputs, name)) ? JSON.parse(readFileSync(join(outputs, name), 'utf8')) : undefined);
  return { code, result: read('result.json'), held: read('held.json'), outputs, out: out.join(''), err: err.join('') };
}

const prEnv = (remote, head, extra = {}) => ({ ATLAS_REPOSITORY_URL: remote.url, ATLAS_HEAD_SHA: head, ATLAS_PAGE: HENNEPIN, ...GATEWAY_SECRETS, ...extra });
const mainEnv = (remote, extra = {}) => ({ ATLAS_REPOSITORY_URL: remote.url, ATLAS_COUNTY: 'MN/hennepin', ATLAS_MAIN_SHA: remote.main(), ...SECRETS, ...extra });
const registryWithLee = () => atlasRemote({ [LEE]: lee, 'index.json': indexOf(lee) });

// ---- the configurations

test('two configurations of one image split the commands: validation for pull requests, publication for main', () => {
  assert.deepEqual([VALIDATION.id, PUBLICATION.id], ['atlas-command-validation', 'atlas-command-publication']);
  for (const { id } of CONFIGURATIONS) assert.ok(id.length <= 64, `${id} fits Transform's 64-character id`);
  assert.deepEqual(Object.keys(VALIDATION.commands).sort(), ['check-page', 'verify']);
  assert.deepEqual(Object.keys(PUBLICATION.commands).sort(), ['publish-index', 'transfer', 'withdraw']);
  assert.equal(VALIDATION.image, PUBLICATION.image, 'the same image');
  const dockerfile = readFileSync(new URL('../command/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^WORKDIR \/opt\/atlas$/m);
  for (const configuration of CONFIGURATIONS) {
    const commands = Object.keys(configuration.commands).map((name) => COMMANDS[name]);
    for (const command of commands) assert.deepEqual(configuration.commands[command.name], ['node', `/opt/atlas/command/${command.name}.mjs`, ...startedUnder(configuration)]);
    // Each declares exactly what its own commands use, and nothing for the other configuration's.
    const used = (pick) => [...new Set(commands.flatMap(pick))].sort();
    assert.deepEqual(Object.keys(configuration.parameters).sort(), used((c) => c.parameters.map(({ name }) => name)), `${configuration.id} parameters`);
    assert.deepEqual(Object.keys(configuration.secretEnvironment).sort(), used((c) => [...c.secrets.required, ...c.secrets.optional]), `${configuration.id} secrets`);
    assert.deepEqual(configuration.inputs.map(({ name }) => name).sort(), used((c) => c.inputs), `${configuration.id} inputs`);
    assert.deepEqual(configuration.outputs.map(({ name }) => name).sort(), used((c) => c.outputs), `${configuration.id} outputs`);
  }
});

test('a validation command can never see a publication secret', async () => {
  assert.deepEqual(Object.keys(VALIDATION.secretEnvironment).sort(), ['ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN']);
  for (const secret of PUBLICATION_ONLY_SECRETS) assert.ok(!Object.hasOwn(VALIDATION.secretEnvironment, secret), `${VALIDATION.id} declares ${secret}`);
  const env = { ATLAS_REPOSITORY_URL: '/nonexistent/atlas.git', ATLAS_HEAD_SHA: 'a'.repeat(40), ATLAS_PAGE: HENNEPIN, ...GATEWAY_SECRETS };
  for (const command of [checkPage, verify]) {
    // A task that received one anyway (a configuration registered otherwise) is refused before anything runs.
    for (const secret of PUBLICATION_ONLY_SECRETS) {
      const { code, result, err } = await run(command, { env: { ...env, [secret]: SECRETS[secret] } });
      assert.equal(code, 1);
      assert.equal(result, undefined);
      assert.ok(err.includes(`${secret} reached ${command.name} under atlas-command-validation, which does not declare it`), err);
      assert.ok(!err.includes('clone') && !err.includes(SECRETS[secret].split('\n')[1]), err);
    }
  }
});

test('an entry point refuses to run unless the configuration it was started under has its command', async () => {
  for (const command of Object.values(COMMANDS)) {
    const other = CONFIGURATIONS.find((c) => c !== configurationOf(command.name));
    for (const [argv, message] of [
      [startedUnder(other), `${command.name} is not a command of ${other.id}`],
      [[], 'must be started with --configuration <id>'],
      [['--configuration', 'atlas-command'], "'atlas-command' is not a configuration of this image"],
    ]) {
      const { code, result, err } = await run(command, { argv, env: { ATLAS_REPOSITORY_URL: '/nonexistent/atlas.git' } });
      assert.equal(code, 1, `${command.name} ${argv.join(' ')}`);
      assert.equal(result, undefined);
      assert.ok(err.includes(message), err);
    }
  }
});

test("parameter patterns accept the consumer's values as whole values only, the same in both configurations", () => {
  const patterns = {};
  for (const configuration of CONFIGURATIONS) {
    for (const [name, { pattern }] of Object.entries(configuration.parameters)) {
      assert.equal(patterns[name] ?? pattern, pattern, `${name} has one pattern`);
      patterns[name] = pattern;
    }
  }
  const whole = (name) => new RegExp(`^(?:${patterns[name]})$`, 'u');
  const samples = {
    ATLAS_HEAD_SHA: ['5d3c1f0e9a2b4c6d8e0f1a2b3c4d5e6f7a8b9c0d', ['5d3c1f0e', '5D3C1F0E9A2B4C6D8E0F1A2B3C4D5E6F7A8B9C0D']],
    ATLAS_MAIN_SHA: ['fd148cd58a79ed54cbbc6df3459695646a55d4a2', ['main', 'fd148cd']],
    ATLAS_PAGE: [HENNEPIN, ['counties/MN/hennepin/extra.json', 'index.json', 'counties/MN/:(top)x.json', 'counties/../x.json']],
    ATLAS_COUNTY: ['MN/hennepin', ['MN/Hennepin', 'mn/hennepin', 'MN/hennepin/x']],
    ATLAS_GATEWAY_DEADLINE_MINUTES: ['20', ['0', '20m', '-1']],
  };
  assert.deepEqual(Object.keys(patterns).sort(), Object.keys(samples).sort());
  for (const [name, [good, bad]] of Object.entries(samples)) {
    assert.ok(whole(name).test(good), `${name} accepts ${good}`);
    for (const value of [...bad, `${good}\n`, ` ${good}`]) assert.ok(!whole(name).test(value), `${name} refuses ${JSON.stringify(value)}`);
  }
  // A badly named page still reaches validate-entry, which explains what is wrong with it.
  assert.ok(whole('ATLAS_PAGE').test('counties/mn/Hennepin_County.json'));
});

test('the committed configurations never name an image digest: the image is pinned when they are registered', () => {
  for (const { image } of CONFIGURATIONS) {
    assert.doesNotMatch(image, /@sha256:[a-f0-9]{64}$/);
    assert.equal(image, 'PLACEHOLDER_ATLAS_COMMAND_IMAGE_PINNED_BY_DIGEST');
  }
});

// ---- what every command does before it runs anything

test('--help lists the parameters with their patterns, the secrets, inputs and outputs', async () => {
  const out = [];
  const code = await runCommand(transfer, { argv: [...startedUnder(PUBLICATION), '--help'], env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} } });
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /^atlas-command transfer \(atlas-command-publication\): /);
  assert.match(text, /^atlas-command transfer \(atlas-command-publication\): /);
  assert.match(text, /ATLAS_COUNTY\s+required\s+\[A-Z\]\{2\}/);
  assert.match(text, /ATLAS_GATEWAY_DEADLINE_MINUTES\s+optional/);
  assert.match(text, /FILEBASE_ACCESS_KEY/);
  assert.match(text, /result\.json/);
  assert.match(text, /held\.json/);
});

test('a missing, malformed or foreign parameter fails before anything is fetched, and writes no result', async () => {
  const env = { ATLAS_REPOSITORY_URL: '/nonexistent/atlas.git', ATLAS_HEAD_SHA: 'a'.repeat(40), ATLAS_PAGE: HENNEPIN };
  for (const [changed, message] of [
    [{ ATLAS_PAGE: undefined }, 'ATLAS_PAGE is required'],
    [{ ATLAS_HEAD_SHA: 'main' }, 'ATLAS_HEAD_SHA does not match its pattern'],
    [{ ATLAS_COUNTY: 'MN/hennepin' }, 'ATLAS_COUNTY is not a parameter of check-page'],
  ]) {
    const { code, result, err } = await run(checkPage, { env: Object.fromEntries(Object.entries({ ...env, ...changed }).filter(([, v]) => v !== undefined)) });
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

test("check-page reports validate-entry's problems as ok: false, in its own words", async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin({ county: 'hennepin-county' }) });
  const { code, result } = await run(checkPage, { env: prEnv(remote, head) });
  assert.equal(code, 0, 'a page that fails its checks is a result, not an error');
  assert.deepEqual(result, { ok: false, summary: 'counties/MN/hennepin.json: path must be counties/MN/hennepin-county.json' });
});

test('check-page refuses a head that changes more than the page it was given', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin(), 'scripts/validate-entry.mjs': '// checks of its own\n' });
  const { code, result, err } = await run(checkPage, { env: prEnv(remote, head) });
  assert.equal(code, 1);
  assert.equal(result, undefined);
  assert.match(err, /changes 2 file\(s\) against its base [0-9a-f]{40}, not only counties\/MN\/hennepin\.json/);
});

test("check-page refuses to run when the image's Atlas files are not the merge base's", async () => {
  const remote = registryWithLee();
  remote.merge({ 'scripts/lib.mjs': `${readFileSync(join(IMAGE_ROOT, 'scripts/lib.mjs'), 'utf8')}// changed on main\n`, 'scripts/new-check.mjs': '// new on main\n' });
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const { code, result, err } = await run(checkPage, { env: prEnv(remote, head) });
  assert.equal(code, 1);
  assert.equal(result, undefined);
  assert.match(err, /this image's Atlas files are not the ones at [0-9a-f]{40}/);
  assert.match(err, /scripts\/lib\.mjs differs/);
  assert.match(err, /scripts\/new-check\.mjs is not in the image/);
});

// ---- verify

test('verify checks each changed group with the scripts, the CSV in the outputs', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const seen = [];
  const deps = {
    verifyGroup: async (target, d) => {
      seen.push({ target: `${target.path} ${target.key} ${target.cid}`, csv: d.csv });
      d.validateCar('archive.car');
    },
    validateCar: (file, csv) => seen.push({ file, csv }),
  };
  const { code, result, outputs } = await run(verify, { env: prEnv(remote, head), deps });
  assert.equal(code, 0);
  assert.deepEqual(result, { ok: true, summary: 'ok counties/MN/hennepin.json group county' });
  assert.deepEqual(seen, [{ target: `${HENNEPIN} county ${CID_A}`, csv: 'validation-errors.csv' }, { file: 'archive.car', csv: join(outputs, 'validation-errors.csv') }]);
});

test('verify reports a failing group as ok: false, with private gateways and secrets taken out', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  const verifyGroup = async () => {
    console.log(`fetched ${PRIVATE_GATEWAY}/ipfs/${CID_A}?format=car with ${SECRETS.ATLAS_GATEWAY_TOKEN}`);
    throw new Error(`/ipfs/${CID_A}?format=car not available from any gateway within 20 min: ${PRIVATE_GATEWAY}/ipfs/${CID_A}?format=car: HTTP 504`);
  };
  const { code, result, out } = await run(verify, { env: prEnv(remote, head), deps: { verifyGroup } });
  assert.equal(code, 0);
  assert.equal(result.ok, false);
  assert.equal(result.summary, `FAIL counties/MN/hennepin.json group county: /ipfs/${CID_A}?format=car not available from any gateway within 20 min: https://<private gateway>/ipfs/${CID_A}?format=car: HTTP 504`);
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
  const { code, result, held } = await run(transfer, { env: mainEnv(remote, { ATLAS_MAIN_SHA: merged, ATLAS_GATEWAY_DEADLINE_MINUTES: '5' }), deps: { runScript } });
  assert.equal(code, 0);
  assert.deepEqual(result, { withdraw: false, summary: '2 root(s) pinned' });
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

test("transfer reports this county's withdrawal and writes the hold for withdraw", async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const holds = [withdrawnHold(), { ...withdrawnHold({ path: LEE, county: 'FL/lee', kind: 'deferred', root: CID_C }) }];
  const runScript = async (_script, _args, { env }) => (writeFileSync(env.ATLAS_HELD, JSON.stringify(holds)), { code: 1, stderr: [] });
  const { code, result, held } = await run(transfer, { env: mainEnv(remote), deps: { runScript } });
  assert.equal(code, 0);
  assert.deepEqual(result, { withdraw: true, root: CID_A, summary: `MN/hennepin county (withdrawn): ${withdrawnHold().reason}` });
  assert.deepEqual(held, [withdrawnHold()]);
});

test('transfer fails, and withdraws nothing, when the county is only deferred or the service is down', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  for (const [code, holds, message] of [
    [1, [withdrawnHold({ kind: 'deferred', reason: 'pin/ls: HTTP 500' })], 'MN/hennepin county (deferred): pin/ls: HTTP 500; nothing is withdrawn'],
    [2, undefined, 'nothing transferred: the gateways or Filebase were down'],
    [1, undefined, 'transfer-roots.mjs ended with exit code 1 and wrote no holds'],
  ]) {
    const runScript = async (_script, _args, { env }) => (holds && writeFileSync(env.ATLAS_HELD, JSON.stringify(holds)), { code, stderr: [] });
    const outcome = await run(transfer, { env: mainEnv(remote), deps: { runScript } });
    assert.equal(outcome.code, 1);
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.held, undefined);
    assert.ok(outcome.err.includes(message), outcome.err);
  }
});

test('a publication command refuses a commit that is not on main', async () => {
  const remote = registryWithLee();
  const head = remote.pullRequest({ [HENNEPIN]: hennepin() });
  let ran = false;
  const { code, err } = await run(transfer, { env: mainEnv(remote, { ATLAS_MAIN_SHA: head }), deps: { runScript: async () => (ran = true) } });
  assert.equal(code, 1);
  assert.ok(err.includes(`${head} is not on main`), err);
  assert.equal(ran, false);
});

// ---- publish-index

test('publish-index publishes from main with the deploy key on SSH, and reports the groups the index lists for the county', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const seen = {};
  const runScript = async (script, args, { cwd, env }) => {
    Object.assign(seen, { script, args, env, pushUrl: g(cwd, 'config', 'remote.origin.pushurl'), ssh: g(cwd, 'config', 'core.sshCommand'), user: g(cwd, 'config', 'user.name') });
    const key = /-i '([^']+)'/.exec(seen.ssh)[1];
    Object.assign(seen, { key: readFileSync(key, 'utf8'), mode: statSync(key).mode & 0o777 });
    writeFileSync(join(cwd, 'index.json'), JSON.stringify(indexOf(lee, hennepin()), null, 2) + '\n');
    writeFileSync(env.GITHUB_OUTPUT, 'indexed=true\ncid=bafkreiindex\n');
    writeFileSync(env.GITHUB_STEP_SUMMARY, 'Published index.json bafkreiindex (updated); ipns k51 -> /ipfs/bafkreiindex\n');
    return { code: 0, stderr: [] };
  };
  const { code, result } = await run(publishIndex, { env: mainEnv(remote), deps: { runScript } });
  assert.equal(code, 0);
  assert.deepEqual(result, { indexCid: 'bafkreiindex', groups: [{ group: 'county', archiveCid: CID_A }], countyIndexed: true, summary: 'Published index.json bafkreiindex (updated); ipns k51 -> /ipfs/bafkreiindex' });
  assert.equal(seen.script, join(IMAGE_ROOT, 'scripts/publish-index.mjs'));
  assert.deepEqual(seen.args, []);
  assert.equal(seen.pushUrl, remote.url);
  assert.match(seen.ssh, /-o IdentitiesOnly=yes/);
  assert.match(seen.ssh, /-o UserKnownHostsFile='[^']+\/command\/known_hosts'/);
  assert.match(seen.ssh, /-o StrictHostKeyChecking=yes/);
  assert.equal(seen.key, `${SECRETS.ATLAS_DEPLOY_KEY}\n`);
  assert.equal(seen.mode, 0o600);
  assert.ok(seen.user);
  assert.equal(seen.env.ATLAS_DEPLOY_KEY, undefined, 'the key reaches git as a file, not the script as a variable');
  assert.equal(seen.env.ATLAS_GATEWAY_TOKEN, undefined);
  assert.equal(seen.env.FILEBASE_SECRET_KEY, SECRETS.FILEBASE_SECRET_KEY);
  assert.equal(seen.env.ATLAS_IPNS_ID, 'k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04');
  assert.equal(seen.env.ATLAS_PENDING_HOURS, 'Infinity', 'Publication pending issues are not opened from the executor');
});

test('publish-index succeeds once the index is served even when it left groups out, and fails when it never got there', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const left = `not indexed: MN/hennepin county (deferred): Filebase does not list ${CID_A} as pinned (not listed)`;
  const script = ({ code, output, stderr = [] }) => async (_script, _args, { env }) => (writeFileSync(env.GITHUB_OUTPUT, output), writeFileSync(env.GITHUB_STEP_SUMMARY, 'Published index.json bafkreiprevious (unchanged)\n'), { code, stderr });
  const published = await run(publishIndex, { env: mainEnv(remote), deps: { runScript: script({ code: 1, output: 'indexed=true\ncid=bafkreiprevious\n', stderr: [left, '1 publication(s) on main are not in the index'] }) } });
  assert.equal(published.code, 0);
  assert.deepEqual(published.result, { indexCid: 'bafkreiprevious', groups: [], countyIndexed: false, summary: `Published index.json bafkreiprevious (unchanged)\n${left}` });
  const otherLeft = await run(publishIndex, { env: mainEnv(remote), deps: { runScript: script({ code: 1, output: 'cid=bafkreiprevious\n', stderr: [left.replace('MN/hennepin', 'GA/fulton')] }) } });
  assert.equal(otherLeft.result.countyIndexed, true, "another county left out does not hold this one's publication back");
  for (const [outcome, message] of [
    [{ code: 1, output: 'indexed=true\n' }, 'index.json was not published: publish-index.mjs ended with exit code 1 after committing it to main'],
    [{ code: 1, output: 'indexed=true\ncid=bafkreiprevious\n' }, 'publish-index.mjs ended with exit code 1 without leaving a group out'],
  ]) {
    const failed = await run(publishIndex, { env: mainEnv(remote), deps: { runScript: script(outcome) } });
    assert.equal(failed.code, 1);
    assert.equal(failed.result, undefined);
    assert.ok(failed.err.includes(message), failed.err);
  }
});

test('publish-index needs the deploy key', async () => {
  const remote = registryWithLee();
  const { code, err } = await run(publishIndex, { env: mainEnv(remote, { ATLAS_DEPLOY_KEY: '' }), deps: { runScript: async () => assert.fail('ran') } });
  assert.equal(code, 1);
  assert.ok(err.includes('secret(s) ATLAS_DEPLOY_KEY required'), err);
});

// ---- withdraw

test("withdraw takes the county's withdrawn group off main with the scripts and reports the commit", async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const { code, result } = await run(withdraw, { env: mainEnv(remote), inputs: { 'held.json': [withdrawnHold(), withdrawnHold({ path: LEE, county: 'FL/lee', cid: CID_C, tables: CID_D, root: CID_C })] } });
  assert.equal(code, 0);
  assert.deepEqual(result, { commitSha: remote.main(), root: CID_A, summary: `Withdrew MN/hennepin county: ${withdrawnHold().reason}.` });
  assert.equal(remote.onMain(HENNEPIN), '', 'the page is gone from main');
  assert.equal(remote.onMain(LEE), LEE, "another county's hold is left to its own run");
});

test('withdraw fails without a hold of the county, and when main no longer holds what failed', async () => {
  const remote = registryWithLee();
  remote.merge({ [HENNEPIN]: hennepin() });
  const noInput = await run(withdraw, { env: mainEnv(remote) });
  assert.equal(noInput.code, 1);
  assert.ok(noInput.err.includes('input held.json is required'), noInput.err);
  const deferred = await run(withdraw, { env: mainEnv(remote), inputs: { 'held.json': [withdrawnHold({ kind: 'deferred' })] } });
  assert.ok(deferred.err.includes('held.json names no withdrawn group of MN/hennepin'), deferred.err);
  remote.merge({ [HENNEPIN]: hennepin({ groups: { county: group({ cid: CID_D, tables: CID_C }) } }) });
  const changed = await run(withdraw, { env: mainEnv(remote), inputs: { 'held.json': [withdrawnHold()] } });
  assert.equal(changed.code, 1);
  assert.equal(changed.result, undefined);
  assert.ok(changed.err.includes('nothing left to withdraw on main for MN/hennepin'), changed.err);
});

// ---- running a script

test('a script runs in a process of its own, its output redacted and its stderr kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-script-'));
  const script = join(dir, 'script.mjs');
  writeFileSync(script, `console.log('stdout ' + process.env.TOKEN); console.error('stderr line'); process.exit(3);\n`);
  const out = [];
  const code = await runCommand({ ...checkPage, parameters: [], run: async ({ env }) => ({ result: await runNode(script, [], { cwd: dir, env: { ...env, TOKEN: SECRETS.ATLAS_GATEWAY_TOKEN } }) }) }, { argv: startedUnder(VALIDATION), env: { ...GATEWAY_SECRETS }, outputs: dir, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), { code: 3, signal: null, stderr: ['stderr line'] });
  assert.ok(out.join('').includes('stdout ***'), out.join(''));
});
