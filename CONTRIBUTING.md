# Contributing

Atlas records what is published, never the data. A pull request that touches one file under
`counties/` is how an archive becomes discoverable. Merging it is the act of publication.

## The promise

A root reaching `index.json` means the registry fetched the whole archive from the IPFS
network at review time and then transferred it to its own bucket. A pull request is validated
by downloading the whole archive by root and running the CLI on it; nothing is resolved by
path: `elephant-cli validate` checks every block, link, data-group root, and lexicon schema and
every check must be clean; from that local CAR the `CountyIndex` shape and the schema claim are
checked; the schema block, the `CountyTables` block (pointing back at the archive), and every
Parquet part are fetched by their own CIDs. Merging copies it to the org account. The archive must be retrievable from the IPFS network by its root CID at
review and at merge; any pinning provider or a publicly reachable node that keeps the pin until
the merge is fine; the org copies it onto its own account on merge. A root no gateway can serve
is not publishable, whatever the upload logs say.

## From a finished archive to a pull request

1. Finish the archive with `elephant-cli`: `validate`, `hash --output-car`,
   `validate <county>.car`, `export-tables`, then `upload` the CAR and the tables directory.
   The upload summaries carry the `CountyIndex` root (`cid`) and the `CountyTables` root
   (`tables`). The `schema` is the data group's CID in the lexicon manifest
   (`https://lexicon.elephant.xyz/api/manifest`, e.g. `County` → `ipfsCid`), the same key the
   archive's properties carry in `data_groups`.
   For a large archive (millions of blocks), also add the CAR file itself to IPFS as a file
   (for example, upload it to a Filebase bucket; the object's CID is its `car`) and set `car`
   on the group: gateways export a DAG of millions of small blocks too slowly for `validate`.
2. Clone Atlas and branch from `main`:

   ```bash
   git clone git@github.com:elephant-xyz/atlas.git && cd atlas
   npm ci
   git switch -c publish/<state>-<county>
   ```

3. Edit `counties/<STATE>/<county>.json` (create it for a new county). Set
   `groups.<data_group>` to `{ "cid", "schema", "tables" }`. To supersede an archive, change
   `cid` and `tables`. To withdraw one, remove the group key; remove the page when the county
   has nothing left. See `schema/entry.schema.json` for every field.
4. Check locally before pushing. `verify` needs `elephant-cli` on your PATH (or `ELEPHANT_CLI`)
   and only checks groups your branch changed since it left `origin/main`; `--all` rechecks
   everything.

   ```bash
   npm test
   npm run validate
   npm run verify
   ```

5. Do not touch `index.json`. It is regenerated on `main` by the publish workflow after the
   merge, and CI rejects a pull request that changes it. You never need to update or rebase
   your branch because another publication merged.
6. Push and open the pull request:

   ```bash
   git push -u origin HEAD
   gh pr create --fill
   ```

7. The `validate` check runs the unit tests, the page validator (which also rejects a change to
   `index.json`), and then the
   gate above on every changed group (`elephant-cli validate`: integrity, root, index, graph,
   lexicon, orphans, all six clean; the error CSV is attached to the run as the
   `validation-errors` artifact when they are not; then schema, tables, and every part by CID,
   the unavailable part CIDs listed on failure). `main` is
   protected by a ruleset: a change lands only through a pull request with one approving
   review from a code owner (`.github/CODEOWNERS`) and a green `validate`; nothing is deleted
   or force-pushed. Merge once both are in place (see Merging county pull requests).
8. The publish workflow transfers your roots into the registry's Filebase bucket, regenerates
   `index.json`, commits it to `main`, and points the `elephant-atlas` IPNS name at it.
   Consumers read the index through that name (and, when `ATLAS_INDEX_S3_URI` is set, from a
   byte-identical copy in S3; see the README). The workflow's own commits (the index, a
   withdrawal) are pushed through a deploy key, the ruleset's only bypass.

## Merging county pull requests

A green `validate` on a county pull request stays valid when other counties merge: it checked
that archive by its content IDs, and nothing on `main` changes what those IDs hold. The steps
below therefore need one setting on the `main` ruleset: "Require branches to be up to date
before merging" must be off. Check it with

```bash
gh api repos/elephant-xyz/atlas/rulesets --jq '.[].id' | xargs -I{} gh api repos/elephant-xyz/atlas/rulesets/{} \
  --jq '.rules[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy'
```

which must print `false`. If it prints `true`, or GitHub shows a green pull request as "out of
date" after another one merged, a repository admin turns the setting off (Settings, Rules,
Rulesets, the `main` ruleset, "Require status checks to pass"); do not work around it by
updating branches. Everything else in the ruleset stays as it is.

