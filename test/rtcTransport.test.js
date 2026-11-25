'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRtcTransport, frames, createAssembler, MAX_MESSAGE } = require('../src/rtcTransport');
const { createMailbox } = require('../src/mailbox');
const { loadOrCreateIdentity, signEnvelope } = require('../src/identity');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-rtc-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const A = loadOrCreateIdentity(path.join(dir, 'a'));
const B = loadOrCreateIdentity(path.join(dir, 'b'));
const reg = (id) => signEnvelope(id, { to: 'mailbox', kind: 'register', payload: null });

function wire() {
  const mailbox = createMailbox();
  mailbox.poll(reg(A)); mailbox.poll(reg(B));
  return {
    sendAs: () => async (env) => { const r = mailbox.post(env); if (!r.ok) throw new Error(r.error); },
    pollAs: (id) => async () => mailbox.poll(reg(id)).messages,
    mailbox,
  };
}

const quick = { gatherMs: 1200, connectTimeoutMs: 8000, requestTimeoutMs: 5000, pollMs: 100 };

async function pair(handler, opts = {}) {
  const w = wire();
  const ta = createRtcTransport({ identity: A, ...quick, ...opts });
  const tb = createRtcTransport({ identity: B, ...quick, ...opts });
  let stopped = false;
  const serving = (async () => {
    while (!stopped) {
      for (const env of await w.pollAs(B)()) await tb.accept(env, { send: w.sendAs() }, handler);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return { w, ta, tb, serving, stop: () => { stopped = true; } };
}

test('framing round-trips a large payload and ignores garbage and repeated chunks', () => {
  const got = [];
  const feed = createAssembler((id, obj) => got.push([id, obj]));
  const big = { servers: Array.from({ length: 400 }, (_, i) => ({ advert: 'x'.repeat(2000), lastSeen: i })) };
  const parts = frames(7, big);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length < 16100));
  feed('garbage'); feed(parts[0]); feed(parts[0]);
  for (const p of parts.slice(1)) feed(p);
  assert.equal(got.length, 1);
  assert.equal(got[0][0], 7);
  assert.equal(got[0][1].servers.length, 400);
});

test('a list request goes through the mailbox and a real data channel', async () => {
  const { ta, tb, w, serving, stop } = await pair(async (req) => (req.type === 'list' ? { ok: true, servers: [{ advert: 'a'.repeat(100_000), lastSeen: 5 }] } : { ok: true, peers: ['https://x.example.com'] }));
  const ch = await ta.connect(B.id, { send: w.sendAs(), poll: w.pollAs(A) });
  const list = await ch.request({ type: 'list', since: 0, limit: 10 });
  assert.equal(list.servers[0].advert.length, 100_000);
  const peers = await ch.request({ type: 'peers' });
  assert.deepEqual(peers.peers, ['https://x.example.com']);
  ch.close(); ta.close(); tb.close();
  assert.equal(ta.openCount() + tb.openCount(), 0);
  stop();
  await serving.catch(() => {});
});

test('an answer from someone else, or without the offer nonce, is ignored', async () => {
  const w = wire();
  const C = loadOrCreateIdentity(path.join(dir, 'c'));
  w.mailbox.poll(reg(C));
  const ta = createRtcTransport({ identity: A, ...quick, connectTimeoutMs: 1500 });
  const forged = (async () => {
    for (let i = 0; i < 12; i++) {
      for (const env of await w.pollAs(B)()) {
        const fake = signEnvelope(C, { to: A.id, kind: 'answer', payload: { sdp: 'v=0\na=fingerprint:sha-256 AA:BB', re: 'nope' } });
        w.mailbox.post(fake);
        const wrongNonce = signEnvelope(B, { to: A.id, kind: 'answer', payload: { sdp: 'v=0\na=fingerprint:sha-256 AA:BB', re: 'wrong' } });
        w.mailbox.post(wrongNonce);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  await assert.rejects(ta.connect(B.id, { send: w.sendAs(), poll: w.pollAs(A) }), /no answer/);
  ta.close();
  await forged;
});

test('connect times out when nobody answers and leaves nothing open', async () => {
  const w = wire();
  const ta = createRtcTransport({ identity: A, ...quick, connectTimeoutMs: 800 });
  await assert.rejects(ta.connect(B.id, { send: w.sendAs(), poll: w.pollAs(A) }), /no answer/);
  assert.equal(ta.openCount(), 0);
});

test('a response over the cap is replaced by an error, and a failing handler is reported', async () => {
  let n = 0;
  const { ta, tb, w, serving, stop } = await pair(async () => {
    n += 1;
    if (n === 1) return { ok: true, servers: [{ advert: 'z'.repeat(MAX_MESSAGE + 10) }] };
    throw new Error('boom');
  });
  const ch = await ta.connect(B.id, { send: w.sendAs(), poll: w.pollAs(A) });
  assert.deepEqual(await ch.request({ type: 'list' }), { ok: false, error: 'response too large' });
  assert.deepEqual(await ch.request({ type: 'list' }), { ok: false, error: 'boom' });
  ch.close(); ta.close(); tb.close();
  stop();
  await serving.catch(() => {});
});
