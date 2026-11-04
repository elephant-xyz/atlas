// A CAR file on disk with a compact block index, for archives of millions of blocks.
// @ipld/car's CarIndexedReader keeps one CID object per block, and each CID's bytes are a view
// into the stream chunk it was parsed from, so every chunk stays alive: on Node 22 indexing the
// Travis County archive (11.3M blocks, 4 GB) runs out of a 12 GB heap. This index keeps only the
// CID string, offset and length of each block, and reads block bytes from the file on demand.
import { open } from 'node:fs/promises';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';

/**
 * Index key: the CID's bytes as a flat latin1 string. A base32 CID string is built by
 * concatenation, and on Node 22 such strings stay ropes of small pieces, about 1 KB each, which
 * for 11M blocks exhausts a 12 GB heap.
 */
const keyOf = (cid) => Buffer.from((typeof cid === 'string' ? CID.parse(cid) : CID.asCID(cid) ?? CID.parse(String(cid))).bytes).toString('latin1');

function varint(buf, pos) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) return undefined;
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [value, pos];
    shift += 7;
  }
}

/** Length in bytes of the CID at buf[pos] (v1: version, codec, multihash; v0: a 34-byte sha2-256 multihash), or undefined if buf ends first. */
function cidLength(buf, pos) {
  if (buf[pos] === 0x12 && buf[pos + 1] === 0x20) return 34;
  let p = pos;
  for (let i = 0; i < 3; i++) {
    const v = varint(buf, p);
    if (!v) return undefined;
    p = v[1];
  }
  const len = varint(buf, p);
  if (!len) return undefined;
  return len[1] + len[0] - pos;
}

/**
 * Index `file`. Resolves { getRoots(), get(cid), slotOf(cid), size, close() }: `get` returns
 * { cid, bytes } or undefined (bytes are not hashed here); `slotOf` is a dense number per
 * distinct block, for flag arrays; `size` is the number of distinct blocks.
 */
export async function openCar(file) {
  const handle = await open(file, 'r');
  const { size: fileSize } = await handle.stat();
  const CHUNK = 8 << 20;
  let buf = new Uint8Array(0);
  let base = 0; // file offset of buf[0]
  let eof = false;
  const fill = async () => {
    const next = new Uint8Array(CHUNK);
    const { bytesRead } = await handle.read(next, 0, CHUNK, base + buf.length);
    if (!bytesRead) return (eof = true), false;
    const merged = new Uint8Array(buf.length + bytesRead);
    merged.set(buf);
    merged.set(next.subarray(0, bytesRead), buf.length);
    buf = merged;
    return true;
  };
  // Header: varint length, dag-cbor { version: 1, roots }.
  await fill();
  const [headerLength, headerStart] = varint(buf, 0);
  while (buf.length < headerStart + headerLength && (await fill()));
  const header = dagCbor.decode(buf.subarray(headerStart, headerStart + headerLength));
  if (header?.version !== 1 || !Array.isArray(header.roots)) throw new Error(`${file}: not a CARv1`);
  const roots = header.roots.map((c) => CID.asCID(c) ?? CID.parse(String(c)));
  let pos = headerStart + headerLength;
  const slot = new Map();
  const offsets = [];
  const lengths = [];
  while (base + pos < fileSize) {
    let v = varint(buf, pos);
    let cl = v && cidLength(buf, v[1]);
    if (!v || cl === undefined || v[1] + v[0] > buf.length) {
      // Keep only the unparsed tail, then read more.
      buf = buf.slice(pos);
      base += pos;
      pos = 0;
      if (!(await fill())) throw new Error(`${file}: truncated CAR at byte ${base}`);
      continue;
    }
    const [sectionLength, sectionStart] = v;
    const key = Buffer.from(buf.buffer, buf.byteOffset + sectionStart, cl).toString('latin1');
    if (!slot.has(key)) {
      slot.set(key, offsets.length);
      offsets.push(base + sectionStart + cl);
      lengths.push(sectionLength - cl);
    }
    pos = sectionStart + sectionLength;
  }
  buf = undefined;
  return {
    getRoots: async () => roots,
    size: offsets.length,
    slotOf: (cid) => slot.get(keyOf(cid)),
    async get(cid) {
      const i = slot.get(keyOf(cid));
      if (i === undefined) return undefined;
      const bytes = new Uint8Array(lengths[i]);
      await handle.read(bytes, 0, lengths[i], offsets[i]);
      return { cid: typeof cid === 'string' ? CID.parse(cid) : cid, bytes };
    },
    close: () => handle.close(),
  };
}
