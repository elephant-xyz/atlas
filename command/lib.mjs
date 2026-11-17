// What every Atlas command shares when Transform's command executor runs it: parameters from the
// environment, secrets kept out of every log and output, a checkout of the registry fetched from
// GitHub, the check that this image runs main's files, and result.json written only on success.
// A command is `{ name, parameters, run, deps }`; its file calls runCommand(command), which exits
// 0 with result.json written or 1 with none.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { token as filebaseToken } from '../scripts/filebase.mjs';
import { redactGateways } from '../scripts/gateways.mjs';
import { baseRef, git, refExists } from '../scripts/lib.mjs';

/** Where the image keeps the Atlas files it runs (/opt/atlas). */
export const IMAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The commit the image was built from, written by command/Dockerfile. */
const REVISION_FILE = join(IMAGE_ROOT, 'REVISION');
/** What command/Dockerfile copies into the image: these must be main's for a run to start. */
const IMAGE_PATHS = ['package.json', 'package-lock.json', 'schema', 'scripts', 'command/*.mjs', 'command/*.json', 'command/known_hosts', 'command/Dockerfile'];
const KNOWN_HOSTS = fileURLToPath(new URL('./known_hosts', import.meta.url));

/** Every secret any configuration declares: their values are redacted. */
export const SECRET_NAMES = ['ATLAS_DEPLOY_KEY', 'ATLAS_GATEWAYS', 'ATLAS_GATEWAY_TOKEN', 'FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY'];
/** ATLAS_COUNTY's pattern: a page check-page passes is one the publication commands take. */
export const COUNTY_PATTERN = '[A-Z]{2}/[a-z0-9]+(?:-[a-z0-9]+)*';
const PAGE_PATH = new RegExp(`^counties/(?:${COUNTY_PATTERN})\\.json$`, 'u');
const PAGE_PATH_SHAPE = 'a page is counties/<ST>/<county>.json, <ST> two capital letters and <county> lowercase letters and digits in words joined by hyphens, such as counties/MN/hennepin.json';

const INPUTS_DIR = '/transform/inputs';
const OUTPUTS_DIR = '/transform/outputs';
export const RESULT_FILE = 'result.json';
/** The holds transfer writes and withdraw reads (transfer-roots.mjs's ATLAS_HELD). */
export const HELD_FILE = 'held.json';
export const WITHDRAWN = 'withdrawn';
const SUCCEEDED = 0;
const FAILED = 1;

export const Reason = Object.freeze({
  INVALID_PAGE: 'invalid-page',
  INVALID_PAGE_PATH: 'invalid-page-path',
  NOT_ONE_PAGE: 'not-one-page',
  PAGE_REMOVED: 'page-removed',
  NOT_REGULAR_FILE: 'not-regular-file',
  GROUP_FAILED: 'group-failed',
  WITHDRAWN: 'withdrawn',
  DEFERRED: 'deferred',
  OUTAGE: 'outage',
  COUNTY_LEFT_OUT: 'county-left-out',
  NOT_SERVED: 'not-served',
});

// Pushes go over SSH on port 443, the only port the executor's tasks may reach.
// ATLAS_REPOSITORY_URL is for tests: no configuration declares it, so a run cannot set it.
const REPOSITORY_URL = 'https://github.com/elephant-xyz/atlas.git';
const PUSH_URL = 'ssh://git@ssh.github.com:443/elephant-xyz/atlas.git';
const REPOSITORY_OVERRIDE = 'ATLAS_REPOSITORY_URL';
const MAIN = 'main';
const ORIGIN_MAIN = 'origin/main';
const CHECKOUT_DIR = 'atlas';
const DEPLOY_KEY = 'ATLAS_DEPLOY_KEY';
const DEPLOY_KEY_FILE = 'deploy-key';
const OWNER_ONLY = 0o600;
const COMMIT_NAME = 'Atlas command executor';
const COMMIT_EMAIL = 'atlas-command@elephant.invalid';
const REMOVED = 'D';
const REGULAR_FILE = '100644';

/** publish.yml's settings for transfer-roots.mjs and publish-index.mjs, at the repository variables' defaults. */
export const PUBLICATION_SETTINGS = {
  FILEBASE_BUCKET: 'elephant-atlas',
  FILEBASE_S3_ENDPOINT: 'https://s3.filebase.com',
  ATLAS_TRANSFER_PARALLEL: '8',
  ATLAS_IPNS_KEY: 'elephant-atlas',
  ATLAS_IPNS_ID: 'k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04',
  // 30 of the run's 360 minutes are left for the checkout and the outputs.
  ATLAS_RUN_MINUTES: '330',
  ATLAS_ROOT_MINUTES: '330',
  ATLAS_PIN_MINUTES: '330',
  ATLAS_PIN_VIA: 's3',
  ATLAS_TABLES_PIN_MINUTES: '30',
  ATLAS_TABLES_CAR: 'full',
  ATLAS_SKIP_STORED_SHARDS: '0',
};

