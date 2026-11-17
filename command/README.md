# Atlas commands

The image Transform's command executor runs the Atlas checks and the publication in, and five
command configurations of it. The workflows stay until System's runs have matched them.

## Configurations

| Configuration | Commands | Secrets | Runs |
| --- | --- | --- | --- |
| `atlas-command-validation-public` | `check-page`, `verify` | none | `check-page` on every pull request; `verify` on one from a fork, public gateways only, as `validate.yml` does |
| `atlas-command-validation` | `verify` | `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | `verify` on a pull request from this repository |
| `atlas-command-transfer` | `transfer` | `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | merges |
| `atlas-command-index` | `publish-index` | `ATLAS_DEPLOY_KEY`, `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | merges |
| `atlas-command-withdrawal` | `withdraw` | `ATLAS_DEPLOY_KEY` | merges |

A task receives every secret its configuration declares, and a process that deletes a variable
still has it in its environment block, so each configuration declares only the secrets every
one of its commands uses. A configuration starts each of its commands with
`--configuration <its id>`, which a run cannot change. An entry point refuses to run when that
configuration does not list its command, or when an Atlas secret the configuration does not
declare is in its environment.

`transfer`, `publish-index` and `withdraw` write to production on any Transform installation:
the repository, the Filebase bucket and the IPNS name are fixed in the image. A DEV proof runs
`check-page` and `verify` only.

## Scripts and pages

The image holds the scripts, `schema/`, the dependencies from `package-lock.json`, the entry
points and configurations here, `known_hosts`, its own Dockerfile (which pins the Node base and
the elephant-cli release `validate.yml` pins) and elephant-cli. A run fetches the pages and
history from GitHub: anonymously over HTTPS (the repository is public), and pushes with the
deploy key over SSH on port 443 (`ssh.github.com`, host keys pinned in `known_hosts`, strict
host key checking). Nothing fetched is ever run.

Before a command runs anything it compares those files with main's, by git blob id, and refuses
(exit 1) when one differs: a pull request is judged by main's checks, as `validate.yml` judges
the merge commit, and a publication runs main's scripts. A change to any of those files on main
therefore needs a new image and new configuration versions; until then every command refuses.
`check-page` and `verify` judge the head against where it left main, and only a head that adds
or modifies exactly its county page, as a regular file, is checked.

## Commands and results

Parameters arrive as environment variables, each matching its pattern as a whole value;
`ATLAS_PAGE` is `counties/<ST>/<county>.json` in the shape of `ATLAS_COUNTY`, so a pull request
whose page path has another shape never starts a task, and the caller answers it. Parameters
and inputs are declared per configuration, so the executor accepts one that the started command
does not use (`ATLAS_GATEWAY_DEADLINE_MINUTES` to `check-page`), and the command refuses it
only once the task runs. `ATLAS_GATEWAY_DEADLINE_MINUTES` cannot exceed the configuration's
time limit.

Exit 0 means the command finished: `result.json`, one JSON object of at most 60,000 bytes
(under the executor's 60 KiB result limit; it bounds the whole run output to 64 KiB), carries
the verdict, its `summary` shortened when it must be while the log keeps all of it. Exit 1 means a crash or a run that cannot be used
(a wrong configuration, a missing secret, an image that is not main's, a head that cannot be
fetched): no `result.json`, the reason on stderr. `reason` is set only when `ok` is false.

| Command | Outcome | `result.json` | Exit |
| --- | --- | --- | --- |
| `check-page` | the page and the registry pass validate-entry | `{ok: true, summary}` | 0 |
| | the head changes another file, another page or several (`not-one-page`), removes the page (`page-removed`), makes it a link or another mode (`not-regular-file`), or the page fails (`invalid-page`) | `{ok: false, reason, summary}` | 0 |
| `verify` | every changed group passes, or none changed | `{ok: true, summary}` | 0 |
| | as `check-page`'s refusals (nothing is fetched for any of them), or a group fails (`group-failed`) | `{ok: false, reason, summary}` | 0 |
| `transfer` | every root the county owes is pinned | `{ok: true, withdraw: false, deferred: false, summary}` | 0 |
| | the county must come off main | `{ok: false, reason: "withdrawn", withdraw: true, deferred: false, root, summary}`; output `held.json` | 0 |
| | the county is deferred, or the gateways or Filebase were down (`deferred`, `outage`) | `{ok: false, reason, withdraw: false, deferred: true, summary}` | 0 |
| | the script ended without writing its holds | none | 1 |
| `publish-index` | the name serves the index, every group of the county in it | `{ok: true, indexed: true, indexCid, groups, countyIndexed: true, summary}` | 0 |
| | a group of the county was left out (`county-left-out`), or index.json is on main but the name does not serve it (`not-served`, `indexCid: null`) | `{ok: false, reason, indexed: true, indexCid, groups, countyIndexed, summary}` | 0 |
| | index.json did not reach main | none | 1 |
| `withdraw` | the group came off main | `{withdrawn: true, commitSha, root, summary}` | 0 |
| | main no longer holds what failed, or it was withdrawn already | `{withdrawn: false, commitSha: null, root, summary}` | 0 |
| | input `held.json` missing, without a withdrawn hold of the county, or naming another page | none | 1 |

`groups` is `[{group, archiveCid}]`, the county's groups in the committed index.json. `verify`
also returns the CLI's error CSV as `validation-errors.csv` (the last group's, as in
`validate.yml`) whenever the CLI wrote one. Logs,
`result.json`, `held.json` and `validation-errors.csv` have every secret value, the Filebase RPC
bearer token and every private gateway origin taken out.

## The caller's duties

- Run `transfer`, `publish-index` and `withdraw` one at a time across all counties, and never
  while `publish.yml` is active: both push index.json and point the IPNS name, and
  `publish-index.mjs` rebases its commit on the assumption that no other run writes it.
- Run them in that order. After `transfer` returned `withdraw: true`, run `withdraw` with its
  `held.json` even when `publish-index` did not succeed: no other county's run withdraws it,
  and every later `transfer` tries its root again.
- Open the issues: `Publication reverted` only when `withdraw` returned `withdrawn: true`, so
  keep that result; a `withdraw` repeated after it was lost returns `withdrawn: false`. No
  command opens a `Publication pending` issue.
- Wait for a run as long as its configuration's limit plus 30 minutes: 10,800 seconds for the
  validation configurations, 23,400 for the others.

## Known differences from the workflows

- One `transfer` runs `transfer-roots.mjs --county` in one process: every root of the county
  and every root other counties are owed, in page order, within one 330-minute budget.
  `publish.yml` runs one job per group, 330 minutes each, up to four at once, so a backlog
  before the county can leave it deferred here.
- The settings are `publish.yml`'s repository-variable defaults, fixed in the image
  (`PUBLICATION_SETTINGS` in `lib.mjs`); a changed variable needs a new image. There is no
  progress cache (`ATLAS_PROGRESS_DIR`, used by `ATLAS_PIN_VIA=rpc` only), no
  `publish-retry.yml` and no S3 copy of the index (`index-s3`).
- `check-page` and `verify` check the head as it left main, not merged onto main, so a root
  that a county merged since also uses is caught at publication. They check only a pull
  request that adds or modifies exactly one county page; `validate.yml` checks every one.
- Validation runs up to 150 minutes; the `validate` job has GitHub's 360.

## Secrets

By reference in `secretEnvironment`, under the installation's `CommandCredentialPathPrefix`
(`transform/commands/atlas/` here). ECS starts a task only when every referenced secret exists.
The deploy key reaches git as a file readable only by its owner, removed after the run.

| Variable | Used by | GitHub secret today |
| --- | --- | --- |
| `ATLAS_DEPLOY_KEY` | `publish-index`, `withdraw` | `ATLAS_DEPLOY_KEY` |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | `transfer`, `publish-index` | `ELEPHANT_FILEBASE_ACCESS_KEY`, `ELEPHANT_FILEBASE_SECRET_KEY` |
| `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | `verify` on this repository's pull requests, `transfer` | `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` |

