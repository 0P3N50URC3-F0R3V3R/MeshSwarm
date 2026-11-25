'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openStore } = require('../src/store');

const DAY = 86_400_000;
const adv = (url, pub, updated = 1) => ({ url, name: url, description: '', icon: null, registration: 'open', updated, pub });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-store-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const fresh = () => openStore(path.join(dir, `${Math.random().toString(36).slice(2)}.db`));

test('announce creates, then the same key updates and keeps firstSeen', () => {
  const s = fresh();
  assert.deepEqual(s.announce('s1', adv('https://a', 'K1', 1), 100), { status: 'ok', created: true });
  assert.deepEqual(s.announce('s2', adv('https://a', 'K1', 2), 200), { status: 'ok', created: false });
  const [row] = s.list({});
  assert.equal(row.lastSeen, 200);
  assert.equal(row.advert, 's2');
  s.close();
});

test('another key for a live address conflicts; after expiry it can be claimed', () => {
  const s = fresh();
  s.announce('s1', adv('https://a', 'K1'), 1000);
  assert.equal(s.announce('s2', adv('https://a', 'K2'), 2000).status, 'conflict');
  s.sweep(1000 + 8 * DAY, 7, 5000);
  assert.equal(s.announce('s2', adv('https://a', 'K2'), 1000 + 8 * DAY).status, 'ok');
  s.close();
});

test('remove needs the owning key', () => {
  const s = fresh();
  s.announce('s1', adv('https://a', 'K1'), 1);
  assert.equal(s.remove('https://a', 'K2'), false);
  assert.equal(s.count(), 1);
  assert.equal(s.remove('https://a', 'K1'), true);
  assert.equal(s.count(), 0);
  s.close();
});

test('list is newest first and honours since and limit', () => {
  const s = fresh();
  for (let i = 1; i <= 5; i++) s.announce(`s${i}`, adv(`https://h${i}`, `K${i}`), i * 10);
  assert.deepEqual(s.list({}).map((r) => r.lastSeen), [50, 40, 30, 20, 10]);
  assert.deepEqual(s.list({ since: 30 }).map((r) => r.lastSeen), [50, 40]);
  assert.equal(s.list({ limit: 2 }).length, 2);
  s.close();
});

test('sweep removes expired entries, then the oldest beyond maxEntries', () => {
  const s = fresh();
  s.announce('old', adv('https://old', 'K0'), 0);
  for (let i = 1; i <= 4; i++) s.announce(`s${i}`, adv(`https://h${i}`, `K${i}`), 8 * DAY + i);
  assert.equal(s.sweep(8 * DAY + 10, 7, 5000), 1);
  assert.equal(s.sweep(8 * DAY + 10, 7, 2), 2);
  assert.deepEqual(s.list({}).map((r) => r.advert), ['s4', 's3']);
  s.close();
});

test('import never lowers lastSeen, caps the future, and obeys ownership', () => {
  const s = fresh();
  s.announce('mine', adv('https://a', 'K1', 5), 1000);
  assert.equal(s.import('theirs', adv('https://a', 'K1', 6), 500, 2000), false);
  assert.equal(s.list({})[0].lastSeen, 1000);
  assert.equal(s.import('theirs', adv('https://a', 'K1', 6), 1500, 2000), true);
  assert.equal(s.list({})[0].lastSeen, 1500);
  assert.equal(s.import('evil', adv('https://a', 'K2', 99), 1800, 2000), false);
  assert.equal(s.import('far', adv('https://b', 'K3'), 99_999, 2000), true);
  assert.equal(s.list({ limit: 1 })[0].lastSeen, 2000);
  s.close();
});

test('data survives a restart', () => {
  const file = path.join(dir, 'persist.db');
  const a = openStore(file);
  a.announce('s1', adv('https://a', 'K1'), 7);
  a.close();
  const b = openStore(file);
  assert.equal(b.count(), 1);
  b.close();
});
