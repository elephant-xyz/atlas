// What every Atlas command shares when Transform's command executor runs it: parameters from
// the environment checked against command/configuration.json, secrets kept to the command that
// needs them and out of every log and result, a checkout of the registry fetched from GitHub,
// the check that this image runs the base commit's scripts, and result.json written only on
// success. A command is `{ name, summary, returns, parameters, secrets, inputs, outputs, run, deps }`;
// its file calls runCommand(command), which exits 0 with result.json written or 1 with none.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { redactGateways } from '../scripts/gateways.mjs';
import { baseRef, git, refExists } from '../scripts/lib.mjs';

/** The repository root, where the image keeps the Atlas files it runs (/opt/atlas). */
export const IMAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIGURATION = JSON.parse(readFileSync(new URL('./configuration.json', import.meta.url), 'utf8'));
const KNOWN_HOSTS = fileURLToPath(new URL('./known_hosts', import.meta.url));

/** Where the executor mounts a run's inputs (read-only) and copies its outputs from. */
const INPUTS_DIR = '/transform/inputs';
const OUTPUTS_DIR = '/transform/outputs';
export const RESULT_FILE = 'result.json';
/** The holds transfer writes and withdraw reads (transfer-roots.mjs's ATLAS_HELD). */
export const HELD_FILE = 'held.json';
/** The hold kind that takes a publication off main (see transfer-roots.mjs). */
export const WITHDRAWN = 'withdrawn';
const HELP = '--help';
const SUCCEEDED = 0;
const FAILED = 1;

/**
 * Reads are anonymous over HTTPS (the repository is public); pushes use the deploy key over SSH
 * on port 443, the only port the executor's tasks may reach. ATLAS_REPOSITORY_URL replaces both
 * for tests and local fixture runs: it is no declared parameter, so a run cannot set it.
 */
const REPOSITORY_URL = 'https://github.com/elephant-xyz/atlas.git';
const PUSH_URL = 'ssh://git@ssh.github.com:443/elephant-xyz/atlas.git';
const REPOSITORY_OVERRIDE = 'ATLAS_REPOSITORY_URL';
const MAIN = 'main';
const ORIGIN_MAIN = 'origin/main';
const CHECKOUT_DIR = 'atlas';
const DEPLOY_KEY = 'ATLAS_DEPLOY_KEY';
const DEPLOY_KEY_FILE = 'deploy-key';
const OWNER_ONLY = 0o600;
/** Who the commits made through the deploy key are by: not the Actions bot, which still runs today. */
const COMMIT_NAME = 'Atlas command executor';
const COMMIT_EMAIL = 'atlas-command@elephant.invalid';
/** git's name-status for the page change a pull request may make: added or modified. */
const PAGE_CHANGES = ['A', 'M'];

/**
 * Settings publish.yml gives transfer-roots.mjs and publish-index.mjs (repository variables at
 * their defaults). ATLAS_RUN_MINUTES leaves the run's 360-minute limit 30 minutes for the
 * checkout before it and the outputs after it, as the job limit does for the cache.
 */
export const PUBLICATION_SETTINGS = {
  FILEBASE_BUCKET: 'elephant-atlas',
  FILEBASE_S3_ENDPOINT: 'https://s3.filebase.com',
  ATLAS_TRANSFER_PARALLEL: '8',
  ATLAS_IPNS_KEY: 'elephant-atlas',
  ATLAS_IPNS_ID: 'k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04',
  ATLAS_RUN_MINUTES: '330',
  ATLAS_ROOT_MINUTES: '330',
  ATLAS_PIN_MINUTES: '330',
  ATLAS_PIN_VIA: 's3',
  ATLAS_TABLES_PIN_MINUTES: '30',
  ATLAS_TABLES_CAR: 'full',
  ATLAS_SKIP_STORED_SHARDS: '0',
};

/** What replaces a secret value in logs and results; shorter pieces are not taken for secrets. */
const REDACTED = '***';
const MIN_SECRET_PIECE = 8;

/**
 * The files the image copies from the repository (see command/Dockerfile). What the image runs
 * must be exactly what the base commit holds at these paths.
 */
const IMAGE_TOP_FILES = ['package.json', 'package-lock.json'];
const IMAGE_WHOLE_DIRECTORIES = ['schema', 'scripts'];
const COMMAND_DIRECTORY = 'command';
const IMAGE_COMMAND_FILE = /^command\/(?:[a-z-]+\.mjs|configuration\.json|known_hosts)$/;

