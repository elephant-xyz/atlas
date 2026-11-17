// What every Atlas command shares when Transform's command executor runs it: the configuration
// it was started under (the argv `--configuration <id>`, one of those in this directory),
// parameters from the environment checked against it, secrets kept out of every log and result,
// a checkout of the registry fetched from GitHub, the check that this image runs main's
// scripts, and result.json written only on success. A command is
// `{ name, parameters, inputs, outputs, run, deps }`; its file calls runCommand(command), which
// exits 0 with result.json written or 1 with none.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { token as filebaseToken } from '../scripts/filebase.mjs';
import { redactGateways } from '../scripts/gateways.mjs';
import { baseRef, git, refExists } from '../scripts/lib.mjs';

/** The repository root, where the image keeps the Atlas files it runs (/opt/atlas). */
export const IMAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/**
 * The image's command configurations, by id. Each declares only the secrets every one of its
 * commands uses, and the executor gives a task exactly those.
 */
const CONFIGURATION_IDS = ['atlas-command-validation-public', 'atlas-command-validation', 'atlas-command-transfer', 'atlas-command-index', 'atlas-command-withdrawal'];
const CONFIGURATIONS = new Map(CONFIGURATION_IDS.map((id) => [id, JSON.parse(readFileSync(new URL(`./${id}.json`, import.meta.url), 'utf8'))]));
const allOf = (field) => [...new Set([...CONFIGURATIONS.values()].flatMap((configuration) => Object.keys(configuration[field])))];
/** Every secret (whose values are redacted) and parameter any Atlas configuration declares. */
const SECRET_NAMES = allOf('secretEnvironment');
const PARAMETER_NAMES = allOf('parameters');
const CONFIGURATION_FLAG = '--configuration';
const KNOWN_HOSTS = fileURLToPath(new URL('./known_hosts', import.meta.url));

/** Where the executor mounts a run's inputs (read-only) and copies its outputs from. */
const INPUTS_DIR = '/transform/inputs';
const OUTPUTS_DIR = '/transform/outputs';
export const RESULT_FILE = 'result.json';
/** The holds transfer writes and withdraw reads (transfer-roots.mjs's ATLAS_HELD). */
export const HELD_FILE = 'held.json';
/** The hold kind that takes a publication off main (see transfer-roots.mjs). */
export const WITHDRAWN = 'withdrawn';
const SUCCEEDED = 0;
const FAILED = 1;

/** Why a result is `ok: false`: its `reason`. Every one is a finished run (exit 0). */
export const Reason = Object.freeze({
  /** The page fails validate-entry's checks. */
  INVALID_PAGE: 'invalid-page',
  /** The page path is not counties/<ST>/<county>.json in the shape a county takes. */
  INVALID_PAGE_PATH: 'invalid-page-path',
  /** The pull request changes something else than exactly its county page. */
  NOT_ONE_PAGE: 'not-one-page',
  /** The pull request removes its county page. */
  PAGE_REMOVED: 'page-removed',
  /** The page is a symbolic link, or another git mode than a regular file. */
  NOT_REGULAR_FILE: 'not-regular-file',
  /** A changed group failed verify-roots.mjs's checks. */
  GROUP_FAILED: 'group-failed',
  /** The county's publication must come off main (held.json holds it). */
  WITHDRAWN: 'withdrawn',
  /** The county's publication waits for a later run; nothing is withdrawn. */
  DEFERRED: 'deferred',
  /** The gateways or Filebase were down before the first root; nothing was done. */
  OUTAGE: 'outage',
  /** The index was published without one of the county's groups. */
  COUNTY_LEFT_OUT: 'county-left-out',
  /** index.json is on main, but the IPNS name did not serve it. */
  NOT_SERVED: 'not-served',
});

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
/** git's status for a removed file, and the mode of a regular, non-executable file. */
const REMOVED = 'D';
const REGULAR_FILE = '100644';

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

/** The most result.json may hold: under the executor's 60 KiB result limit. */
const MAX_RESULT_BYTES = 60_000;
/** The longest `summary`: it fits the Connect write flows' 16,384-character limit (check run, comment, issue). */
const MAX_SUMMARY_CHARACTERS = 16_000;
/** The last line of a summary shortened to fit; the run's log keeps all of it. */
const SHORTENED = "… (shortened to fit the result; the run's log has all of it)";

/** What replaces a secret value in logs and results; shorter pieces are not taken for secrets. */
const REDACTED = '***';
const MIN_SECRET_PIECE = 8;

/**
 * The files the image copies from the repository (see command/Dockerfile). What the image runs
 * must be exactly what main holds at these paths; the Dockerfile stands for the Node base image
 * and the elephant-cli release the image was built with.
 */
const IMAGE_TOP_FILES = ['package.json', 'package-lock.json'];
const IMAGE_WHOLE_DIRECTORIES = ['schema', 'scripts'];
const COMMAND_DIRECTORY = 'command';
const IMAGE_COMMAND_FILE = /^command\/(?:[a-z-]+\.(?:mjs|json)|known_hosts|Dockerfile)$/;

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
 * A county page path: counties/<ATLAS_COUNTY>.json, so every page check-page passes is one the
 * publication commands take. ATLAS_PAGE itself is looser, so that a pull request with another
 * path still starts a task and gets this as its verdict.
 */
