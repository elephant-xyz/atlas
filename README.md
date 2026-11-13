# Atlas

Atlas is the book of maps for Elephant data: one page per county, naming the archive published
for each of its data groups. One JSON file per county, written only through pull requests.
A merge is the act of publication: it is what makes an archive discoverable to consumers.

Status: scaffold. Nothing here is consumed yet. The repository is public; `main` is protected
by a ruleset (changes only through a pull request with one approving code-owner review and a
green `validate` check, no deletion or force-push; "Require branches to be up to date" must be
off, see Merging county pull requests in CONTRIBUTING.md), and the publish workflow writes its commits
through a deploy key registered as the only bypass.

## What a page records

A page is the current state of one county, nothing else. History lives in git.

| Field | Meaning |
|---|---|
| `county`, `state`, `fips` | the county, keyed the same way everywhere (`lee`, `FL`, `12071`) |
| `groups` | one entry per data group (`county`, `property_improvement`, `hoa`, ...) the county has an archive for; empty means nothing is published |
| `groups.<key>.cid` | CID of the `CountyIndex` block that roots the archive; this is the archive's identity |
| `groups.<key>.schema` | CID of the data-group schema from the lexicon manifest that the archive's properties carry |
| `groups.<key>.tables` | CID of the `CountyTables` block that roots the archive's Parquet part set |
| `groups.<key>.car` | optional: CID of the same archive as one CARv1 file (rooted at `cid`), added to IPFS as a file. `validate` and `publish` download it in one request instead of exporting the DAG block by block; every block is still hashed and the DAG checked complete. Not copied into `index.json` |

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

