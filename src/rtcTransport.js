'use strict';

const { RTCPeerConnection } = require('werift');
const { signEnvelope, verifyEnvelope } = require('./identity');

const CHUNK = 16000;
const MAX_MESSAGE = 1_000_000;
const ACCEPT_IDLE_MS = 60_000;

const fingerprintOf = (sdp) => { const m = /^a=fingerprint:(\S+) (\S+)/m.exec(String(sdp)); return m ? `${m[1]} ${m[2].toUpperCase()}` : null; };

// A data channel message is limited to 64 KB, so a request or response is sent as base64 chunks
// "<id>:<index>:<total>:<data>" and put back together here (bounded by MAX_MESSAGE).
function frames(id, obj) {
  const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
  const total = Math.max(1, Math.ceil(b64.length / CHUNK));
  return Array.from({ length: total }, (_, i) => `${id}:${i}:${total}:${b64.slice(i * CHUNK, (i + 1) * CHUNK)}`);
}

function createAssembler(onMessage) {
  const open = new Map();
  return (raw) => {
    const m = /^(\d+):(\d+):(\d+):([A-Za-z0-9+/=]*)$/.exec(String(raw));
    if (!m) return;
    const [, id, index, total, data] = m;
    const n = Number(total);
    if (n < 1 || n > Math.ceil((MAX_MESSAGE * 4) / 3 / CHUNK) + 1 || Number(index) >= n) return;
    let entry = open.get(id);
    if (!entry) { entry = { parts: new Array(n), got: 0, size: 0 }; open.set(id, entry); }
    if (entry.parts[Number(index)] !== undefined) return;
    entry.parts[Number(index)] = data;
    entry.got += 1;
    entry.size += data.length;
    if (entry.size > (MAX_MESSAGE * 4) / 3 + 8) { open.delete(id); return; }
    if (entry.got === n) {
      open.delete(id);
      let obj = null;
      try { obj = JSON.parse(Buffer.from(entry.parts.join(''), 'base64').toString('utf8')); } catch { return; }
      onMessage(Number(id), obj);
    }
  };
}

function gathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    pc.iceGatheringStateChange.subscribe((s) => { if (s === 'complete') { clearTimeout(timer); resolve(); } });
  });
}

function createRtcTransport({ identity, stun = [], newPeerConnection, connectTimeoutMs = 20_000, requestTimeoutMs = 15_000, pollMs = 500, gatherMs = 5000, now = Date.now } = {}) {
  const make = newPeerConnection || (() => new RTCPeerConnection({ iceServers: stun.length ? [{ urls: stun }] : [] }));
  const live = new Set();
  let closed = false;

  const open = (pc) => { live.add(pc); return pc; };
  const shut = (pc) => { live.delete(pc); try { pc.close(); } catch { /* already closed */ } };

  function channelOf(pc, dc, incoming) {
    let nextId = 0;
    const waiting = new Map();
    const feed = createAssembler((id, obj) => {
      const w = waiting.get(id);
      if (w) { waiting.delete(id); clearTimeout(w.timer); w.resolve(obj); }
    });
    dc.onMessage.subscribe((raw) => { if (!incoming) feed(raw); });
    return {
      request(req) {
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => { waiting.delete(id); reject(new Error('peer did not answer in time')); }, requestTimeoutMs);
          waiting.set(id, { resolve, timer });
          try { for (const f of frames(id, req)) dc.send(f); } catch (e) { clearTimeout(timer); waiting.delete(id); reject(e); }
        });
      },
      close() { for (const w of waiting.values()) clearTimeout(w.timer); waiting.clear(); shut(pc); },
    };
  }

  async function connect(peerId, { send, poll }) {
    if (closed) throw new Error('transport is closed');
    const pc = open(make());
    try {
      const dc = pc.createDataChannel('sync');
      const opened = new Promise((resolve) => dc.stateChanged.subscribe((s) => { if (s === 'open') resolve(); }));
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, gatherMs);
      const sdp = pc.localDescription.sdp;
      const offer = signEnvelope(identity, { to: peerId, kind: 'offer', payload: { sdp } }, now());
      const offerNonce = verifyEnvelope(offer, now()).nonce;
      await send(offer);

      const deadline = Date.now() + connectTimeoutMs;
      let answer = null;
      while (!answer && Date.now() < deadline) {
        for (const str of await poll()) {
          const v = verifyEnvelope(str, now());
          if (v.ok && v.kind === 'answer' && v.from === peerId && v.to === identity.id && v.payload && v.payload.re === offerNonce && typeof v.payload.sdp === 'string' && fingerprintOf(v.payload.sdp)) { answer = v.payload; break; }
        }
        if (!answer) await new Promise((r) => setTimeout(r, pollMs));
      }
      if (!answer) throw new Error('no answer from the peer');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await Promise.race([opened, new Promise((_, rej) => setTimeout(() => rej(new Error('data channel did not open')), Math.max(1000, deadline - Date.now())))]);
      return channelOf(pc, dc, false);
    } catch (e) {
      shut(pc);
      throw e;
    }
  }

  // Answers one offer taken from the mailbox. `onRequest(req)` serves the requests that arrive on the channel.
  async function accept(envelope, { send }, onRequest) {
    if (closed) return;
    const v = verifyEnvelope(envelope, now());
    if (!v.ok || v.kind !== 'offer' || v.to !== identity.id || !v.payload || typeof v.payload.sdp !== 'string' || !fingerprintOf(v.payload.sdp)) return;
    const pc = open(make());
    let idle = setTimeout(() => shut(pc), ACCEPT_IDLE_MS);
    try {
      pc.onDataChannel.subscribe((dc) => {
        const feed = createAssembler(async (id, req) => {
          clearTimeout(idle);
          idle = setTimeout(() => shut(pc), ACCEPT_IDLE_MS);
          let out;
          try { out = await onRequest(req); } catch (e) { out = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) }; }
          if (Buffer.byteLength(JSON.stringify(out)) > MAX_MESSAGE) out = { ok: false, error: 'response too large' };
          try { for (const f of frames(id, out)) dc.send(f); } catch { /* channel closed */ }
        });
        dc.onMessage.subscribe(feed);
        dc.stateChanged.subscribe((s) => { if (s === 'closed') { clearTimeout(idle); shut(pc); } });
      });
      await pc.setRemoteDescription({ type: 'offer', sdp: v.payload.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, gatherMs);
      await send(signEnvelope(identity, { to: v.from, kind: 'answer', payload: { sdp: pc.localDescription.sdp, re: v.nonce } }, now()));
    } catch (e) {
      clearTimeout(idle);
      shut(pc);
    }
  }

  return {
    connect, accept,
    close() { closed = true; for (const pc of [...live]) shut(pc); },
    openCount: () => live.size,
  };
}

module.exports = { createRtcTransport, fingerprintOf, frames, createAssembler, CHUNK, MAX_MESSAGE };
