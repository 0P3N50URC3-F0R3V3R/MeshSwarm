'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.MESHSWARM_DATA_DIR || path.join(__dirname, '..', 'data');

const DEFAULTS = {
  name: 'MeshSwarm',
  port: 19898,
  host: '0.0.0.0',
  // Cert and key (PEM paths) for direct HTTPS; leave empty to serve plain HTTP behind a reverse proxy.
  tls: { cert: '', key: '' },
  retentionDays: 7,
  maxEntries: 5000,
  announcePerMinute: 30,
  // Honour X-Forwarded-For for rate limiting; only turn on behind a proxy you control.
  trustProxy: false,
  peers: [],
  seedPeers: [],
  publicUrl: '',
  allowPrivatePeers: false,
  // WebRTC peering for trackers without a public https address. Off by default: nothing below runs and no
  // UDP socket is opened. `mailbox` lets a reachable tracker act as the rendezvous point for others.
  rtc: {
    enabled: false,
    stun: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
    mailbox: true,
    peers: [],
    perMinute: 120,
  },
  syncMinutes: 5,
  sweepMinutes: 10,
};

function merge(file) {
  return { ...DEFAULTS, ...file, tls: { ...DEFAULTS.tls, ...(file.tls || {}) }, rtc: { ...DEFAULTS.rtc, ...(file.rtc || {}) } };
}

function load(dir = DATA_DIR) {
  const file = path.join(dir, 'config.json');
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[config] could not read ${file} (${e.code || e.message}), using defaults`);
      return merge({});
    }
  }
  if (text === null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2));
    return merge({});
  }
  try {
    return merge(JSON.parse(text));
  } catch (e) {
    console.error(`[config] ${file} is not valid JSON (${e.message}), using defaults and leaving it untouched`);
    return merge({});
  }
}

module.exports = { load, DEFAULTS, DATA_DIR };
