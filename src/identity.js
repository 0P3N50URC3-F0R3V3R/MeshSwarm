'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_PAYLOAD = 16 * 1024;
const MAX_AGE = 5 * 60_000;
const MAX_FUTURE = 60_000;
const KINDS = ['offer', 'answer', 'register'];

function loadOrCreateIdentity(dir) {
  const file = path.join(dir, 'tracker-key.json');
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first start or unreadable: make a new key */ }
  if (!stored || typeof stored.privateKey !== 'string' || typeof stored.publicKey !== 'string') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    stored = {
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  }
  const key = crypto.createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return { id: stored.publicKey, sign: (bytes) => crypto.sign(null, bytes, key) };
}

function signEnvelope(identity, { to, kind, payload }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ v: 1, from: identity.id, to, kind, ts: now, nonce: crypto.randomBytes(8).toString('base64url'), payload }));
  return `${body.toString('base64url')}.${identity.sign(body).toString('base64url')}`;
}

function verifyEnvelope(str, now = Date.now()) {
  const bad = { ok: false };
  if (typeof str !== 'string' || str.length > MAX_PAYLOAD * 2) return bad;
  const parts = str.split('.');
  if (parts.length !== 2) return bad;
  let body; let env;
  try {
    body = Buffer.from(parts[0], 'base64url');
    env = JSON.parse(body.toString('utf8'));
  } catch { return bad; }
  if (!env || env.v !== 1 || typeof env.from !== 'string' || typeof env.to !== 'string' || !KINDS.includes(env.kind) || !Number.isFinite(env.ts)) return bad;
  if (env.ts < now - MAX_AGE || env.ts > now + MAX_FUTURE) return bad;
  if (Buffer.byteLength(JSON.stringify(env.payload === undefined ? null : env.payload)) > MAX_PAYLOAD) return bad;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(env.from, 'base64url')]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, body, pub, Buffer.from(parts[1], 'base64url'))) return bad;
  } catch { return bad; }
  return { ok: true, from: env.from, to: env.to, kind: env.kind, ts: env.ts, nonce: env.nonce, payload: env.payload };
}

module.exports = { loadOrCreateIdentity, signEnvelope, verifyEnvelope, MAX_PAYLOAD };
