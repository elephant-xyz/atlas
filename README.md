# Atlas

Atlas is the book of maps for Elephant data: one page per county, listing every published archive of that county. One JSON file per county,
one entry per run, written only through pull requests. A merge is the act of
publication: it is what makes a county root discoverable to consumers.

Status: scaffold. Nothing here is consumed yet.

## What an entry records

| Field | Meaning |
|---|---|
| `county`, `state`, `fips` | the county, keyed the same way everywhere (`lee`, `FL`, `12071`) |
| `groups` | the data-group keys the run carries (`county`, `seed`, `property_improvement`, ...); several when mined together, one when a source refreshes on its own cadence |
| `county_root` | CID of the `CountyIndex` block that roots the county CAR; this is the run's identity |
| `tables_root` | CID of the `CountyTables` block that roots the Parquet part set |
| `blocks`, `properties`, `parts` | counts reported by `hash`, `validate`, and `export-tables` |
| `cli` | the `elephant-cli` commit that produced the run |
| `lexicon` | the manifest URL used and, once the lexicon publishes one, its CID |
| `node` | where it was pinned: `filebase` or a named node |
| `evidence` | paths or CIDs of the upload summaries and the validation report |
| `status` | `published`, `superseded`, or `withdrawn` |

Runs are append-only; their order is their position in the array, newest last. A run has no
name of its own: the same `county_root` is the same publication, wherever it appears.

## Index

`index.json` is what consumers read. Version 4 holds one entry per county with at least one
published run; `groups` maps each data-group key to the newest (last in the array) run with
`status: published` that carries it. A withdrawn or superseded run never appears; `tables_root`
is omitted when the run has none. `published_at` is the time the registry merged the run,
derived from history, never supplied: the committer date of the first commit on `main` in which
the root appeared in the page.

```json
{
  "version": 4,
  "generated_from": "<main sha>",
  "counties": [
    { "county": "lee", "state": "FL", "fips": "12071",
      "groups": {
        "county": { "county_root": "...", "tables_root": "...", "properties": 511695, "published_at": "2026-09-21T17:23:52.000Z" }
      } }
  ]
}
```

The index holds roots and counts only. `cli`, `lexicon`, `node`, `evidence`, `blocks`, and
`parts` stay on the county pages.

## Publication

Merging a pull request that touches `counties/` runs the publish workflow. Pinning comes before
the index, so consumers never see a root the registry cannot serve:

1. Every root the merge published (`county_root`, `tables_root` of new or newly `published`
   runs) is pinned on the `elephant-atlas` Filebase bucket, roots only; the recursive pin
   covers everything beneath. The job waits until each pin reports `pinned` (45 minutes each
   by default).
2. If a pin reports `failed` or does not finish in time, the merge is reverted on `main` by the
   actions bot, an issue titled `Publication reverted: <county> <root>` is opened, and neither
   `index.json` nor the IPNS name changes.
3. Otherwise `index.json` is regenerated and committed, added to the bucket, and the IPNS name
   `elephant-atlas` (`k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04`) is
   pointed at its CID. The job ends only when the name resolves to that CID and
   <https://ipfs.filebase.io/ipns/k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04>
   serves the committed bytes. A failure at this step is not a revert: re-run the workflow.

Withdrawn roots are not unpinned yet. `docs/ipns-names-removed-2026-09-21.json` records the IPNS
names removed from the account on 2026-09-21 to free quota for `elephant-atlas`.

## Layout

```text
atlas/
├── README.md
├── schema/
│   └── entry.schema.json           JSON Schema every county file must satisfy
├── counties/
│   └── <state>/<county>.json       all runs for one county, newest last
├── index.json                      generated on merge: the flat list consumers read
├── scripts/
│   ├── validate-entry.mjs          schema, key consistency, ordering, no duplicate roots
│   ├── verify-roots.mjs            fetch each new root from the gateway, hash it, check shape
│   ├── build-index.mjs             regenerate index.json from counties/
│   ├── pin-roots.mjs               pin the roots a merge published, wait for `pinned`
│   ├── publish-index.mjs           commit index.json, add it, point the IPNS name at it
│   └── filebase.mjs                token, Kubo RPC, pin status, poll loop
├── .github/
│   ├── CODEOWNERS                  who must approve a publication
│   └── workflows/
│       ├── validate.yml            on pull request: validate-entry + verify-roots
│       └── publish.yml             on merge to main: pin roots, build-index, commit, publish to IPNS
├── docs/
│   └── ipns-names-removed-2026-09-21.json
├── evidence/
│   └── <state>/<county>/<county_root>/   upload summaries and validation reports
└── CONTRIBUTING.md                 how a run becomes a pull request
```

## How a run becomes an entry

1. Oracle finishes a county: `validate`, `hash --output-car`, `validate <county>.car`,
   `export-tables`, `upload` of the CAR and of the tables directory. The uploads write
   summary JSON files carrying the roots.
2. A generator turns those summaries into the county's entry and opens a pull request
   that touches exactly one file under `counties/`. One file per county is what lets
   many counties publish in parallel without conflicts.
3. CI validates the entry against the schema, fetches every new root from the public
   gateway, checks the bytes hash to the CID and the block has the expected shape, and
   refuses duplicate roots and rewritten history.
4. A code owner approves. Merging is publication.
5. The publish workflow pins the roots, regenerates `index.json`, and points the IPNS name at
   it (see Publication).

## Rules

- Never edit `index.json` by hand; it is generated.
- Never rewrite history in a county file; supersede a run, do not delete it.
- A root that the gateway cannot serve at review time is not publishable.
- Atlas records identifiers and counts, never data.