## Limits

Every configuration: 4 vCPU and 16 GiB, the GitHub-hosted runner the workflows use (the scripts
get the same 12 GB heap), and 50 GiB of disk for a county CAR and its shard parts (Travis's
archive is 4.3 GB). Validation runs up to 150 minutes (verifying Travis takes about 25); the
publication commands up to 360, a transfer job's limit. The gateway deadline is the scripts'
default, 20 minutes.

## Build, pin, register

From main's tip, at the repository root, with BuildKit (`command/Dockerfile.dockerignore` sends
only what the Dockerfile copies):

```sh
docker build --platform linux/amd64 -f command/Dockerfile --build-arg ATLAS_SOURCE_SHA="$(git rev-parse HEAD)" -t atlas-command .
for c in check-page verify transfer publish-index withdraw; do docker run --rm --entrypoint node atlas-command /opt/atlas/command/$c.mjs --help; done
```

Push it to an ECR repository listed in the installation's `CommandImageRepositoryArns` and take
the digest the push prints. Register each configuration with `image` set to
`<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>`, as a new `version`:
validate, register, then read it back and compare the digest. The committed files keep the
placeholder `PLACEHOLDER_ATLAS_COMMAND_IMAGE_PINNED_BY_DIGEST`, which fails validation; an image
cannot hold its own digest. The `result` field needs a Transform with the command executor. An
installation with `ConfigurationProvenance=Enabled` refuses the registration with
`PROVENANCE_REQUIRED` until Deploy can install command configurations.
