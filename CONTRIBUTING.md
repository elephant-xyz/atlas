# Contributing

Atlas records what was published, never the data. A pull request that touches one file
under `counties/` is how a run becomes discoverable. Merging it is the act of publication.

## The promise

A root reaching `index.json` means someone fetched it from a public gateway at review
time: CI fetched the `CountyIndex` block, hashed the bytes, checked they match the CID, and
resolved shard 0 and one property root by path. A root the gateway cannot serve is not
publishable, whatever the upload logs say.

## From a finished run to a pull request

1. Finish the run with `elephant-cli`: `validate`, `hash --output-car`, `validate <county>.car`,
   `export-tables`, then `upload` the CAR and the tables directory. Keep the upload summary
   JSON files; their `root` fields are the `county_root` and `tables_root`.
2. Clone Atlas and branch from `main`:

   ```bash
   git clone git@github.com:elephant-xyz/atlas.git && cd atlas
   npm ci
   git switch -c publish/<state>-<county>
   ```

3. Append a run to `counties/<STATE>/<county>.json` (create the file for a new county). Runs are
   append-only and ordered by array position, newest last; never edit, insert, or delete an
   earlier run. A run has no key: its `county_root` is its identity, and a root that is already
   on a non-withdrawn run anywhere in the registry is rejected. To replace a run, append the new
   one and set the old one's `status` to `superseded`. To pull a run, find it by `county_root`
   and set its `status` to `withdrawn`; that releases its roots, so they may be published again
   later. Do not record a publication time: the index derives `published_at` from the merge
   commit on `main`. Counts come from the CLI output:
   `blocks` from `hash`, `properties` from `validate`, `parts` from `export-tables`. `cli` is
   `git rev-parse HEAD` in the `elephant-cli` checkout that produced the run. `groups` lists the
   data-group keys the run carries. `evidence` holds the upload summaries and the validation
   report as CIDs or as repository-relative paths (commit the files under
   `evidence/<STATE>/<county>/<county_root>/`); absolute filesystem paths are rejected. See
   `schema/entry.schema.json` for every field.
4. Check locally before pushing. `verify` only fetches roots that are new relative to
   `origin/main`; `--all` refetches everything.

   ```bash
   npm test
   npm run validate
   npm run verify
   npm run index -- --check
   ```

5. Do not touch `index.json`. It is regenerated on `main` by the publish workflow after the
   merge, and CI rejects a pull request whose `index.json` differs from a regeneration of
   what is already on `main`. If your check fails right after another publication merged,
   rebase on `main` once its publish commit has landed.
6. Push and open the pull request:

   ```bash
   git push -u origin HEAD
   gh pr create --fill
   ```

7. The `validate` check runs the unit tests, the entry validator, the gateway spot checks, and
   the index check. A code owner (`.github/CODEOWNERS`) reviews and approves. Merge.
8. The publish workflow pins your roots on the registry's Filebase bucket, waits for `pinned`,
   regenerates `index.json`, commits it to `main`, and points the `elephant-atlas` IPNS name at
   it. Consumers read the index through that name.

## When a publication is reverted

If a root cannot be pinned (the pin reports `failed`, or is still not `pinned` after the
limit), the workflow reverts your merge on `main` with a commit by `github-actions[bot]` and
opens an issue titled `Publication reverted: <STATE>/<county> <root>` with the status and the
run link. Your page is gone from `main` again; `index.json` and the IPNS name did not change.
Re-upload or re-pin the root, confirm `https://ipfs.filebase.io/ipfs/<root>` serves it, then
open a new pull request with the same run. If instead the run failed after pinning (index
commit, IPNS), nothing is reverted; a maintainer re-runs the workflow.

## Rules

- One county file per pull request. That is what lets counties publish in parallel.
- A `county_root` or `tables_root` appears once among the runs that are not withdrawn. Withdrawing a run releases its roots.
- A run already on `main` may only change `status`; runs are matched by array position. To fix anything else, append a new run and supersede the old one.
- Never edit `index.json` by hand and never rewrite a run in place.
- `evidence` values are CIDs or repository-relative paths, never absolute paths.
