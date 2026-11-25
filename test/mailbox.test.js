'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createMailbox, MAX_PENDING } = require('../src/mailbox');
const { loadOrCreateIdentity, signEnvelope } = require('../src/identity');
const { createServer } = require('../src/server');
const { openStore } = require('../src/store');
const { DEFAULTS } = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-mb-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const mk = (n) => loadOrCreateIdentity(path.join(dir, n));
const A = mk('a'); const B = mk('b');
let clock = 1_000_000_000;
const reg = (id) => signEnvelope(id, { to: 'mailbox', kind: 'register', payload: null }, clock);
const offer = (from, to, payload = 'sdp') => signEnvelope(from, { to: to.id, kind: 'offer', payload }, clock);

test('a message to an unregistered tracker is refused; registered ones receive it once', () => {
  const m = createMailbox({ now: () => clock });
  assert.equal(m.post(offer(A, B)).ok, false);
  m.poll(reg(A)); m.poll(reg(B));
  assert.equal(m.post(offer(A, B)).ok, true);
  const first = m.poll(reg(B));
  assert.equal(first.messages.length, 1);
  assert.equal(m.poll(reg(B)).messages.length, 0);
});

test('only the owner of an id can read its messages', () => {
  const m = createMailbox({ now: () => clock });
  m.poll(reg(A)); m.poll(reg(B));
  m.post(offer(A, B));
  const C = mk('c');
  assert.equal(m.poll(reg(C)).messages.length, 0);
  assert.equal(m.poll(signEnvelope(A, { to: B.id, kind: 'register', payload: null }, clock)).messages.length, 0);
  assert.equal(m.poll(reg(B)).messages.length, 1);
});

test('messages expire after 5 minutes and presence after 15', () => {
  const m = createMailbox({ now: () => clock });
  m.poll(reg(A)); m.poll(reg(B));
  m.post(offer(A, B));
  clock += 5 * 60_000 + 1;
  assert.equal(m.poll(reg(B)).messages.length, 0);
  clock += 16 * 60_000;
  assert.equal(m.post(offer(A, B)).ok, false);
});

test('the mailbox is bounded and refuses forged or oversized envelopes', () => {
  const m = createMailbox({ now: () => clock });
  m.poll(reg(A)); m.poll(reg(B));
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(m.post(offer(A, B, `s${i}`)).ok, true);
  assert.equal(m.post(offer(A, B)).ok, false);
  const m2 = createMailbox({ now: () => clock });
  m2.poll(reg(A)); m2.poll(reg(B));
  assert.equal(m2.post(offer(A, B, 'x'.repeat(20_000))).ok, false);
  const [p, s] = offer(A, B).split('.');
  assert.equal(m2.post(`${Buffer.from(Buffer.from(p, 'base64url').toString().replace('"sdp"', '"evil"')).toString('base64url')}.${s}`).ok, false);
  assert.equal(m2.post(reg(A)).ok, false);
});

async function listening(config) {
  const store = openStore(path.join(dir, `${crypto.randomBytes(4).toString('hex')}.db`));
  const server = createServer({ config, store, now: () => clock, peers: () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { store, server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });

test('the routes are 404 when rtc or the mailbox is off, and existing routes are unchanged', async () => {
  for (const rtc of [{ ...DEFAULTS.rtc, enabled: false }, { ...DEFAULTS.rtc, enabled: true, mailbox: false }]) {
    const t = await listening({ ...DEFAULTS, rtc });
    assert.equal((await post(t.base, '/rtc/poll', reg(A))).status, 404);
    assert.equal((await post(t.base, '/rtc/post', offer(A, B))).status, 404);
    assert.equal((await fetch(`${t.base}/`)).status, 200);
    t.server.close(); t.store.close();
  }
});

test('over http: poll registers and returns messages, post delivers, bad input is 400', async () => {
  const t = await listening({ ...DEFAULTS, rtc: { ...DEFAULTS.rtc, enabled: true, mailbox: true } });
  assert.equal((await post(t.base, '/rtc/poll', reg(A))).status, 200);
  assert.equal((await post(t.base, '/rtc/poll', reg(B))).status, 200);
  assert.equal((await post(t.base, '/rtc/post', offer(A, B))).status, 204);
  const got = await (await post(t.base, '/rtc/poll', reg(B))).json();
  assert.equal(got.messages.length, 1);
  assert.equal((await post(t.base, '/rtc/post', 'garbage')).status, 400);
  assert.equal((await post(t.base, '/rtc/poll', offer(A, B))).status, 400);
  assert.equal((await post(t.base, '/rtc/post', 'x'.repeat(41 * 1024))).status, 413);
  t.server.close(); t.store.close();
});

test('the rtc routes are rate limited per IP', async () => {
  const t = await listening({ ...DEFAULTS, rtc: { ...DEFAULTS.rtc, enabled: true, mailbox: true, perMinute: 3 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(t.base, '/rtc/poll', reg(A))).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  t.server.close(); t.store.close();
});
