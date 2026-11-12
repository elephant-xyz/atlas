// The CID Kubo gives a file under `add --cid-version=1 --raw-leaves` (how publish-index adds
// index.json), computed locally so a copy of the file can be held to the published CID without
// asking a node. A file that fits one 262,144-byte chunk is a single raw block; a larger one is
// a balanced DAG of dag-pb UnixFS file nodes over raw leaves, at most 174 links per node.
// The dag-pb and UnixFS protobufs are encoded by hand (they are tiny) to avoid a dependency.
import { createHash } from 'node:crypto';
import { varint } from 'multiformats';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as digestOf } from 'multiformats/hashes/digest';
import { sha256 } from 'multiformats/hashes/sha2';

export const CHUNK_BYTES = 262_144;
export const LINKS_PER_NODE = 174;
const DAG_PB = 0x70;
const UNIXFS_FILE = 2;

const sha256Cid = (code, bytes) => CID.createV1(code, digestOf(sha256.code, createHash('sha256').update(bytes).digest()));
const uvarint = (n) => [...varint.encodeTo(n, new Uint8Array(varint.encodingLength(n)))];
/** A length-delimited protobuf field: key byte, length, bytes. */
const field = (key, bytes) => [key, ...uvarint(bytes.length), ...bytes];

/** dag-pb node over `children` ({ cid, fileBytes, dagBytes }): links (Hash, empty Name, Tsize), then UnixFS Data. */
function parent(children) {
  const fileBytes = children.reduce((t, c) => t + c.fileBytes, 0);
  // UnixFS Data: Type=File (field 1), filesize (field 3), one blocksize per link (field 4).
  const data = [0x08, UNIXFS_FILE, 0x18, ...uvarint(fileBytes), ...children.flatMap((c) => [0x20, ...uvarint(c.fileBytes)])];
  const links = children.flatMap((c) => field(0x12, [...field(0x0a, c.cid.bytes), ...field(0x12, []), 0x18, ...uvarint(c.dagBytes)]));
  const block = Uint8Array.from([...links, ...field(0x0a, data)]);
  return { cid: sha256Cid(DAG_PB, block), fileBytes, dagBytes: block.length + children.reduce((t, c) => t + c.dagBytes, 0) };
}

/** Kubo's `add --cid-version=1 --raw-leaves` CID of `bytes`, as base32 text. */
export function unixfsCid(bytes) {
  let nodes = [];
  for (let at = 0; at < bytes.length || at === 0; at += CHUNK_BYTES) {
    const chunk = bytes.subarray(at, at + CHUNK_BYTES);
    nodes.push({ cid: sha256Cid(raw.code, chunk), fileBytes: chunk.length, dagBytes: chunk.length });
  }
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += LINKS_PER_NODE) next.push(parent(nodes.slice(i, i + LINKS_PER_NODE)));
    nodes = next;
  }
  return nodes[0].cid.toString();
}
