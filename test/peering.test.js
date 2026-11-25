'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { openStore } = require('../src/store');
const { createPeering } = require('../src/peering');
const { DEFAULTS } = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-peer-'));
const closers = [];
test.after(() => { for (const c of closers) c(); fs.rmSync(dir, { recursive: true, force: true }); });

const keysA = crypto.generateKeyPairSync('ed25519');
const keysB = crypto.generateKeyPairSync('ed25519');
function make(over = {}, keys = keysA) {
  const pub = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://a.example.com', name: 'A', description: '', icon: null, registration: 'open', updated: 1000, pub, ...over }));
  return `${payload.toString('base64url')}.${crypto.sign(null, payload, keys.privateKey).toString('base64url')}`;
}
const decode = (s) => JSON.parse(Buffer.from(s.split('.')[0], 'base64url'));

async function tracker(name, extra = {}) {
  const store = openStore(path.join(dir, `${name}.db`));
  const config = { ...DEFAULTS, allowPrivatePeers: true, ...extra };
  const state = { peering: null };
  const server = createServer({ config, store, peers: () => (state.peering ? state.peering.peerList() : []) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.close(); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { store, server, url, config, state };
}

test('an advert announced to A shows on B after a sync, with A lastSeen, and A is not changed', async () => {
  const a = await tracker('a1');
  const adv = make();
  await fetch(`${a.url}/announce`, { method: 'POST', body: adv });
  const b = await tracker('b1', { peers: [a.url] });
  b.state.peering = createPeering({ config: b.config, store: b.store });
  await b.state.peering.syncOnce();
  const [row] = b.store.list({});
  assert.equal(row.advert, adv);
  assert.ok(row.lastSeen <= Date.now());
  assert.equal(a.store.count(), 1);
});

test('future-dated adverts and keys that do not own the address are not imported', async () => {
  const a = await tracker('a2');
  a.store.announce('x', decode(make({ url: 'https://future.example.com', updated: Date.now() + 3_600_000 })), Date.now());
  const futureAdv = make({ url: 'https://future.example.com', updated: Date.now() + 3_600_000 });
  a.store.announce(futureAdv, decode(futureAdv), Date.now());
  const evil = make({ name: 'Evil' }, keysB);
  a.store.announce(evil, decode(evil), Date.now());
  const b = await tracker('b2', { peers: [a.url] });
  const own = make();
  b.store.announce(own, decode(own), Date.now() - 1000);
  const peering = createPeering({ config: b.config, store: b.store });
  await peering.syncOnce();
  assert.equal(b.store.list({}).some((r) => decode(r.advert).url === 'https://future.example.com'), false);
  assert.equal(b.store.list({}).find((r) => decode(r.advert).url === 'https://a.example.com').advert, own);
});

test('a peer cannot import more than the per-peer cap', async () => {
  const a = await tracker('a3');
  for (let i = 0; i < 25; i++) { const s = make({ url: `https://h${i}.example.com` }); a.store.announce(s, decode(s), Date.now() - i); }
  const b = await tracker('b3', { peers: [a.url] });
  await createPeering({ config: b.config, store: b.store, maxPerPeer: 10 }).syncOnce();
  assert.equal(b.store.count(), 10);
});

test('peers found through /peers are added; private or non-https peers are refused', async () => {
  const c = await tracker('c4');
  const a = await tracker('a4');
  a.state.peering = createPeering({ config: { ...a.config, peers: [c.url] }, store: a.store });
  const b = await tracker('b4', { peers: [a.url] });
  const peering = createPeering({ config: b.config, store: b.store });
  await peering.syncOnce();
  assert.deepEqual(peering.peerList().sort(), [a.url, c.url].sort());
  const strict = createPeering({ config: { ...DEFAULTS, peers: ['http://127.0.0.1:9', 'https://127.0.0.1:9', 'https://localhost', 'https://10.0.0.5', 'https://ok.example.com'] }, store: b.store });
  assert.deepEqual(strict.peerList(), ['https://ok.example.com']);
});

test('a dead peer backs off while a live one still syncs', async () => {
  const a = await tracker('a5');
  const adv = make();
  await fetch(`${a.url}/announce`, { method: 'POST', body: adv });
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;
  dead.close();
  let clock = Date.now();
  const b = await tracker('b5', { peers: [deadUrl, a.url] });
  const peering = createPeering({ config: b.config, store: b.store, now: () => clock });
  await peering.syncOnce();
  assert.equal(b.store.count(), 1);
  const st = peering.status().find((s) => s.url === deadUrl);
  assert.equal(st.failures, 1);
  assert.equal(st.nextTry, clock + 60_000);
  await peering.syncOnce();
  assert.equal(peering.status().find((s) => s.url === deadUrl).failures, 1);
  clock += 61_000;
  await peering.syncOnce();
  assert.equal(peering.status().find((s) => s.url === deadUrl).nextTry, clock + 120_000);
});