/** Under the executor's 60 KiB result limit. */
const MAX_RESULT_BYTES = 60_000;
/** Fits the 16,384 characters the Connect flows that post a summary to GitHub accept. */
const MAX_SUMMARY_CHARACTERS = 16_000;
const SHORTENED = "… (shortened to fit the result; the run's log has all of it)";
/** The bytes the newline and SHORTENED add to the serialized summary. */
const SHORTENED_BYTES = Buffer.byteLength(JSON.stringify(`\n${SHORTENED}`)) - 2;
const REDACTED = '***';
/** Shorter pieces of a secret are not taken for secrets. */
const MIN_SECRET_PIECE = 8;

/** The command's parameters from `env`; the executor has already checked them against the configuration. */
function readParameters(command, env) {
  const missing = command.parameters.filter(({ name, required }) => required && env[name] === undefined).map(({ name }) => name);
  if (missing.length) throw new Error(`parameter(s) ${missing.join(', ')} required`);
  return Object.fromEntries(command.parameters.filter(({ name }) => env[name] !== undefined).map(({ name }) => [name, env[name]]));
}

/** Takes every secret value (and each of its lines or comma-separated pieces), the Filebase RPC bearer token and every private gateway origin out of a text. */
function redactor(env) {
  const bearer = env.FILEBASE_ACCESS_KEY && env.FILEBASE_SECRET_KEY ? filebaseToken({ ...env, FILEBASE_BUCKET: PUBLICATION_SETTINGS.FILEBASE_BUCKET }) : '';
  const pieces = [...SECRET_NAMES.flatMap((name) => [env[name] ?? '', ...(env[name] ?? '').split(/[\n,]/)]), bearer]
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

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const bytesOf = (value) => Buffer.byteLength(serialize(value));

/**
 * `result` within both caps: a summary over either loses at least the excess (a character is at
 * least one byte) and ends with SHORTENED. Anything else that does not fit is an error.
 */
function fitResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('the result must be one JSON object');
  const { summary } = result;
  const excess = typeof summary === 'string' ? Math.max(summary.length - MAX_SUMMARY_CHARACTERS, bytesOf(result) - MAX_RESULT_BYTES) : 0;
  // A cut between a surrogate pair would leave a half that JSON escapes into six bytes.
  const fitted = excess > 0 ? { ...result, summary: `${summary.slice(0, Math.max(0, summary.length - excess - SHORTENED_BYTES)).replace(/[\ud800-\udbff]$/, '')}\n${SHORTENED}` } : result;
  if (bytesOf(fitted) > MAX_RESULT_BYTES) throw new Error(`result.json would be ${bytesOf(fitted)} bytes; at most ${MAX_RESULT_BYTES} fit`);
  return fitted;
}

/** The revision command/Dockerfile recorded, or undefined outside an image. */
const imageRevision = () => (existsSync(REVISION_FILE) ? readFileSync(REVISION_FILE, 'utf8').trim() : undefined);

/**
 * Run `command` as the executor does: parameters and secrets in `env`, inputs in `inputs`,
 * outputs to `outputs`. Returns 0 once result.json (and any other output) is written, whatever
 * its verdict; 1, with the reason on stderr, when the command could not finish. Everything logged
 * and written is redacted, and the work directory (checkout, deploy key) is always removed.
 */