/** Whether the repository path `path` is one of the image's Atlas files. */
const inImage = (path) => IMAGE_TOP_FILES.includes(path) || IMAGE_WHOLE_DIRECTORIES.some((dir) => path.startsWith(`${dir}/`)) || IMAGE_COMMAND_FILE.test(path);

/** The image's Atlas files under `root`, as repository paths, sorted. */
export function imageFiles(root) {
  const found = [...IMAGE_TOP_FILES];
  for (const dir of [...IMAGE_WHOLE_DIRECTORIES, COMMAND_DIRECTORY]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) found.push(relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
    }
  }
  return found.filter(inImage).sort();
}

/** `^(?:<pattern>)$` with only the `u` flag: how Transform applies a parameter pattern, to the whole value. */
const wholeValue = (pattern) => new RegExp(`^(?:${pattern})$`, 'u');

/**
 * The command's parameter values from `env`. Every one the command reads must be declared in the
 * configuration and match its pattern; a parameter of another command is refused, so a miswired
 * step fails before anything is fetched. Messages name the parameter, never the value.
 */
function readParameters(command, env) {
  const mine = new Set(command.parameters.map(({ name }) => name));
  const problems = Object.keys(CONFIGURATION.parameters)
    .filter((name) => env[name] !== undefined && !mine.has(name))
    .map((name) => `${name} is not a parameter of ${command.name}`);
  const values = {};
  for (const { name, required } of command.parameters) {
    const value = env[name];
    if (value === undefined) {
      if (required) problems.push(`${name} is required`);
    } else if (!wholeValue(CONFIGURATION.parameters[name].pattern).test(value)) problems.push(`${name} does not match its pattern`);
    else values[name] = value;
  }
  if (problems.length) throw new Error(problems.join('; '));
  return values;
}

/**
 * Drop from `env` every configured secret the command does not use, so neither the scripts nor
 * the CLI they start ever see it, and require the ones it cannot run without.
 */
function keepSecrets(command, env) {
  const { required, optional } = command.secrets;
  for (const name of Object.keys(CONFIGURATION.secretEnvironment)) if (!required.includes(name) && !optional.includes(name)) delete env[name];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`secret(s) ${missing.join(', ')} required`);
}

/**
 * A function that takes every configured secret's value (and each of its lines or
 * comma-separated pieces) and every private gateway origin out of a text. The executor's logs
 * are not masked the way GitHub Actions masks secrets, and summaries are posted on pull requests.
 */
function redactor(env) {
  const pieces = Object.keys(CONFIGURATION.secretEnvironment)
    .flatMap((name) => [env[name] ?? '', ...(env[name] ?? '').split(/[\n,]/)])
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= MIN_SECRET_PIECE)
    .sort((a, b) => b.length - a.length);
  return (text) => pieces.reduce((out, piece) => out.replaceAll(piece, REDACTED), redactGateways(String(text), env));
}

/** `value` with `redact` applied to every string in it. */
const redactDeep = (value, redact) => (typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map((v) => redactDeep(v, redact)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) : value);

/** Send console output to `stdout`/`stderr`, redacted; returns the function that puts console back. */
function routeConsole(stdout, stderr, redact) {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const to = (stream) => (...args) => stream.write(`${redact(format(...args))}\n`);
  Object.assign(console, { log: to(stdout), info: to(stdout), warn: to(stderr), error: to(stderr) });
  return () => Object.assign(console, saved);
}

/**
 * Write `files` ({ name: JSON value }, result.json last) to `dir`, each through a temporary name
 * the executor does not copy, then renamed; on any failure every file already written is removed,
 * so a run never leaves part of a success behind.
 */
function writeOutputs(dir, files) {
  const written = [];
  try {
    for (const [name, value] of Object.entries(files)) {
      const partial = join(dir, `.${name}.partial`);
      written.push(name);
      writeFileSync(partial, `${JSON.stringify(value, null, 2)}\n`);
      renameSync(partial, join(dir, name));
    }
  } catch (e) {
    for (const name of written) for (const file of [name, `.${name}.partial`]) rmSync(join(dir, file), { force: true });
    throw e;
  }
}

