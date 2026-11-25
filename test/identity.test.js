'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadOrCreateIdentity, signEnvelope, verifyEnvelope, MAX_PAYLOAD } = require('../src/identity');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-id-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const NOW = 1_000_000_000;

test('the key is created once and reused', () => {
  const a = loadOrCreateIdentity(dir);
  assert.equal(loadOrCreateIdentity(dir).id, a.id);
  assert.ok(fs.existsSync(path.join(dir, 'tracker-key.json')));
});

test('an envelope round-trips', () => {
  const id = loadOrCreateIdentity(dir);
  const r = verifyEnvelope(signEnvelope(id, { to: 'peerB', kind: 'offer', payload: { sdp: 'v=0' } }, NOW), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.from, id.id);
  assert.equal(r.to, 'peerB');
  assert.deepEqual(r.payload, { sdp: 'v=0' });
});

test('tampering, a swapped sender and a bad kind are refused', () => {
  const id = loadOrCreateIdentity(dir);
  const good = signEnvelope(id, { to: 'peerB', kind: 'offer', payload: 'x' }, NOW);
  const [p, s] = good.split('.');
  const edit = (from, to) => `${Buffer.from(Buffer.from(p, 'base64url').toString().replace(from, to)).toString('base64url')}.${s}`;
  assert.equal(verifyEnvelope(edit('"peerB"', '"peerC"'), NOW).ok, false);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  assert.equal(verifyEnvelope(edit(id.id, other), NOW).ok, false);
  assert.equal(verifyEnvelope(signEnvelope(id, { to: 'b', kind: 'bogus', payload: null }, NOW), NOW).ok, false);
  assert.equal(verifyEnvelope('nonsense', NOW).ok, false);
  assert.equal(verifyEnvelope(42, NOW).ok, false);
});

test('stale and future timestamps are refused', () => {
  const id = loadOrCreateIdentity(dir);
  assert.equal(verifyEnvelope(signEnvelope(id, { to: 'b', kind: 'offer', payload: null }, NOW - 6 * 60_000), NOW).ok, false);
  assert.equal(verifyEnvelope(signEnvelope(id, { to: 'b', kind: 'offer', payload: null }, NOW + 2 * 60_000), NOW).ok, false);
  assert.equal(verifyEnvelope(signEnvelope(id, { to: 'b', kind: 'offer', payload: null }, NOW - 4 * 60_000), NOW).ok, true);
});

test('an oversized payload is refused', () => {
  const id = loadOrCreateIdentity(dir);
  assert.equal(verifyEnvelope(signEnvelope(id, { to: 'b', kind: 'offer', payload: 'x'.repeat(MAX_PAYLOAD + 10) }, NOW), NOW).ok, false);
});
