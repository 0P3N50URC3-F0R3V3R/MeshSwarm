'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer } = require('../src/server');
const { openStore } = require('../src/store');
const { DEFAULTS } = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-srv-'));
let clock = 1_000_000;
let store; let server; let base;
const keysA = crypto.generateKeyPairSync('ed25519');
const keysB = crypto.generateKeyPairSync('ed25519');

function make(over = {}, keys = keysA) {
  const pub = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://a.example.com', name: 'A', description: 'd', icon: null, registration: 'open', updated: 1000, pub, ...over }));
  return `${payload.toString('base64url')}.${crypto.sign(null, payload, keys.privateKey).toString('base64url')}`;
}

test.before(async () => {
  store = openStore(path.join(dir, 's.db'));
  server = createServer({ config: { ...DEFAULTS, announcePerMinute: 30, maxEntries: 3 }, store, now: () => clock, peers: () => ['https://peer.example.com'] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = (body, method = 'POST') => fetch(`${base}/announce`, { method, headers: { 'content-type': 'text/plain' }, body });
const list = async (q = '') => (await fetch(`${base}/list${q}`)).json();

test('an announce shows up in the list at once, with lastSeen and CORS', async () => {
  const adv = make();
  assert.equal((await post(adv)).status, 204);
  const res = await fetch(`${base}/list`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const { servers } = await res.json();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].advert, adv);
  assert.equal(servers[0].lastSeen, clock);
});

test('tampered adverts and garbage bodies are refused without crashing', async () => {
  const [p, s] = make().split('.');
  const bad = `${Buffer.from(Buffer.from(p, 'base64url').toString().replace('"A"', '"Z"')).toString('base64url')}.${s}`;
  assert.equal((await post(bad)).status, 400);
  assert.equal((await post('not an advert')).status, 400);
  assert.equal((await post('')).status, 400);
  assert.equal((await post(make({ updated: clock + 10 * 60_000 }))).status, 400);
  assert.equal((await fetch(`${base}/list`)).status, 200);
});

test('another key cannot take an owned address; the owner can delete, others cannot', async () => {
  assert.equal((await post(make({ name: 'Evil' }, keysB))).status, 409);
  assert.equal((await post(make({}, keysB), 'DELETE')).status, 404);
  assert.equal((await post(make({ updated: 2000 }), 'DELETE')).status, 204);
  assert.equal((await list()).servers.length, 0);
});

test('body over 40 KB is 413 and the server keeps working', async () => {
  assert.equal((await post('x'.repeat(41 * 1024))).status, 413);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('since and limit work and the cap on new addresses holds', async () => {
  for (let i = 1; i <= 3; i++) { clock += 10; assert.equal((await post(make({ url: `https://h${i}.example.com` }))).status, 204); }
  assert.equal((await list()).servers.length, 3);
  assert.equal((await list('?limit=2')).servers.length, 2);
  assert.equal((await list(`?since=${clock - 15}`)).servers.length, 2);
  assert.equal((await post(make({ url: 'https://h9.example.com' }))).status, 503);
  assert.equal((await post(make({ url: 'https://h1.example.com', updated: 5 }))).status, 204);
});

test('peers and the info route', async () => {
  assert.deepEqual(await (await fetch(`${base}/peers`)).json(), { peers: ['https://peer.example.com'] });
  const info = await (await fetch(`${base}/`)).json();
  assert.equal(info.name, 'MeshSwarm');
  assert.equal(info.servers, 3);
  assert.equal((await fetch(`${base}/list`, { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('announces are rate limited per IP', async () => {
  const limited = createServer({ config: { ...DEFAULTS, announcePerMinute: 3 }, store, now: () => clock, peers: () => [] });
  await new Promise((r) => limited.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${limited.address().port}/announce`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(url, { method: 'POST', body: make({ url: 'https://h1.example.com', updated: 6 + i }) })).status);
  limited.close();
  assert.deepEqual(codes, [204, 204, 204, 429, 429]);
});
