# Atlas commands

The image and the command configuration Transform's command executor runs the Atlas checks
and the publication in: `check-page`, `verify`, `transfer`, `publish-index` and `withdraw`.
Each runs the scripts in `scripts/` as the workflows do; nothing here changes what they check.
The workflows stay until System's runs have matched them.

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

## Build, pin, register

From a commit on main, at the repository root:

```sh
docker build --platform linux/amd64 -f command/Dockerfile --build-arg ATLAS_SOURCE_SHA="$(git rev-parse HEAD)" -t atlas-command .
for c in check-page verify transfer publish-index withdraw; do docker run --rm --entrypoint node atlas-command /opt/atlas/command/$c.mjs --help; done
```

Push it to an ECR repository listed in the installation's `CommandImageRepositoryArns` and take
the digest the push prints. Register `configuration.json` with `image` set to
`<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>`, as a new `version`:
validate, register, then read it back and compare the digest. The committed file keeps the
placeholder `PLACEHOLDER_ATLAS_COMMAND_IMAGE_PINNED_BY_DIGEST`, which fails validation; an
image cannot hold its own digest.

## Commands

Parameters arrive as environment variables, each matching its pattern as a whole value. A
parameter of another command is refused. Success is exit 0 with `result.json`; anything else is
exit 1 with the reason on stderr and no `result.json`.

| Command | Parameters | `result.json` | Other files |
| --- | --- | --- | --- |
| `check-page` | `ATLAS_HEAD_SHA`, `ATLAS_PAGE` | `{ok, summary}`: validate-entry's `ok:` line, or its problems | |
| `verify` | `ATLAS_HEAD_SHA`, `ATLAS_PAGE`, `ATLAS_GATEWAY_DEADLINE_MINUTES`? | `{ok, summary}`: one `ok` or `FAIL` line per changed group | output `validation-errors.csv` |
| `transfer` | `ATLAS_COUNTY`, `ATLAS_MAIN_SHA`, `ATLAS_GATEWAY_DEADLINE_MINUTES`? | `{withdraw, root?, summary}` | output `held.json` when `withdraw` |
| `publish-index` | `ATLAS_COUNTY`, `ATLAS_MAIN_SHA` | `{indexCid, groups: [{group, archiveCid}], countyIndexed, summary}` | |
| `withdraw` | `ATLAS_COUNTY`, `ATLAS_MAIN_SHA` | `{commitSha, root, summary}` | input `held.json` from `transfer` |

- `ok: false` is a result: the page or an archive failed its checks.
- The publication commands run on main's tip, which must hold `ATLAS_MAIN_SHA`, as
  `publish.yml` takes main as it is when it starts. `transfer` runs
  `transfer-roots.mjs --county`: a county that is only deferred, or a service that is down, is
  exit 1 and nothing is withdrawn. `publish-index` is done once the IPNS name serves the
  index, also when the script then exits 1 for groups it left out; `countyIndexed` is false
  when one of them is the county's. It opens no `Publication pending` issue. `withdraw` opens no issue either: the caller opens
  `Publication reverted`.
- Logs and results have every secret value and private gateway origin taken out.

## Secrets

By reference in `secretEnvironment`, under the installation's `CommandCredentialPathPrefix`
(`transform/commands/atlas/` here). Each command drops the ones it does not use before it runs
anything; the deploy key reaches git as a file readable only by its owner.

| Variable | Used by | GitHub secret today |
| --- | --- | --- |
| `ATLAS_DEPLOY_KEY` | `publish-index`, `withdraw` | `ATLAS_DEPLOY_KEY` |
| `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | `transfer`, `publish-index` | `ELEPHANT_FILEBASE_ACCESS_KEY`, `ELEPHANT_FILEBASE_SECRET_KEY` |
| `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | `verify`, `transfer` | `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` |

ECS starts a task only when every referenced secret exists.

## Limits

4 vCPU and 16 GiB, the GitHub-hosted runner the workflows use (the scripts get the same 12 GB
heap), 50 GiB of disk for a county CAR and its shard parts (Travis's archive is 4.3 GB), and
360 minutes, a transfer job's limit. The gateway deadline is the scripts' default, 20 minutes.
