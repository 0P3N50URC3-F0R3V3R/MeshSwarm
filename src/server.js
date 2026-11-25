'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { verify } = require('./advert');
const { createLimiter } = require('./rateLimit');
const { createMailbox } = require('./mailbox');

const MAX_BODY = 40 * 1024;
const MAX_FUTURE_SKEW = 5 * 60_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; if (size - c.length <= MAX_BODY) reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer({ config, store, now = Date.now, peers, rtcPeers, mailbox: given }) {
  const allow = createLimiter({ perMinute: config.announcePerMinute, now });
  const rtc = config.rtc && config.rtc.enabled && config.rtc.mailbox ? (given || createMailbox({ now })) : null;
  const allowRtc = createLimiter({ perMinute: (config.rtc && config.rtc.perMinute) || 120, now });
  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || '';
  };

  const send = (res, status, json, headers = {}) => {
    res.writeHead(status, { ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
    res.end(json === undefined ? undefined : JSON.stringify(json));
  };

  async function announce(req, res) {
    if (!allow(clientIp(req))) return send(res, 429, { error: 'rate limited' });
    let text;
    try { text = (await readBody(req)).trim(); } catch (e) {
      res.on('finish', () => req.destroy());
      return send(res, e.status || 400, { error: e.message }, { Connection: 'close' });
    }
    const v = verify(text);
    if (!v.ok) return send(res, 400, { error: v.error });
    if (v.advert.updated > now() + MAX_FUTURE_SKEW) return send(res, 400, { error: 'advert is dated in the future' });
    if (req.method === 'DELETE') return store.remove(v.advert.url, v.advert.pub) ? send(res, 204) : send(res, 404, { error: 'not found' });
    if (store.count() >= config.maxEntries && !store.has(v.advert.url)) return send(res, 503, { error: 'tracker is full' });
    const r = store.announce(text, v.advert, now());
    return r.status === 'conflict' ? send(res, 409, { error: 'address is owned by another key' }) : send(res, 204);
  }

  async function rtcRoute(req, res, action) {
    if (!allowRtc(clientIp(req))) return send(res, 429, { error: 'rate limited' });
    let text;
    try { text = (await readBody(req)).trim(); } catch (e) {
      res.on('finish', () => req.destroy());
      return send(res, e.status || 400, { error: e.message }, { Connection: 'close' });
    }
    const r = action === 'poll' ? rtc.poll(text) : rtc.post(text);
    if (!r.ok) return send(res, 400, { error: r.error });
    return action === 'poll' ? send(res, 200, { messages: r.messages }) : send(res, 204);
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') return send(res, 204, undefined, CORS);
      if (url.pathname === '/announce' && (req.method === 'POST' || req.method === 'DELETE')) return await announce(req, res);
      if (rtc && req.method === 'POST' && (url.pathname === '/rtc/poll' || url.pathname === '/rtc/post')) return await rtcRoute(req, res, url.pathname.slice(5));
      if (req.method === 'GET' && url.pathname === '/list') {
        return send(res, 200, { servers: store.list({ since: url.searchParams.get('since'), limit: url.searchParams.get('limit') }) }, CORS);
      }
      if (req.method === 'GET' && url.pathname === '/peers') return send(res, 200, { peers: peers(), ...(rtcPeers ? { rtc: rtcPeers() } : {}) }, CORS);
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { name: config.name, servers: store.count() }, CORS);
      return send(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'internal error' }); else res.destroy();
    }
  };

  if (config.tls && config.tls.cert && config.tls.key) {
    return https.createServer({ cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }, handler);
  }
  return http.createServer(handler);
}

module.exports = { createServer };
