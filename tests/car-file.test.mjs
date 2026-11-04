import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as raw from 'multiformats/codecs/raw';
import { openCar } from '../scripts/car-file.mjs';
import { block, car } from './helpers.mjs';

test('openCar indexes every distinct block once and reads bytes by CID or string', async () => {
  const a = await block({ label: 'Seed', n: 1 });
  const b = await block(new Uint8Array(70_000).fill(7), raw);
  const c = await block({ label: 'Seed', link: a.cid, other: b.cid });
  const file = join(await mkdtemp(join(tmpdir(), 'car-file-')), 'x.car');
  writeFileSync(file, await car(c.cid, [c, a, b, a]));
  const r = await openCar(file);
  try {
    assert.deepEqual((await r.getRoots()).map(String), [c.cid.toString()]);
    assert.equal(r.size, 3, 'a repeated block is indexed once');
    assert.deepEqual((await r.get(b.cid)).bytes, b.bytes);
    assert.deepEqual((await r.get(a.cid.toString())).bytes, a.bytes);
    assert.equal(r.slotOf(c.cid.toString()), r.slotOf(c.cid));
    assert.equal(await r.get((await block({ n: 2 })).cid), undefined);
  } finally {
    await r.close();
  }
});
