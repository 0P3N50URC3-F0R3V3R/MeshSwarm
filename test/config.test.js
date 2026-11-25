'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { load } = require('../src/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'meshswarm-cfg-'));

test('a missing file is created with defaults', () => {
  const dir = tmp();
  const cfg = load(dir);
  assert.equal(cfg.port, 19898);
  assert.equal(cfg.retentionDays, 7);
  assert.equal(cfg.maxEntries, 5000);
  assert.equal(cfg.announcePerMinute, 30);
  assert.deepEqual(cfg.peers, []);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a partial file merges per key and tls merges as an object', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 1234, tls: { cert: 'a.pem' } }));
  const cfg = load(dir);
  assert.equal(cfg.port, 1234);
  assert.equal(cfg.retentionDays, 7);
  assert.deepEqual(cfg.tls, { cert: 'a.pem', key: '' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt file falls back to defaults and is left untouched', () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ not json');
  const orig = console.error; console.error = () => {};
  const cfg = load(dir);
  console.error = orig;
  assert.equal(cfg.port, 19898);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.rmSync(dir, { recursive: true, force: true });
});
