# Contributing

Atlas records what is published, never the data. A pull request that touches one file under
`counties/` is how an archive becomes discoverable. Merging it is the act of publication.

## The promise

A root reaching `index.json` means someone fetched it from a public gateway at review time
and the registry then transferred it to its own bucket: CI fetched the `CountyIndex` block,
hashed the bytes, checked they match the CID, resolved shard 0 and one property by path,
checked the property carries the claimed schema, and checked the `CountyTables` root points
back at the archive. A root the gateway cannot serve is not publishable, whatever the upload
logs say.

## From a finished archive to a pull request

1. Finish the archive with `elephant-cli`: `validate`, `hash --output-car`,
   `validate <county>.car`, `export-tables`, then `upload` the CAR and the tables directory.
   The upload summaries carry the `CountyIndex` root (`cid`) and the `CountyTables` root
   (`tables`). The `schema` is the data group's CID in the lexicon manifest
   (`https://lexicon.elephant.xyz/api/manifest`, e.g. `County` → `ipfsCid`), the same key the
   archive's properties carry in `data_groups`.
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
4. Check locally before pushing. `verify` only fetches groups that changed relative to
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

7. The `validate` check runs the unit tests, the page validator, the gateway spot checks, and
   the index check. A code owner (`.github/CODEOWNERS`) reviews and approves. Merge.
8. The publish workflow transfers your roots into the registry's Filebase bucket, regenerates
   `index.json`, commits it to `main`, and points the `elephant-atlas` IPNS name at it.
   Consumers read the index through that name.

## When a publication is reverted

If a root cannot be exported from the public gateway (a 404 or 504 that persists through the
retry policy), the workflow reverts your merge on `main` with a commit by
`github-actions[bot]` and opens an issue titled `Publication reverted: <STATE>/<county> <root>`
with the reason and the run link. Your change is gone from `main` again; `index.json` and the
IPNS name did not change. Re-upload the archive, confirm `https://ipfs.filebase.io/ipfs/<root>`
serves it, then open a new pull request. If instead the run failed after the transfer (index
commit, IPNS), nothing is reverted; a maintainer re-runs the workflow.

## Rules

- One county file per pull request. That is what lets counties publish in parallel.
- A `cid` or `tables` root appears once in the whole registry.
- Never edit `index.json` by hand.
