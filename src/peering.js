'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { verify } = require('./advert');
const { signEnvelope } = require('./identity');

const BACKOFF_FIRST = 60_000;
const BACKOFF_MAX = 3_600_000;
const MAX_PEERS = 50;
const MAX_RESPONSE = 12 * 1024 * 1024;
const MAX_FUTURE_SKEW = 5 * 60_000;
const TIMEOUT = 10_000;

function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || a >= 224 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (type === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateIp(m[1]) : false;
  }
  return true;
}

// The address that is checked is the one that gets connected to, so a name that resolves to a public
// address first and a private one later cannot be used to reach the LAN.
function pinnedLookup(host, options, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(Object.assign(new Error('peer resolves to a non-public address'), { code: 'EBLOCKED' }));
    return options && options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}

function requestJson(url, allowPrivate, { method = 'GET', body } = {}) {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'https:';
  if (!secure && !(allowPrivate && parsed.protocol === 'http:')) return Promise.reject(new Error('peer must be https'));
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) return Promise.reject(new Error('peer address is not public'));
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) };
    const req = transport.request(url, { method, headers, timeout: TIMEOUT, ...(allowPrivate ? {} : { lookup: pinnedLookup }) }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) { req.destroy(new Error('peer response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode === 204) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`peer answered ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('peer sent invalid JSON')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('peer timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const getJson = (url, allowPrivate) => requestJson(url, allowPrivate);

function normalizePeer(raw, allowPrivate) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return null;
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  if (!allowPrivate && (host === 'localhost' || (net.isIP(host) && isPrivateIp(host)))) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

const RTC_ENTRY = /^rtc:([A-Za-z0-9_-]{43})@(https?:\/\/\S+)$/;
const MAX_RTC_RESPONSE = 900_000;

function createPeering({ config, store, now = Date.now, getImpl = getJson, maxPerPeer = 5000, rtc = null, requestImpl = requestJson }) {
  const rtcOn = !!(rtc && config.rtc && config.rtc.enabled);
  const peers = new Map();
  let syncTimer = null;
  let sweepTimer = null;
  let rtcTimer = null;
  let running = null;

  const add = (raw) => {
    const entry = RTC_ENTRY.exec(String(raw).trim());
    if (entry) {
      const mailbox = normalizePeer(entry[2], config.allowPrivatePeers);
      if (!rtcOn || !mailbox || entry[1] === rtc.identity.id) return;
      const key = `rtc:${entry[1]}@${mailbox}`;
      if (!peers.has(key) && peers.size < MAX_PEERS) peers.set(key, { url: key, transport: 'rtc', rtc: { peerId: entry[1], mailbox }, failures: 0, nextTry: 0, since: 0, lastError: '' });
      return;
    }
    const url = normalizePeer(raw, config.allowPrivatePeers);
    if (!url || url === config.publicUrl || peers.has(url) || peers.size >= MAX_PEERS) return;
    peers.set(url, { url, transport: 'https', failures: 0, nextTry: 0, since: 0, lastError: '' });
  };
  for (const p of [...config.peers, ...config.seedPeers, ...((config.rtc && config.rtc.peers) || [])]) add(p);

  const httpsPeers = () => [...peers.values()].filter((st) => st.transport === 'https').map((st) => st.url);
  const rtcPeers = () => [...peers.values()].filter((st) => st.transport === 'rtc').map((st) => st.url);

  function mailboxIO(mailbox) {
    return {
      send: async (envelope) => { await requestImpl(`${mailbox}/rtc/post`, config.allowPrivatePeers, { method: 'POST', body: envelope }); },
      poll: async () => {
        const res = await requestImpl(`${mailbox}/rtc/poll`, config.allowPrivatePeers, { method: 'POST', body: signEnvelope(rtc.identity, { to: 'mailbox', kind: 'register', payload: null }, now()) });
        return Array.isArray(res && res.messages) ? res.messages : [];
      },
    };
  }

  // What a peer may ask over a data channel: the same two requests as over https, with the same caps; a list is
  // packed oldest first so a truncated answer is continued by the next sync.
  async function rtcServe(req) {
    if (req && req.type === 'peers') return { ok: true, peers: httpsPeers(), rtc: rtcPeers() };
    if (req && req.type === 'list') {
      const limit = Math.max(1, Math.min(Number(req.limit) || 500, 5000));
      const rows = store.list({ since: req.since, limit }).reverse();
      const out = [];
      let size = 0;
      for (const row of rows) {
        size += row.advert.length + 40;
        if (size > MAX_RTC_RESPONSE) break;
        out.push(row);
      }
      return { ok: true, servers: out };
    }
    return { ok: false, error: 'unknown request' };
  }

  async function rtcTick() {
    if (!rtcOn) return;
    const mailboxes = ((config.rtc && config.rtc.mailboxes) || []).length ? config.rtc.mailboxes : httpsPeers();
    await Promise.all(mailboxes.map(async (mailbox) => {
      try {
        const io = mailboxIO(mailbox);
        for (const env of await io.poll()) rtc.transport.accept(env, { send: io.send }, rtcServe);
      } catch { /* mailbox unreachable or not a mailbox: ignore */ }
    }));
  }

  async function syncPeer(st) {
    try {
      let data; let more = null;
      if (st.transport === 'rtc') {
        const io = mailboxIO(st.rtc.mailbox);
        const ch = await rtc.transport.connect(st.rtc.peerId, io);
        try {
          data = await ch.request({ type: 'list', since: st.since, limit: maxPerPeer });
          if (!data || data.ok === false) throw new Error((data && data.error) || 'peer refused the list');
          try { more = await ch.request({ type: 'peers' }); } catch { /* peer exchange is optional */ }
        } finally { ch.close(); }
      } else {
        data = await getImpl(`${st.url}/list?since=${st.since}&limit=${maxPerPeer}`, config.allowPrivatePeers);
        try { more = await getImpl(`${st.url}/peers`, config.allowPrivatePeers); } catch { /* peer exchange is optional */ }
      }
      let newest = st.since;
      for (const item of (Array.isArray(data && data.servers) ? data.servers : []).slice(0, maxPerPeer)) {
        const v = item && verify(item.advert);
        if (!v || !v.ok || v.advert.updated > now() + MAX_FUTURE_SKEW) continue;
        store.import(item.advert, v.advert, item.lastSeen, now());
        newest = Math.max(newest, Math.min(Number(item.lastSeen) || 0, now()));
      }
      st.since = newest;
      for (const p of Array.isArray(more && more.peers) ? more.peers : []) add(p);
      for (const p of Array.isArray(more && more.rtc) ? more.rtc : []) add(p);
      st.failures = 0; st.nextTry = 0; st.lastError = '';
    } catch (e) {
      st.failures += 1;
      st.lastError = String(e && e.message ? e.message : e).slice(0, 200);
      st.nextTry = now() + Math.min(BACKOFF_FIRST * 2 ** (st.failures - 1), BACKOFF_MAX);
    }
  }

  function syncOnce() {
    if (running) return running;
    running = (async () => {
      await Promise.all([...peers.values()].filter((st) => st.nextTry <= now()).map(syncPeer));
    })().finally(() => { running = null; });
    return running;
  }

  return {
    syncOnce,
    peerList: httpsPeers,
    rtcList: rtcPeers,
    rtcTick,
    status: () => [...peers.values()],
    start() {
      if (syncTimer) return;
      syncOnce();
      syncTimer = setInterval(() => { syncOnce(); }, config.syncMinutes * 60_000);
      sweepTimer = setInterval(() => { store.sweep(now(), config.retentionDays, config.maxEntries); }, config.sweepMinutes * 60_000);
      syncTimer.unref(); sweepTimer.unref();
      if (rtcOn) {
        rtcTimer = setInterval(() => { rtcTick(); }, (config.rtc && config.rtc.pollMs) || 3000);
        rtcTimer.unref();
        rtcTick();
      }
    },
    stop() {
      clearInterval(syncTimer); clearInterval(sweepTimer); clearInterval(rtcTimer);
      syncTimer = null; sweepTimer = null; rtcTimer = null;
      if (rtcOn) rtc.transport.close();
    },
  };
}

module.exports = { createPeering, normalizePeer, isPrivateIp, requestJson };
