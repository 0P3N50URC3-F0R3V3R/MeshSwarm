'use strict';

const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');
const { openStore } = require('./store');
const { createServer } = require('./server');
const { createPeering } = require('./peering');

const cfg = config.load();
fs.mkdirSync(config.DATA_DIR, { recursive: true });
const store = openStore(path.join(config.DATA_DIR, 'swarm.db'));
let rtc = null;
if (cfg.rtc.enabled) {
  const identity = require('./identity').loadOrCreateIdentity(config.DATA_DIR);
  rtc = { identity, transport: require('./rtcTransport').createRtcTransport({ identity, stun: cfg.rtc.stun }) };
}
const peering = createPeering({ config: cfg, store, rtc });
const server = createServer({ config: cfg, store, peers: peering.peerList, rtcPeers: rtc ? peering.rtcList : null });

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

server.on('error', (e) => {
  console.error(`[meshswarm] cannot listen on ${cfg.host}:${cfg.port} (${e.code || e.message})`);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log(`[meshswarm] listening on ${cfg.tls.cert ? 'https' : 'http'}://${cfg.host}:${cfg.port}, ${store.count()} servers stored, ${peering.peerList().length} peers`);
  if (rtc) log(`[meshswarm] rtc enabled, tracker id ${rtc.identity.id} (peers reach this tracker as rtc:${rtc.identity.id}@<mailbox url>)`);
  peering.start();
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  peering.stop();
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => { try { store.close(); } catch { /* already closed */ } process.exit(0); }, 3000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);
