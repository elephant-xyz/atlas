# Atlas

Atlas is the book of maps for Elephant data: one page per county, naming the archive published
for each of its data groups. One JSON file per county, written only through pull requests.
A merge is the act of publication: it is what makes an archive discoverable to consumers.

Status: scaffold. Nothing here is consumed yet.

## What a page records

A page is the current state of one county, nothing else. History lives in git.

| Field | Meaning |
|---|---|
| `county`, `state`, `fips` | the county, keyed the same way everywhere (`lee`, `FL`, `12071`) |
| `groups` | one entry per data group (`county`, `property_improvement`, `hoa`, ...) the county has an archive for; empty means nothing is published |
| `groups.<key>.cid` | CID of the `CountyIndex` block that roots the archive; this is the archive's identity |
| `groups.<key>.schema` | CID of the data-group schema from the lexicon manifest that the archive's properties carry |
| `groups.<key>.tables` | CID of the `CountyTables` block that roots the archive's Parquet part set |

One archive per county per data group. The seed group rides inside every archive as property
identity and is never a registry group. Supersede an archive by changing `cid` (and `tables`);
withdraw it by removing the group key or the page.

## Index

`index.json` is what consumers read. It holds one entry per county with at least one
group; each group is copied from the page plus `published_at`, the time the registry merged the
archive, derived from history, never supplied: the committer date of the first commit on `main`
in which the `cid` appeared in the page.

```json
{
  "version": 1,
  "generated_from": "<main sha>",
  "counties": [
    { "county": "lee", "state": "FL", "fips": "12071",
      "groups": {
        "county": { "cid": "baguqeera…", "schema": "bafkrei…", "tables": "baguqeera…", "published_at": "2026-09-21T17:23:52.000Z" }
      } }
  ]
}
```

The index holds CIDs and the merge time only.

## Publication

Merging a pull request that touches `counties/` runs the publish workflow. The archive is
transferred to the registry's own bucket before the index changes, so consumers never see a
root the registry cannot serve:

1. Every archive and tables root the merge added is exported from the IPFS network as CAR,
   through a list of public gateways tried in order (`https://ipfs.filebase.io`,
   `https://ipfs.io`, `https://dweb.link`, `https://w3s.link`; `ATLAS_GATEWAYS` overrides),
   and imported into the `elephant-atlas` Filebase bucket with `dag/import`, bounded piece by
   piece: the root block alone, then one shard (or one Parquet part) at a time through a temp
   file, then the root block again with `pin-roots=true` so the recursive pin sees a complete
   DAG. The pin is verified with `pin/ls`. Pinning by CID (`pin/add`) is not used: Filebase does
   not serve a bucket's inner blocks to nodes outside the owning account, its own pinning
   cluster included, so a `pin/add` of another account's root sits in `pinning` forever.
2. If no gateway can serve a root through the retry policy, the merge is reverted on `main`
   by the actions bot, an issue titled
   `Publication reverted: <county> <root>` is opened, and neither `index.json` nor the IPNS name
   changes.
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
│   └── <state>/<county>.json       the county's current archives, one per data group
├── index.json                      generated on merge: the flat list consumers read
├── scripts/
│   ├── validate-entry.mjs          schema, key consistency, no duplicate roots, index not hand-edited
│   ├── verify-roots.mjs            fetch each changed group's roots from the gateway, hash, check shape and schema
│   ├── build-index.mjs             regenerate index.json from counties/
│   ├── transfer-roots.mjs          export new roots from the gateway, import them into the bucket
│   ├── publish-index.mjs           commit index.json, add it, point the IPNS name at it
│   └── filebase.mjs                token, Kubo RPC, poll loop
├── docs/
│   └── ipns-names-removed-2026-09-21.json
├── .github/
│   ├── CODEOWNERS                  who must approve a publication
│   └── workflows/
│       ├── validate.yml            on pull request: validate-entry + verify-roots
│       └── publish.yml             on merge to main: transfer roots, build-index, commit, publish to IPNS
└── CONTRIBUTING.md                 how an archive becomes a pull request
```

## How an archive becomes an entry

1. Oracle finishes a county for one data group: `validate`, `hash --output-car`,
   `validate <county>.car`, `export-tables`, `upload` of the CAR and of the tables directory.
   The uploads report the `CountyIndex` root and the `CountyTables` root.
2. A generator writes the county's page and opens a pull request that touches exactly one
   file under `counties/`. One file per county is what lets many counties publish in parallel
   without conflicts.
3. CI validates the page against the schema, fetches every changed root from the IPFS network
   through the gateway list, checks the bytes hash to the CID and the blocks have the expected shape, checks the
   archive carries the claimed schema and the tables point back at the archive, and refuses a
   root used twice.
4. A code owner approves. Merging is publication.
5. The publish workflow transfers the roots, regenerates `index.json`, and points the IPNS
   name at it (see Publication).

## Rules

- Never edit `index.json` by hand; it is generated.
- The archive must be retrievable from the IPFS network by its root CID at review and at merge;
  any pinning provider or a publicly reachable node that keeps the pin until the merge is fine;
  the org copies it onto its own account on merge. Gateways are untrusted: every block kept is
  hashed against its CID.
- A `cid` or `tables` root appears once in the whole registry.
- Atlas records identifiers, never data.
