'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { openStore } = require('../src/store');
const { createPeering } = require('../src/peering');
const { createRtcTransport } = require('../src/rtcTransport');
const { loadOrCreateIdentity } = require('../src/identity');
const { DEFAULTS } = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-prtc-'));
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
const quick = { gatherMs: 1200, connectTimeoutMs: 8000, requestTimeoutMs: 5000, pollMs: 100 };

async function reachable(name) {
  const store = openStore(path.join(dir, `${name}.db`));
  const config = { ...DEFAULTS, allowPrivatePeers: true, rtc: { ...DEFAULTS.rtc, enabled: true, mailbox: true } };
  const server = createServer({ config, store, peers: () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { server.close(); store.close(); });
  return { store, url: `http://127.0.0.1:${server.address().port}` };
}

// A tracker with no listening socket at all: it only talks outwards (to the mailbox) and through data channels.
function natted(name, rtcExtra = {}, enabled = true) {
  const store = openStore(path.join(dir, `${name}.db`));
  const identity = loadOrCreateIdentity(path.join(dir, `${name}-id`));
  const config = { ...DEFAULTS, allowPrivatePeers: true, rtc: { ...DEFAULTS.rtc, enabled, ...rtcExtra } };
  const rtc = { identity, transport: createRtcTransport({ identity, ...quick }) };
  closers.push(() => { rtc.transport.close(); store.close(); });
  return { store, identity, config, rtc };
}

async function online(t, mailbox) {
  const peering = createPeering({ config: { ...t.config, rtc: { ...t.config.rtc, mailboxes: [mailbox] } }, store: t.store, rtc: t.rtc });
  const timer = setInterval(() => { peering.rtcTick(); }, 100);
  await peering.rtcTick();
  closers.push(() => clearInterval(timer));
  return { peering, stop: () => clearInterval(timer) };
}

test('two trackers without public addresses sync through a mailbox and a data channel', async () => {
  const m = await reachable('m1');
  const a = natted('a1');
  const adv = make();
  a.store.announce(adv, decode(adv), Date.now() - 500);
  const serveA = await online(a, m.url);
  const b = natted('b1', { peers: [`rtc:${a.identity.id}@${m.url}`] });
  const peering = createPeering({ config: b.config, store: b.store, rtc: b.rtc, ...{} });
  await peering.syncOnce();
  const [row] = b.store.list({});
  assert.equal(row.advert, adv);
  assert.ok(row.lastSeen <= Date.now());
  assert.equal(peering.status()[0].transport, 'rtc');
  assert.equal(peering.status()[0].failures, 0);
  serveA.stop(); a.rtc.transport.close(); b.rtc.transport.close();
});

test('future-dated adverts and keys that do not own the address are not imported over rtc', async () => {
  const m = await reachable('m2');
  const a = natted('a2');
  const future = make({ url: 'https://future.example.com', updated: Date.now() + 3_600_000 });
  a.store.announce(future, decode(future), Date.now());
  const evil = make({ name: 'Evil' }, keysB);
  a.store.announce(evil, decode(evil), Date.now());
  const fine = make({ url: 'https://ok.example.com' });
  a.store.announce(fine, decode(fine), Date.now());
  const serveA = await online(a, m.url);
  const b = natted('b2', { peers: [`rtc:${a.identity.id}@${m.url}`] });
  const own = make();
  b.store.announce(own, decode(own), Date.now() - 1000);
  await createPeering({ config: b.config, store: b.store, rtc: b.rtc }).syncOnce();
  assert.equal(b.store.list({}).some((r) => decode(r.advert).url === 'https://ok.example.com'), true, 'the sync itself worked');
  assert.equal(b.store.list({}).some((r) => decode(r.advert).url === 'https://future.example.com'), false);
  assert.equal(b.store.list({}).find((r) => decode(r.advert).url === 'https://a.example.com').advert, own);
  serveA.stop(); a.rtc.transport.close(); b.rtc.transport.close();
});

test('an rtc peer cannot import more than the per-peer cap', async () => {
  const m = await reachable('m3');
  const a = natted('a3');
  for (let i = 0; i < 25; i++) { const s = make({ url: `https://h${i}.example.com` }); a.store.announce(s, decode(s), Date.now() - i); }
  const serveA = await online(a, m.url);
  const b = natted('b3', { peers: [`rtc:${a.identity.id}@${m.url}`] });
  await createPeering({ config: b.config, store: b.store, rtc: b.rtc, maxPerPeer: 10 }).syncOnce();
  assert.equal(b.store.count(), 10);
  serveA.stop(); a.rtc.transport.close(); b.rtc.transport.close();
});

test('an unreachable rtc peer backs off while an https peer still syncs', async () => {
  const m = await reachable('m4');
  const adv = make();
  m.store.announce(adv, decode(adv), Date.now() - 100);
  const ghost = loadOrCreateIdentity(path.join(dir, 'ghost-id'));
  let clock = Date.now();
  const b = natted('b4', { peers: [`rtc:${ghost.id}@${m.url}`] });
  b.config.peers = [m.url];
  const peering = createPeering({ config: b.config, store: b.store, rtc: b.rtc, now: () => clock });
  await peering.syncOnce();
  assert.equal(b.store.count(), 1);
  const st = peering.status().find((s) => s.transport === 'rtc');
  assert.equal(st.failures, 1);
  assert.equal(st.nextTry, clock + 60_000);
  await peering.syncOnce();
  assert.equal(peering.status().find((s) => s.transport === 'rtc').failures, 1);
  b.rtc.transport.close();
});

test('with rtc off nothing rtc related runs and rtc peers in the config are ignored', async () => {
  const b = natted('b5', { peers: ['rtc:' + 'A'.repeat(43) + '@http://127.0.0.1:9'] }, false);
  const peering = createPeering({ config: b.config, store: b.store, rtc: b.rtc });
  assert.deepEqual(peering.status(), []);
  assert.deepEqual(peering.rtcList(), []);
  await peering.syncOnce();
  await peering.rtcTick();
  peering.start();
  peering.stop();
  assert.equal(b.rtc.transport.openCount(), 0);
});