/** --help: what the command does, takes and returns. */
function usage(command) {
  const parameter = ({ name, required }) => `  ${name.padEnd(32)} ${required ? 'required' : 'optional'}  ${CONFIGURATION.parameters[name].pattern}`;
  const secrets = [...command.secrets.required.map((name) => `${name} (required)`), ...command.secrets.optional];
  return [
    `atlas-command ${command.name}: ${command.summary}`,
    '',
    'Parameters (environment variables, whole value matching the pattern):',
    ...(command.parameters.length ? command.parameters.map(parameter) : ['  none']),
    `Secrets (environment, by reference): ${secrets.join(', ') || 'none'}`,
    `Inputs (${INPUTS_DIR}): ${command.inputs.join(', ') || 'none'}`,
    `Outputs (${OUTPUTS_DIR}): ${command.outputs.join(', ')}`,
    `${RESULT_FILE}: ${command.returns}`,
  ].join('\n');
}

/**
 * Run `command` as the executor does: no arguments, parameters and secrets in `env`, inputs in
 * `inputs`, outputs to `outputs`. Returns 0 once result.json (and any other success output) is
 * written, 1 with a message on stderr and no success output otherwise. Every line logged and
 * every value written has the secrets taken out. The work directory (checkout, deploy key) is
 * removed whatever happens.
 */
