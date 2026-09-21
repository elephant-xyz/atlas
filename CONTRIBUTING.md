# Contributing

Atlas records what was published, never the data. A pull request that touches one file
under `counties/` is how a run becomes discoverable. Merging it is the act of publication.

## The promise

A page reaching `latest` means someone fetched its roots from a public gateway at review
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
   git switch -c publish/<state>-<county>-<run>
   ```

3. Add a run to `counties/<STATE>/<county>.json` (create the file for a new county). Runs are
   append-only and ordered by `run`; never edit or delete an earlier run. To replace a run, append
   the new one, set the old one's `status` to `superseded`, and move `latest`. To pull a run, set
   its `status` to `withdrawn`; if nothing on the page is publishable, remove `latest`.
   `run` is the ISO date plus a short suffix (`2026-09-21-a`). Counts come from the CLI output:
   `blocks` from `hash`, `properties` from `validate`, `parts` from `export-tables`. `cli` is
   `git rev-parse HEAD` in the `elephant-cli` checkout that produced the run. `groups` lists the
   data-group keys the run carries. `evidence` holds the upload summaries and the validation
   report as CIDs or as repository-relative paths (commit the files under
   `evidence/<STATE>/<county>/<run>/`); absolute filesystem paths are rejected. See
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
8. The publish workflow regenerates `index.json` and commits it to `main` if it changed. That
   commit is the publication; consumers read `index.json`.

## Rules

- One county file per pull request. That is what lets counties publish in parallel.
- A `county_root` or `tables_root` appears once among the runs that are not withdrawn. Withdrawing a run releases its roots.
- `latest` must name a run on the page and must not be withdrawn.
- A run already on `main` may only change `status`. To fix anything else, append a new run and supersede the old one.
- Never edit `index.json` by hand and never rewrite a run in place.
- `evidence` values are CIDs or repository-relative paths, never absolute paths.
