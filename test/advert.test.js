'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verify } = require('../src/advert');

const VECTOR = 'eyJ2IjoxLCJ1cmwiOiJodHRwczovL3ZlY3Rvci5leGFtcGxlLmNvbTo4NDQzIiwibmFtZSI6IlZlY3RvciIsImRlc2NyaXB0aW9uIjoiaW50ZXJvcCB0ZXN0IiwiaWNvbiI6bnVsbCwicmVnaXN0cmF0aW9uIjoiaW52aXRlIiwidXBkYXRlZCI6MTcwMDAwMDAwMDAwMCwicHViIjoicTh1OGFRRW1NXzVORDZ1LXM1bVdWcEltWk11SFFEanh0eHItVFlMT09fOCJ9.QZrmQkps9mznKHd0XYlqrMbW1sSWE2QEKhGrm4YVSCdeLCcG8koKIVheDIEOInQ1I0l864yDRueyjCDSicnKBw';

function make(over = {}, keys = crypto.generateKeyPairSync('ed25519')) {
  const pub = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ v: 1, url: 'https://a.example.com', name: 'A', description: 'd', icon: null, registration: 'open', updated: 1000, pub, ...over }));
  return `${payload.toString('base64url')}.${crypto.sign(null, payload, keys.privateKey).toString('base64url')}`;
}
const edit = (str, from, to) => {
  const [p, s] = str.split('.');
  return `${Buffer.from(Buffer.from(p, 'base64url').toString().replace(from, to)).toString('base64url')}.${s}`;
};

test('an advert built by a MeshCrowd server verifies', () => {
  const r = verify(VECTOR);
  assert.equal(r.ok, true);
  assert.equal(r.advert.name, 'Vector');
  assert.equal(r.advert.registration, 'invite');
  assert.equal(r.advert.url, 'https://vector.example.com:8443');
});

test('tampering and a swapped key are refused', () => {
  assert.equal(verify(edit(VECTOR, 'Vector', 'Vecxor')).ok, false);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const good = make();
  const pub = JSON.parse(Buffer.from(good.split('.')[0], 'base64url')).pub;
  assert.equal(verify(edit(good, pub, other)).ok, false);
});

test('shape and size limits', () => {
  assert.equal(verify(make({ url: 'http://a.example.com' })).ok, false);
  assert.equal(verify(make({ url: ['https://a.example.com'] })).ok, false);
  assert.equal(verify(make({ url: 'https://u:p@a.example.com' })).ok, false);
  assert.equal(verify(make({ registration: 'maybe' })).ok, false);
  assert.equal(verify(make({ name: 'x'.repeat(61) })).ok, false);
  assert.equal(verify(make({ description: 'y'.repeat(301) })).ok, false);
  assert.equal(verify(make({ icon: 'data:image/jpeg;base64,AAAA' })).ok, false);
  assert.equal(verify(make({ description: 'x'.repeat(40000) })).ok, false);
  assert.equal(verify(make({ updated: 'now' })).ok, false);
  assert.equal(verify('nonsense').ok, false);
  assert.equal(verify(42).ok, false);
});

test('control and bidi characters in text are refused; extra keys are dropped', () => {
  assert.equal(verify(make({ name: 'a‮b' })).ok, false);
  assert.equal(verify(make({ description: 'line\nbreak' })).ok, false);
  const r = verify(make({ extra: 'junk', __proto__x: 1 }));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.advert).sort(), ['description', 'icon', 'name', 'pub', 'registration', 'updated', 'url']);
});