export async function runCommand(command, { argv = process.argv.slice(2), env = process.env, inputs = INPUTS_DIR, outputs = OUTPUTS_DIR, stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  const redact = redactor(env);
  const restore = routeConsole(stdout, stderr, redact);
  try {
    if (argv.includes(HELP)) {
      console.log(usage(command));
      return SUCCEEDED;
    }
    if (argv.length) throw new Error(`takes no arguments; parameters come as environment variables (see ${HELP})`);
    const parameters = readParameters(command, env);
    keepSecrets(command, env);
    env.GIT_TERMINAL_PROMPT = '0';
    const work = mkdtempSync(join(tmpdir(), 'atlas-command-'));
    try {
      const repository = { fetchUrl: env[REPOSITORY_OVERRIDE] ?? REPOSITORY_URL, pushUrl: env[REPOSITORY_OVERRIDE] ?? PUSH_URL };
      const { result, files = {} } = await command.run({ parameters, env, work, inputs, outputs, repository }, { ...command.deps, ...deps });
      const written = redactDeep({ ...files, [RESULT_FILE]: result }, redact);
      writeOutputs(outputs, written);
      console.log(`${RESULT_FILE}: ${JSON.stringify(written[RESULT_FILE])}`);
      return SUCCEEDED;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`atlas-command ${command.name}: ${e.message}`);
    return FAILED;
  } finally {
    restore();
  }
}

/**
 * Run a Node script in a process of its own (`process.execPath script ...args`), its output
 * logged line by line through console (so redacted); resolves { code, signal, stderr } with
 * stderr's lines kept for the caller.
 */
export function runNode(script, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    createInterface({ input: child.stdout }).on('line', (line) => console.log(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderr.push(line);
      console.error(line);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

/** How a script ended, for a message: `exit code 1` or `signal SIGKILL`. */
export const ended = ({ code, signal }) => (signal ? `signal ${signal}` : `exit code ${code}`);

/** Clone main from `fetchUrl` into the work directory, without a checkout; returns its path. */
function cloneMain(work, { fetchUrl }) {
  console.log(`clone ${fetchUrl} (${MAIN})`);
  git(work, 'clone', '--quiet', '--no-checkout', '--single-branch', '--branch', MAIN, fetchUrl, CHECKOUT_DIR);
  return join(work, CHECKOUT_DIR);
}

/**
 * Differences between the image's Atlas files and the same paths at `base` in the checkout at
 * `root`, compared by git blob id: `<path> differs`, `<path> is not in the image`, `<path> is
 * not at the base`. Empty when the image runs exactly the base's scripts.
 */
function imageDifferences(root, base, imageRoot) {
  const atBase = new Map(
    git(root, 'ls-tree', '-r', '-z', '--full-tree', base)
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split('\t');
        return [path, meta.split(' ')[2]];
      })
      .filter(([path]) => inImage(path)),
  );
  const mine = imageFiles(imageRoot);
  const ids = execFileSync('git', ['-C', root, 'hash-object', '--no-filters', '--stdin-paths'], { input: mine.map((path) => join(imageRoot, path)).join('\n'), encoding: 'utf8' }).split('\n');
  const differences = [];
  for (const [i, path] of mine.entries()) {
    if (!atBase.has(path)) differences.push(`${path} is not at the base`);
    else if (atBase.get(path) !== ids[i]) differences.push(`${path} differs`);
  }
  for (const path of atBase.keys()) if (!mine.includes(path)) differences.push(`${path} is not in the image`);
  return differences;
}

/**
 * Refuse to run unless this image's Atlas files are exactly the ones at `base`: the checks that
 * judge a pull request are its merge base's, and a publication runs main's own scripts, never
 * code fetched with the pages.
 */
function requireImageIsBase(root, base, imageRoot = IMAGE_ROOT) {
  const differences = imageDifferences(root, base, imageRoot);
  if (differences.length) throw new Error(`this image's Atlas files are not the ones at ${base}, the commit whose checks must run (${differences.join('; ')}); update the pull request with main, or build and register an image from main`);
}

/**
 * Refuse unless the pull request's head changes exactly `page` (added or modified) against its
 * base: then the head's scripts are the base's, which is what lets the image's scripts judge it.
 */
function requireOnlyPage(root, base, page) {
  const fields = git(root, 'diff', '--name-status', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  if (changes.length !== 1 || changes[0].path !== page) throw new Error(`the pull request changes ${changes.length} file(s) against its base ${base}, not only ${page}`);
  if (!PAGE_CHANGES.includes(changes[0].status)) throw new Error(`${page} is not added or modified (git status ${changes[0].status}); a removed page has nothing to check`);
}

/**
 * The registry at a pull request's head, compared with its merge base the way the scripts do
 * (baseRef: where the head left origin/main). The head is fetched by SHA when main does not hold
 * it, as GitHub serves pull-request heads. Returns { root, base }.
 */
export function checkoutPullRequest(work, repository, headSha, page) {
  const root = cloneMain(work, repository);
  if (!refExists(root, headSha)) git(root, 'fetch', '--quiet', 'origin', headSha);
  git(root, 'checkout', '--quiet', '--detach', headSha);
  const base = baseRef(root);
  if (!refExists(root, base)) throw new Error(`the head ${headSha} has no base on main`);
  console.log(`checked out ${headSha}; base ${git(root, 'rev-parse', base).trim()}`);
  requireOnlyPage(root, base, page);
  requireImageIsBase(root, base);
  return { root, base };
}

/**
 * The registry at main's tip, as publish.yml checks it out when a run starts: what a
 * publication transfers, indexes and withdraws is main as it is now, which must hold `mainSha`
 * (the merge being published). Returns the checkout's path.
 */
export function checkoutMain(work, repository, mainSha) {
  const root = cloneMain(work, repository);
  let onMain = refExists(root, mainSha);
  if (onMain) {
    try {
      git(root, 'merge-base', '--is-ancestor', mainSha, ORIGIN_MAIN);
    } catch {
      onMain = false;
    }
  }
  if (!onMain) throw new Error(`${mainSha} is not on main; a publication runs only for a commit main holds`);
  git(root, 'checkout', '--quiet', '--detach', ORIGIN_MAIN);
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  console.log(`checked out main at ${tip}, which holds ${mainSha}`);
  requireImageIsBase(root, tip);
  return root;
}

/**
 * Let the checkout push: the deploy key from `env` goes to a file only the owner can read (and
 * out of `env`, so no script sees it), pushes go to `pushUrl` through ssh with that key and the
 * image's pinned GitHub host keys, and commits carry the executor's name.
 */
export function configurePush(root, work, { pushUrl }, env) {
  const key = env[DEPLOY_KEY];
  delete env[DEPLOY_KEY];
  const file = join(work, DEPLOY_KEY_FILE);
  writeFileSync(file, key.endsWith('\n') ? key : `${key}\n`, { mode: OWNER_ONLY });
  const ssh = `ssh -i '${file}' -o IdentitiesOnly=yes -o UserKnownHostsFile='${KNOWN_HOSTS}' -o StrictHostKeyChecking=yes`;
  for (const [name, value] of [['remote.origin.pushurl', pushUrl], ['core.sshCommand', ssh], ['user.name', COMMIT_NAME], ['user.email', COMMIT_EMAIL]]) git(root, 'config', name, value);
}
