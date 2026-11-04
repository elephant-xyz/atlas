import { verifyGroup } from './scripts/verify-roots.mjs';
const t = Date.now();
await verifyGroup({ cid: 'baguqeerab4tomoh53pxzdg4hf2c77ysqjhtd57aprg2i2p275c4mme55pwxq', schema: 'bafkreia6tjziby3upxmidymud5iusd32urrztslgrudkwysc7ydmxoekuq', tables: 'baguqeerac2fzcbmcpepqcjinln7nzobztzv2tag5kim46jgwzrzgfli7o5fa', car: 'bafybeieaazrhpk6z7ebdje6bm4ekoh3ccnlbkmtoxsy54a4y2kedam37ny' }, { log: (l) => console.log(`${((Date.now() - t) / 60000).toFixed(1)}m ${String(l).slice(0, 400)}`) });
console.log(`PASSED in ${((Date.now() - t) / 60000).toFixed(1)} min`);