1. Check the pull request has a green `validate` and a code owner's approval.
2. Merge it. Do not click "Update branch" and do not merge or rebase `main` into it first: any
   new commit on the pull request re-runs the full validation (hours for a large county) for
   no gain.
3. Merge the next approved, green pull request right away. There is nothing to wait for between
   merges, and the other open pull requests keep their green check.
4. Watch the `publish` workflow. It runs one at a time, and a run transfers every root on
   `main` that `index.json` does not list yet, so one run can publish several merges and a
   merge whose own run was cancelled as superseded is still published by the next one. A county
   is published when `index.json` lists it.
5. A red run still publishes every county it could: the index lists a group once Filebase has
   both its roots pinned, whatever else went wrong in the run, and the run is red whenever a
   publication on `main` is not in the index. For the ones it could not publish:
   - A root no gateway could serve, or a root another group already holds: the bot took that
     group off `main` and opened a `Publication reverted` issue (see below). Nothing to do but
     wait for the author's new pull request. If the run says an issue was not opened, open it
     by hand from the text in the run's annotation. When two unpublished groups claim the same
     root, the one that had it first keeps it.
   - A run takes at most one publication off `main` for failing to transfer. When several fail
     together the cause may be the network, so the others stay on `main` and the next run
     tries them again; each run settles one more.
   - Anything else (credentials, Filebase, IPNS, an archive too large or too slow for the
     runner): the group stays on `main` and the next run tries it again. Each root is copied in
     a process of its own with a time limit, so one such archive does not stop the others.
     When the index step itself failed, nothing is taken off `main` in that run either; the
     next run does both.
   - The gateways or Filebase are down (the run checks a root it published earlier before it
     blames a new one): nothing is taken off `main`, the run stops instead of trying every
     county, and everything waits for the next run.

   "The next run" starts by itself: every three hours `publish-retry` checks whether `main` is
   ahead of what is published (or the IPNS name is not serving the index) and starts `publish`
   if so, unless a run is already waiting or working. Run `publish` from the Actions tab to
   retry sooner; it is idempotent, roots already pinned are skipped. A publication that is
   still not through after 12 hours gets a `Publication pending` issue with the last reason:
   it stays on `main` and keeps being retried, but by then it needs a person.

Dispatching `publish` with a `county` transfers every root of that county again. It also
publishes what other counties are owed, because a dispatched run can replace theirs in the
queue; a transfer of theirs that fails is left for the next run, never taken off `main` by this
one. Dispatch `publish` from `main`. From another branch only the transfer jobs run, with that
branch's scripts, which is how a change to the transfer is tried before it merges; the index,
the IPNS name and withdrawals are handled on `main` only.

A push to a pull request (a new or changed `cid`, `schema`, `tables`, or `car`) always re-runs
the full validation. Only an untouched, already green pull request is spared.

A run transfers each group in a job of its own, `ATLAS_PUBLISH_MAX_PARALLEL` (repository
variable, default 4) at a time, and publishes the index once they have all ended. A hosted
runner stops a job after 6 hours; a transfer job stops itself after 5.5 (`ATLAS_RUN_MINUTES`,
default 330) and leaves what it did not finish for the next run. That run starts where this one
stopped: a root already pinned is skipped, the shards Filebase confirmed are kept in the Actions
cache and not sent again, and a pin Filebase was still working on when the run ended is picked
up by watching `pin/ls`. So merging many very large counties at once only spreads them over
several runs.

## When a publication is reverted

If no public gateway can serve a root by CID through the retry policy, or another page already
holds the root, the workflow takes your publication off `main` with a commit by
`github-actions[bot]` and opens an issue titled `Publication reverted: <STATE>/<county> <root>`
with the reason and the run link. It is not a `git revert` of your merge: the group you changed
goes back to what the registry last published, with the page's `fips` (or is removed if it was
never published, and the page with it when nothing is left), and the page's other groups and
everyone else's merges are untouched. `index.json` and the IPNS name never listed your root. Re-pin the archive,
confirm a public gateway serves `/ipfs/<root>/shards/0`, then open a new pull request. If
instead the run failed for another reason (credentials, Filebase, IPNS), nothing is taken off
`main`; the next run, or a maintainer re-running the workflow, finishes it.

## Rules

- One county file per pull request. That is what lets counties publish in parallel.
- A `cid` or `tables` root appears once in the whole registry.
- Never edit `index.json` by hand.
