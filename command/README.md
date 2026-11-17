# Atlas commands

The image Transform's command executor runs the Atlas checks and the publication in, and two
command configurations of it:

- `atlas-command-validation.json`: `check-page` and `verify`, for pull requests. Its only
  secrets are the gateways and the gateway token, as `validate.yml` gives pull requests.
- `atlas-command-publication.json`: `transfer`, `publish-index` and `withdraw`, for main, with
  the deploy key and the Filebase keys as well.

Each command runs the scripts in `scripts/` as the workflows do; nothing here changes what they
check. The workflows stay until System's runs have matched them.

## Scripts and pages

The image holds the scripts, `schema/`, the dependencies from `package-lock.json`, the entry
points here and elephant-cli. A run fetches the pages and history from GitHub: anonymously over
HTTPS (the repository is public), and pushes with the deploy key over SSH on port 443
(`ssh.github.com`, host keys pinned in `known_hosts`). Nothing fetched is ever run.

Before a command runs anything it compares the image's Atlas files with the same paths at the
base commit, by git blob id, and refuses when one differs: for `check-page` and `verify` the
pull request's merge base (`baseRef()`), for the others main's tip. So the checks that judge a
pull request are its merge base's, and its head cannot change them. `check-page` and `verify`
also refuse a head that changes anything but the page they were given. A script change on main
therefore needs a new image and configuration version, and an open pull request whose merge
base predates the change is refused until it is brought up to date with main.

## Configurations

A configuration starts each of its commands with `--configuration <its id>`, which a run cannot
change. An entry point refuses to run when that configuration does not list its command, and
when a secret only the other configuration declares is in its environment, so a pull request's
checks never run beside the deploy key or the Filebase keys, however a configuration was
registered. Each command also drops the secrets it does not use before it runs anything.

Both name `result.json` as their `result`, so a run returns that file's JSON as `result`. That
field needs a Transform with the command executor: prismteam-ai/transform
`feat/command-executor-routes` (`eaef267`) accepts both configurations, while main (`16f753c`)
refuses `result` as an unrecognized key. Register them on the first Transform release that
includes the executor.

## Build, pin, register

From a commit on main, at the repository root:

```sh
docker build --platform linux/amd64 -f command/Dockerfile --build-arg ATLAS_SOURCE_SHA="$(git rev-parse HEAD)" -t atlas-command .
for c in check-page verify transfer publish-index withdraw; do docker run --rm --entrypoint node atlas-command /opt/atlas/command/$c.mjs --help; done
```

Push it to an ECR repository listed in the installation's `CommandImageRepositoryArns` and take
the digest the push prints. Register both configurations with `image` set to
`<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>`, each as a new
`version`: validate, register, then read it back and compare the digest. The committed files
keep the placeholder `PLACEHOLDER_ATLAS_COMMAND_IMAGE_PINNED_BY_DIGEST`, which fails
validation; an image cannot hold its own digest.

## Commands

Parameters arrive as environment variables, each matching its pattern as a whole value. A
parameter of another command is refused, and so is a missing required one. Exit 0 means the
command finished and wrote `result.json`, whatever its verdict; exit 1 means it could not
finish, with the reason on stderr and no `result.json`. `result.json` is one JSON object of at
most 64 KiB, the executor's limit: a longer `summary` is shortened and the run's log keeps all
of it.

| Configuration | Command | Parameters | `result.json` | Other files |
| --- | --- | --- | --- | --- |
| validation | `check-page` | `ATLAS_HEAD_SHA`, `ATLAS_PAGE` | `{ok, summary}`: validate-entry's `ok:` line, or its problems | |
| validation | `verify` | `ATLAS_HEAD_SHA`, `ATLAS_PAGE`, `ATLAS_GATEWAY_DEADLINE_MINUTES`? | `{ok, summary}`: one `ok` or `FAIL` line per changed group | output `validation-errors.csv` |
| publication | `transfer` | `ATLAS_COUNTY`, `ATLAS_MAIN_SHA`, `ATLAS_GATEWAY_DEADLINE_MINUTES`? | `{withdraw, root?, summary}` | output `held.json` when `withdraw` |
| publication | `publish-index` | `ATLAS_COUNTY`, `ATLAS_MAIN_SHA` | `{indexCid, groups: [{group, archiveCid}], countyIndexed, summary}` | |
| publication | `withdraw` | `ATLAS_COUNTY`, `ATLAS_MAIN_SHA` | `{withdrawn, commitSha, root, summary}` | input `held.json`: `transfer`'s output `s3Uri` |

- Verdicts, exit 0: `ok: false` (the page or an archive failed its checks), `withdraw: true`,
  `countyIndexed: false`, and `withdrawn: false` with `commitSha: null` when main no longer
  holds what failed (withdraw.mjs then leaves it alone).
- The publication commands run on main's tip, which must hold `ATLAS_MAIN_SHA`, as
  `publish.yml` takes main as it is when it starts. `transfer` runs
  `transfer-roots.mjs --county`: a county that is only deferred, or a service that is down, is
  exit 1 and nothing is withdrawn. `publish-index` is done once the IPNS name serves the
  index, also when the script then exits 1 for groups it left out; `countyIndexed` is false
  when one of them is the county's. It opens no `Publication pending` issue. `withdraw` opens
  no issue either: the caller opens `Publication reverted`.
- Logs and results have every secret value and private gateway origin taken out.

## Secrets

By reference in `secretEnvironment`, under the installation's `CommandCredentialPathPrefix`
(`transform/commands/atlas/` here). The deploy key reaches git as a file readable only by its
owner.

| Variable | Declared by | Used by | GitHub secret today |
| --- | --- | --- | --- |
| `ATLAS_DEPLOY_KEY` | publication | `publish-index`, `withdraw` | `ATLAS_DEPLOY_KEY` |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | publication | `transfer`, `publish-index` | `ELEPHANT_FILEBASE_ACCESS_KEY`, `ELEPHANT_FILEBASE_SECRET_KEY` |
| `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | both | `verify`, `transfer` | `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` |

ECS starts a task only when every referenced secret exists.

## Limits

Both: 4 vCPU and 16 GiB, the GitHub-hosted runner the workflows use (the scripts get the same
12 GB heap), and 50 GiB of disk for a county CAR and its shard parts (Travis's archive is
4.3 GB). Validation runs up to 150 minutes (verifying Travis takes about 25); publication up
to 360 minutes, a transfer job's limit. The gateway deadline is the scripts' default, 20
minutes.

A caller waiting for a run must wait the configuration's limit plus 30 minutes, which covers
preparing and finishing the run: 10,800 seconds for every validation command (`check-page`
included, since the limit belongs to the configuration) and 23,400 seconds for every
publication command.