const COUNTY_PATTERN = [...CONFIGURATIONS.values()].find((configuration) => configuration.parameters.ATLAS_COUNTY).parameters.ATLAS_COUNTY.pattern;
const PAGE_PATH = wholeValue(`counties/(?:${COUNTY_PATTERN})\\.json`);
const PAGE_PATH_SHAPE = 'a page is counties/<ST>/<county>.json, <ST> two capital letters and <county> lowercase letters and digits in words joined by hyphens, such as counties/MN/hennepin.json';

/**
 * The configuration `argv` (`--configuration <id>`, as the configuration's own argv gives it)
 * names: its parameter patterns judge the run, and they differ between configurations.
 */
function configurationIn(argv) {
  const [flag, id] = argv;
  const configuration = flag === CONFIGURATION_FLAG ? CONFIGURATIONS.get(id) : undefined;
  if (!configuration) throw new Error(`must be started with ${CONFIGURATION_FLAG} <id> of one of this image's configurations (${CONFIGURATION_IDS.join(', ')})`);
  return configuration;
}

/**
 * The command's parameter values from `env`. Every one the command reads must be declared in its
 * configuration and match its pattern; a parameter of another command is refused, so a miswired
 * step fails before anything is fetched. Messages name the parameter, never the value.
 */
function readParameters(command, configuration, env) {
  const mine = new Set(command.parameters.map(({ name }) => name));
  const problems = PARAMETER_NAMES.filter((name) => env[name] !== undefined && !mine.has(name)).map((name) => `${name} is not a parameter of ${command.name}`);
  const values = {};
  for (const { name, required } of command.parameters) {
    const value = env[name];
    const declared = configuration.parameters[name];
    if (!declared) problems.push(`${name} is not declared by ${configuration.id}`);
    else if (value === undefined) {
      if (required) problems.push(`${name} is required`);
    } else if (!wholeValue(declared.pattern).test(value)) problems.push(`${name} does not match its pattern`);
    else values[name] = value;
  }
  if (problems.length) throw new Error(problems.join('; '));
  return values;
}

/** The Kubo RPC bearer token scripts/filebase.mjs makes from the Filebase keys, or '' without them. */
const filebaseBearer = (env) => (env.FILEBASE_ACCESS_KEY && env.FILEBASE_SECRET_KEY ? filebaseToken({ ...env, FILEBASE_BUCKET: PUBLICATION_SETTINGS.FILEBASE_BUCKET }) : '');

/**
 * A function that takes every configured secret's value (and each of its lines or
 * comma-separated pieces), the Filebase RPC bearer token made from the Filebase keys, and every
 * private gateway origin out of a text. The executor's logs are not masked the way GitHub
 * Actions masks secrets, and summaries are posted on pull requests.
 */
function redactor(env) {
  const pieces = [...SECRET_NAMES.flatMap((name) => [env[name] ?? '', ...(env[name] ?? '').split(/[\n,]/)]), filebaseBearer(env)]
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

/** A JSON output as it is written, and so as the executor measures it. */
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const bytesOf = (value) => Buffer.byteLength(serialize(value));

/**
 * `result` as result.json may hold it: one JSON object of at most MAX_RESULT_BYTES, its
 * `summary` at most MAX_SUMMARY_CHARACTERS. A `summary` too long for either keeps as much of its
 * start as fits, whole lines where it can, and says it was shortened; a result that does not fit
 * even then, or is not an object, is an error.
 */
function fitResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('the result must be one JSON object');
  const tooLarge = () => new Error(`result.json would be ${bytesOf(result)} bytes; at most ${MAX_RESULT_BYTES} fit`);
  if (typeof result.summary !== 'string') {
    if (bytesOf(result) <= MAX_RESULT_BYTES) return result;
    throw tooLarge();
  }
  const fits = (summary) => summary.length <= MAX_SUMMARY_CHARACTERS && bytesOf({ ...result, summary }) <= MAX_RESULT_BYTES;
  if (fits(result.summary)) return result;
  const shortened = (keep) => {
    const cut = result.summary.lastIndexOf('\n', keep);
    return `${result.summary.slice(0, cut > 0 ? cut : keep)}\n${SHORTENED}`;
  };
  if (!fits(shortened(0))) throw tooLarge();
  let [fitting, failing] = [0, result.summary.length];
  while (failing - fitting > 1) {
    const keep = Math.floor((fitting + failing) / 2);
    if (fits(shortened(keep))) fitting = keep;
    else failing = keep;
  }
  return { ...result, summary: shortened(fitting) };
}

/**
 * Write `files` ({ name: text or JSON value }, result.json last) to `dir`, each through a
 * temporary name the executor does not copy, then renamed; on any failure every file already
 * written is removed, so a run never leaves part of a success behind.
 */