1. Every archive and tables root on `main` that `index.json` does not list yet (this merge, and
   any earlier merge whose own run did not finish) is exported from the IPFS network as CAR,
   through public gateways tried in order (`https://ipfs.filebase.io`, then
   `https://trustless-gateway.link`); a private gateway can be put first through the
   `ATLAS_GATEWAYS` repository secret, which GitHub masks in logs,
   into one CAR file per root (a group's `car` file is used as it is), checked to hold the
   root's whole DAG with every block hashing to its CID, and uploaded to the `elephant-atlas`
   Filebase bucket through Filebase's S3 endpoint (`s3.filebase.com`, multipart) with the object
   metadata `import=car`, under `import/<ST>-<county>-<group>[-tables]-<root>.car`. Filebase
   imports the CAR and pins its root; the pin is verified with `pin/ls`. A tables CAR carries
   the tables block and its Parquet parts; if it does not pin within `ATLAS_TABLES_PIN_MINUTES`
   (default 30) it is sent again with the archive's blocks too. The repository variable
   `ATLAS_PIN_VIA=rpc` goes back to the earlier path, `dag/import` bounded piece by piece (the
   root block, one shard or Parquet part at a time, then the root block with `pin-roots=true`),
   which on 2026-11-13 left roots with no pin at all. Pinning by CID (`pin/add`) is not used: Filebase does
   not serve a bucket's inner blocks to nodes outside the owning account, its own pinning
   cluster included, so a `pin/add` of another account's root sits in `pinning` forever.
2. A group whose root no gateway can serve through the retry policy, or whose root another
   group already holds, is taken off `main` by the actions bot (put back to what was last
   published, not a `git revert`) and an issue titled `Publication reverted: <county> <root>`
   is opened. A group that failed for another reason stays on `main` for the next run. Either
   way the run goes on with the other counties. A failure is blamed on a publication with
   care: a root published earlier must still be served and pinned (when it is not, the gateways
   or Filebase are down, nothing is withdrawn, and the run stops), and a run withdraws at most
   one publication for failing to transfer, since several failing together may be the network.
   What stays on `main` unpublished is tried again by the next run; `publish-retry` starts one
   within three hours when no merge does, and a publication still waiting after 12 hours gets a
   `Publication pending` issue.
3. `index.json` is regenerated from every group whose roots Filebase lists as pinned (asked
   at that moment, not taken from the transfer's own report; the run is red when a publication
   on `main` is left out) and committed, added to the bucket, and the IPNS name
   `elephant-atlas` (`k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04`) is
   pointed at its CID. The job ends only when the name resolves to that CID and
   <https://ipfs.filebase.io/ipns/k51qzi5uqu5dhzmj1jtn06idud425ozwdjjjn4eu7q01g2t814h7rw4du0nd04>
   serves the committed bytes. A failure at this step is not a revert: re-run the workflow.
4. Optionally, the published `index.json` is copied to S3 (see below).

### Copy to S3 (optional)

Consumers that read the index from a bucket rather than through IPNS, such as Persist's
registered IPFS indexes, get a copy from the publish workflow's `index-s3` job. Persist computes
the UnixFS CID of the object's exact bytes (Kubo `add --cid-version=1 --raw-leaves`) and, when
it changes, copies the Parquet parts the index names from IPFS, checking every CID; so the
object must be the published bytes, never a re-serialization.

The job is off unless the `ATLAS_INDEX_S3_URI` repository variable is set; without it, publish
behaves as before. It runs only after the IPNS name serves the new index (also when the
`publish` job then ends red over a publication it could not complete, since the index it did
publish is what the copy must hold), and uploads `main`'s `index.json` only when `scripts/unixfs.mjs` computes
the CID `publish-index` published for it; otherwise (a later publication superseded the run)
it fails without writing. The object gets `Content-Type: application/json`,
`Cache-Control: no-cache`, `Content-MD5` and `x-amz-meta-ipfs-cid: <cid>`. A failed upload
never touches the IPFS publication: the run shows red, and re-running the failed job puts the
same bytes again.

| Repository variable | Value |
| --- | --- |
| `ATLAS_INDEX_S3_URI` | `s3://<bucket>/<key>`, e.g. `s3://<persist index bucket>/atlas/index.json`; turns the job on |
| `ATLAS_INDEX_S3_ROLE_ARN` | IAM role the job assumes through GitHub OIDC; no access keys are stored |
| `ATLAS_INDEX_S3_REGION` | the bucket's region (default `us-east-1`) |

The role trusts `token.actions.githubusercontent.com` with `aud` `sts.amazonaws.com` and `sub`
`repo:elephant-xyz/atlas:ref:refs/heads/main`, and may only `s3:PutObject` on
`arn:aws:s3:::<bucket>/<key>` (plus `kms:GenerateDataKey` on the bucket's key if it uses
SSE-KMS). Only the `index-s3` job gets `id-token: write`. Point the Persist registration's
`index_uri` at the same `s3://<bucket>/<key>`.

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
│   ├── verify-roots.mjs            the gate: whole archive by root, elephant-cli validate, schema, tables and parts by CID
│   ├── build-index.mjs             regenerate index.json from counties/
│   ├── transfer-roots.mjs          export new roots from the gateway, upload them to the bucket as import=car CARs
│   ├── s3.mjs                      minimal SigV4 S3 client (HeadObject, PutObject, multipart) for those uploads
│   ├── car-file.mjs                index a CAR file on disk; write one block by block
│   ├── publish-index.mjs           commit index.json, add it, point the IPNS name at it
│   ├── upload-index-s3.mjs         optional: copy the published index.json to S3, held to its CID
│   ├── unixfs.mjs                  the CID Kubo gives a file (add --cid-version=1 --raw-leaves)
│   ├── withdraw.mjs                take a group that could not be published off main, open an issue
│   └── filebase.mjs                token, Kubo RPC, poll loop
├── docs/
│   └── ipns-names-removed-2026-09-21.json
├── .github/
│   ├── CODEOWNERS                  who must approve a publication
│   └── workflows/
│       ├── validate.yml            on pull request: validate-entry, verify-roots
│       ├── publish.yml             on merge to main: transfer roots, build-index, commit, publish to IPNS, optional S3 copy
│       └── publish-retry.yml       every three hours: start publish when main is ahead of what is published
└── CONTRIBUTING.md                 how an archive becomes a pull request
```

## How an archive becomes an entry

1. Oracle finishes a county for one data group: `validate`, `hash --output-car`,
   `validate <county>.car`, `export-tables`, `upload` of the CAR and of the tables directory.
   The uploads report the `CountyIndex` root and the `CountyTables` root.
2. A generator writes the county's page and opens a pull request that touches exactly one
   file under `counties/`. One file per county is what lets many counties publish in parallel
   without conflicts.
3. CI validates the page against the schema and refuses a root used twice (the publish workflow
   withdraws a root that two merged pull requests both claim, since each can pass alone). Then a pull request
   is validated by downloading the whole archive by root and running the CLI on it; nothing is
   resolved by path: `elephant-cli validate` checks every block, link, data-group root, and
   lexicon schema; the local CAR must show a `CountyIndex` whose first property carries the
   claimed schema; the schema block, the `CountyTables` block (pointing back at the archive),
   and every Parquet part are fetched by their own CIDs. Merging copies it to the org account.
4. A code owner approves. Merging is publication.
5. The publish workflow transfers the roots, regenerates `index.json`, and points the IPNS
   name at it (see Publication).

## Rules

- Never edit `index.json` by hand; it is generated.
- The archive must be retrievable from the IPFS network by its root CID at review and at merge,
  and every Parquet part by its own CID; any pinning provider or a publicly reachable node that
  keeps the pin until the merge is fine; the org copies it onto its own account on merge.
  Gateways are untrusted: every block kept is hashed against its CID.
- A `cid` or `tables` root appears once in the whole registry.
- Atlas records identifiers, never data.
