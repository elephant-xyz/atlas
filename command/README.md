# Atlas commands

The image Transform's command executor runs the Atlas checks and the publication in, and five
command configurations of it. The workflows stay until System's runs have matched them.

| Configuration | Commands | Secrets | Runs |
| --- | --- | --- | --- |
| `atlas-command-validation-public` | `check-page`, `verify` | none | `check-page` on every pull request; `verify` on one from a fork, public gateways only, as `validate.yml` does |
| `atlas-command-validation` | `verify` | `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | `verify` on a pull request from this repository |
| `atlas-command-transfer` | `transfer` | `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `ATLAS_GATEWAYS`, `ATLAS_GATEWAY_TOKEN` | merges |
| `atlas-command-index` | `publish-index` | `ATLAS_DEPLOY_KEY`, `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY` | merges |
| `atlas-command-withdrawal` | `withdraw` | `ATLAS_DEPLOY_KEY` | merges |

Each configuration declares only the secrets its commands use. `transfer`, `publish-index` and
`withdraw` write to production on any installation: the repository, the Filebase bucket and the
IPNS name are fixed in the image.

## Results

Exit 0 means the command finished and `result.json` (at most 60,000 bytes; `summary` at most
16,000 characters, which the Connect flows that post it accept) carries the verdict; `reason` is
set only when `ok` is false. Exit 1 means a crash or a run that cannot be used, with no result.
`ATLAS_PAGE` is loose on purpose, so a badly shaped page path still gets a verdict.

| Command | Outcome | `result.json` | Exit |
| --- | --- | --- | --- |
| `check-page` | the page and the registry pass validate-entry | `{ok: true, summary}` | 0 |
| | the page path has another shape (`invalid-page-path`, nothing fetched), the head changes another file, another page or several (`not-one-page`), removes the page (`page-removed`), makes it a link or another mode (`not-regular-file`), or the page fails (`invalid-page`) | `{ok: false, reason, summary}` | 0 |
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

`groups` is `[{group, archiveCid}]` from the committed index.json. `verify` also returns the
CLI's `validation-errors.csv` when the CLI wrote one. Logs and outputs have every secret value,
the Filebase RPC bearer token and every private gateway origin taken out.

## The caller's duties

- Run `transfer`, `publish-index` and `withdraw` one at a time across all counties, and never
  while `publish.yml` is active: both push index.json and point the IPNS name.
- Run them in that order. After `transfer` returned `withdraw: true`, run `withdraw` with its
  `held.json` even when `publish-index` did not succeed: no other county's run withdraws it.
- Open `Publication reverted` only when `withdraw` returned `withdrawn: true`, and keep that
  result: a repeat returns `withdrawn: false`. No command opens a `Publication pending` issue.
- Wait for a run as long as its configuration's limit plus 30 minutes.

## Go-live order

A run starts when a System workflow step starts Transform's command-runs workflow; no HTTP
route starts one.
1. Validation: register only `atlas-command-validation-public` and `atlas-command-validation`;
   `check-page` and `verify` only read, so they run beside `validate.yml`.
2. Publication, once it moves to System: register `atlas-command-transfer`, `atlas-command-index`
   and `atlas-command-withdrawal`, pause `publish.yml`, and run one county at a time, as above.

## Known differences from the workflows

- One `transfer` transfers every root of the county and every root other counties are owed, in
  one process within 330 minutes; `publish.yml` runs one job per group, up to four at once.
- The settings are `publish.yml`'s repository-variable defaults, fixed in the image. There is no
  progress cache, no `publish-retry.yml` and no S3 copy of the index.
- `check-page` and `verify` check the head as it left main, not merged onto main, and only a
  pull request that adds or modifies exactly one county page.
- Validation runs up to 150 minutes; the `validate` job has GitHub's 360.

## Build, pin, register

Every command refuses (exit 1) unless the revision the image records is on main and its package
files, schema, scripts, command files and Dockerfile equal main's. Build it with BuildKit from a
clean checkout of main's tip, with that commit passed as `ATLAS_SOURCE_SHA`, after any change
to them:

```sh
docker build --platform linux/amd64 -f command/Dockerfile --build-arg ATLAS_SOURCE_SHA="$(git rev-parse HEAD)" -t atlas-command .
```

Push it to an ECR repository listed in the installation's `CommandImageRepositoryArns`, then
register the configurations in the go-live order, each as a new `version` with `image` set to
`<repository URI>@sha256:<digest>`, and read each back to compare the digest. The secrets live under
`transform/commands/atlas/` and hold today's GitHub secrets (`ATLAS_DEPLOY_KEY`,
`ELEPHANT_FILEBASE_ACCESS_KEY`, `ELEPHANT_FILEBASE_SECRET_KEY`, `ATLAS_GATEWAYS`,
`ATLAS_GATEWAY_TOKEN`). An installation with `ConfigurationProvenance=Enabled` refuses the
registration with `PROVENANCE_REQUIRED` until Deploy can install command configurations.