function writeOutputs(dir, files) {
  const written = [];
  try {
    for (const [name, value] of Object.entries(files)) {
      const partial = join(dir, `.${name}.partial`);
      written.push(name);
      writeFileSync(partial, typeof value === 'string' ? value : serialize(value));
      renameSync(partial, join(dir, name));
    }
  } catch (e) {
    for (const name of written) for (const file of [name, `.${name}.partial`]) rmSync(join(dir, file), { force: true });
    throw e;
  }
}

/**
 * Run `command` as the executor does: started under the configuration `argv` names, parameters
 * and secrets in `env`, inputs in `inputs`, outputs to `outputs`. Returns 0 once the command has
 * finished and result.json (and any other success output) is written, whatever verdict the
 * result holds; 1, with a message on stderr and no success output, when it could not finish.
 * Every line logged and every value written has the secrets taken out. The work directory
 * (checkout, deploy key) is removed whatever happens.
 */
export async function runCommand(command, { argv = process.argv.slice(2), env = process.env, inputs = INPUTS_DIR, outputs = OUTPUTS_DIR, stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  const redact = redactor(env);
  const restore = routeConsole(stdout, stderr, redact);
  try {
    const parameters = readParameters(command, configurationIn(argv), env);
    env.GIT_TERMINAL_PROMPT = '0';
    const work = mkdtempSync(join(tmpdir(), 'atlas-command-'));
    try {
      const repository = { fetchUrl: env[REPOSITORY_OVERRIDE] ?? REPOSITORY_URL, pushUrl: env[REPOSITORY_OVERRIDE] ?? PUSH_URL };
      const { result, files = {} } = await command.run({ parameters, env, work, inputs, outputs, repository }, { ...command.deps, ...deps });
      const written = redactDeep({ ...files, [RESULT_FILE]: result }, redact);
      written[RESULT_FILE] = fitResult(written[RESULT_FILE]);
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
 * Differences between the image's Atlas files and the same paths on main in the checkout at
 * `root`, compared by git blob id: `<path> differs`, `<path> is not in the image`, `<path> is
 * not on main`. Empty when the image runs exactly main's scripts.
 */
function imageDifferences(root, imageRoot) {
  const onMain = new Map(
    git(root, 'ls-tree', '-r', '-z', '--full-tree', ORIGIN_MAIN)
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
    if (!onMain.has(path)) differences.push(`${path} is not on main`);
    else if (onMain.get(path) !== ids[i]) differences.push(`${path} differs`);
  }
  for (const path of onMain.keys()) if (!mine.includes(path)) differences.push(`${path} is not in the image`);
  return differences;
}

/**
 * Refuse to run unless this image's Atlas files are exactly main's as the checkout at `root`
 * cloned it: a pull request is judged by main's checks, as validate.yml judges the merge commit,
 * and a publication runs main's own scripts, never code fetched with the pages. Only an image
 * built from main and registered again fixes this, so it is an error, not a verdict.
 */
function requireImageIsMain(root, imageRoot = IMAGE_ROOT) {
  const differences = imageDifferences(root, imageRoot);
  if (differences.length) throw new Error(`this image's Atlas files are not main's at ${git(root, 'rev-parse', ORIGIN_MAIN).trim()} (${differences.join('; ')}); build and register an image from main`);
}

/**
 * Why the pull request's head cannot be checked as one county page, or undefined when it changes
 * exactly `page` against its base, added or modified, as a regular file: { reason, summary }. It
 * reads git's record of the change only, so nothing is read through a link.
 */
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
 * The registry at a pull request's head, compared with its merge base the way the scripts do
 * (baseRef: where the head left origin/main), once this image is known to run main's scripts.
 * The head is fetched by SHA when main does not hold it, as GitHub serves pull-request heads.
 * Returns { root, base, refused }: `refused` ({ reason, summary }) when `page` is not a county
 * page path (then nothing is fetched and there is no root) or the head is not exactly one added
 * or modified regular county page, which the caller returns as its verdict.
 */
export function checkoutPullRequest(work, repository, headSha, page) {
  if (!PAGE_PATH.test(page)) return { refused: { reason: Reason.INVALID_PAGE_PATH, summary: `${page} is not a county page path: ${PAGE_PATH_SHAPE}` } };
  const root = cloneMain(work, repository);
  requireImageIsMain(root);
  if (!refExists(root, headSha)) git(root, 'fetch', '--quiet', 'origin', headSha);
  git(root, 'checkout', '--quiet', '--detach', headSha);
  const base = baseRef(root);
  if (!refExists(root, base)) throw new Error(`the head ${headSha} has no base on main`);
  console.log(`checked out ${headSha}; base ${git(root, 'rev-parse', base).trim()}`);
  return { root, base, refused: pageRefusal(root, base, page) };
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
  console.log(`checked out main at ${git(root, 'rev-parse', 'HEAD').trim()}, which holds ${mainSha}`);
  requireImageIsMain(root);
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