export async function runCommand(command, { env = process.env, inputs = INPUTS_DIR, outputs = OUTPUTS_DIR, stdout = process.stdout, stderr = process.stderr, deps = {}, revision = imageRevision() } = {}) {
  const redact = redactor(env);
  const restore = routeConsole(stdout, stderr, redact);
  try {
    const parameters = readParameters(command, env);
    env.GIT_TERMINAL_PROMPT = '0';
    const work = mkdtempSync(join(tmpdir(), 'atlas-command-'));
    try {
      const repository = { fetchUrl: env[REPOSITORY_OVERRIDE] ?? REPOSITORY_URL, pushUrl: env[REPOSITORY_OVERRIDE] ?? PUSH_URL, revision };
      const { result, files = {} } = await command.run({ parameters, env, work, inputs, outputs, repository }, { ...command.deps, ...deps });
      const written = redactDeep({ ...files, [RESULT_FILE]: result }, redact);
      written[RESULT_FILE] = fitResult(written[RESULT_FILE]);
      for (const [name, value] of Object.entries(written)) writeFileSync(join(outputs, name), typeof value === 'string' ? value : serialize(value));
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

/** Run a Node script in a process of its own, its output logged line by line (so redacted); resolves { code, signal, stderr }. */
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

/** Clone main into the work directory, without a checkout, and refuse unless this image runs main's files. */
function cloneMain(work, { fetchUrl, revision }) {
  console.log(`clone ${fetchUrl} (${MAIN})`);
  git(work, 'clone', '--quiet', '--no-checkout', '--single-branch', '--branch', MAIN, fetchUrl, CHECKOUT_DIR);
  const root = join(work, CHECKOUT_DIR);
  // A pull request is judged by main's checks, as validate.yml judges the merge commit, and a
  // publication runs main's scripts. Only a new image from main fixes this, so it is an error.
  const fix = 'build and register an image from main';
  if (!revision || !refExists(root, revision)) throw new Error(`this image's revision (${revision || 'none'}) is not on main; ${fix}`);
  try {
    git(root, 'diff', '--quiet', revision, ORIGIN_MAIN, '--', ...IMAGE_PATHS);
  } catch {
    throw new Error(`this image was built from ${revision}, whose files are not main's at ${git(root, 'rev-parse', ORIGIN_MAIN).trim()}; ${fix}`);
  }
  return root;
}

/** Why the head is not exactly one added or modified regular county page, from git's record of the change only, so nothing is read through a link. */
function pageRefusal(root, base, page) {
  const fields = git(root, 'diff', '--raw', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const [, mode, , , status] = fields[i].split(' ');
    changes.push({ mode, status, path: fields[i + 1] });
  }
  if (changes.length !== 1 || changes[0].path !== page) return { reason: Reason.NOT_ONE_PAGE, summary: `the pull request changes ${changes.length} file(s) against its base ${base}, not only ${page}: ${changes.map(({ path }) => path).join(', ')}` };
  const [{ mode, status }] = changes;
  if (status === REMOVED) return { reason: Reason.PAGE_REMOVED, summary: `${page} is removed; a pull request that removes a page has nothing to check here` };
  if (mode !== REGULAR_FILE) return { reason: Reason.NOT_REGULAR_FILE, summary: `${page} is not a regular file (git mode ${mode}, expected ${REGULAR_FILE}); nothing was read from it` };
  return undefined;
}

/**
 * The registry at a pull request's head and its merge base (baseRef, as the scripts compare
 * them): { root, base, refused }, where `refused` ({ reason, summary }) is the caller's verdict.
 */
export function checkoutPullRequest(work, repository, headSha, page) {
  if (!PAGE_PATH.test(page)) return { refused: { reason: Reason.INVALID_PAGE_PATH, summary: `${page} is not a county page path: ${PAGE_PATH_SHAPE}` } };
  const root = cloneMain(work, repository);
  if (!refExists(root, headSha)) git(root, 'fetch', '--quiet', 'origin', headSha);
  git(root, 'checkout', '--quiet', '--detach', headSha);
  const base = baseRef(root);
  if (!refExists(root, base)) throw new Error(`the head ${headSha} has no base on main`);
  console.log(`checked out ${headSha}; base ${git(root, 'rev-parse', base).trim()}`);
  return { root, base, refused: pageRefusal(root, base, page) };
}

/** The registry at main's tip, as publish.yml checks it out, which must hold `mainSha` (the merge being published). */
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
  console.log(`checked out main at ${git(root, 'rev-parse', 'HEAD').trim()}, which holds ${mainSha}`);
  return root;
}

/** Let the checkout push: the deploy key goes to an owner-only file (and out of `env`), ssh uses it with the pinned host keys only. */
export function configurePush(root, work, { pushUrl }, env) {
  const key = env[DEPLOY_KEY];
  delete env[DEPLOY_KEY];
  const file = join(work, DEPLOY_KEY_FILE);
  writeFileSync(file, key.endsWith('\n') ? key : `${key}\n`, { mode: OWNER_ONLY });
  const ssh = `ssh -i '${file}' -o IdentitiesOnly=yes -o UserKnownHostsFile='${KNOWN_HOSTS}' -o StrictHostKeyChecking=yes`;
  for (const [name, value] of [['remote.origin.pushurl', pushUrl], ['core.sshCommand', ssh], ['user.name', COMMIT_NAME], ['user.email', COMMIT_EMAIL]]) git(root, 'config', name, value);
}
