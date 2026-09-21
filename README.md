# Oracle registry

The single list of every published Elephant county archive. One JSON file per county,
one entry per run, written only through pull requests. A merge is the act of
publication: it is what makes a county root discoverable to consumers.

Status: scaffold. Nothing here is consumed yet.

## What an entry records

| Field | Meaning |
|---|---|
| `county`, `state`, `fips` | the county, keyed the same way everywhere (`lee`, `FL`, `12071`) |
| `run` | ISO date plus a short suffix; runs are append-only and ordered |
| `county_root` | CID of the `CountyIndex` block that roots the county CAR |
| `tables_root` | CID of the `CountyTables` block that roots the Parquet part set |
| `blocks`, `properties`, `parts` | counts reported by `hash`, `validate`, and `export-tables` |
| `cli` | the `elephant-cli` commit that produced the run |
| `lexicon` | the manifest URL used and, once the lexicon publishes one, its CID |
| `node` | where it was pinned: `filebase` or a named node |
| `evidence` | paths or CIDs of the upload summaries and the validation report |
| `status` | `published`, `superseded`, or `withdrawn` |

## Layout

```text
oracle-registry/
├── README.md
├── schema/
│   └── entry.schema.json           JSON Schema every county file must satisfy
├── counties/
│   └── <state>/<county>.json       all runs for one county, newest last, `latest` pointer
├── index.json                      generated on merge: the flat list consumers read
├── scripts/
│   ├── validate-entry.mjs          schema, key consistency, ordering, no duplicate roots
│   ├── verify-roots.mjs            fetch each new root from the gateway, hash it, check shape
│   └── build-index.mjs             regenerate index.json from counties/
├── .github/
│   ├── CODEOWNERS                  who must approve a publication
│   └── workflows/
│       ├── validate.yml            on pull request: validate-entry + verify-roots
│       └── publish.yml             on merge to main: build-index, commit index.json
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
   refuses duplicates or out-of-order runs.
4. A code owner approves. Merging is publication.
5. The publish workflow regenerates `index.json`. Pointing an IPNS name at that index is
   the next step and is not part of this scaffold.

## Rules

- Never edit `index.json` by hand; it is generated.
- Never rewrite history in a county file; supersede a run, do not delete it.
- A root that the gateway cannot serve at review time is not publishable.
- The registry records identifiers and counts, never data.
