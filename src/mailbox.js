'use strict';

const { verifyEnvelope } = require('./identity');

const PRESENCE_MS = 15 * 60_000;
const MESSAGE_MS = 5 * 60_000;
const MAX_PENDING = 200;

function createMailbox({ now = Date.now } = {}) {
  const present = new Map();
  let pending = [];

  const sweep = () => {
    const t = now();
    pending = pending.filter((m) => t - m.at < MESSAGE_MS);
    for (const [id, at] of present) if (t - at >= PRESENCE_MS) present.delete(id);
  };

  return {
    // A signed envelope of kind "register" proves the caller holds the key for its id: it marks the id as
    // present and returns whatever is waiting for it, so nobody else can read another tracker's messages.
    poll(envelope) {
      sweep();
      const v = verifyEnvelope(envelope, now());
      if (!v.ok || v.kind !== 'register') return { ok: false, error: 'bad envelope' };
      present.set(v.from, now());
      const mine = pending.filter((m) => m.to === v.from);
      pending = pending.filter((m) => m.to !== v.from);
      return { ok: true, messages: mine.map((m) => m.envelope) };
    },

    post(envelope) {
      sweep();
      const v = verifyEnvelope(envelope, now());
      if (!v.ok || (v.kind !== 'offer' && v.kind !== 'answer')) return { ok: false, error: 'bad envelope' };
      if (!present.has(v.to)) return { ok: false, error: 'recipient is not registered' };
      if (pending.length >= MAX_PENDING) return { ok: false, error: 'mailbox is full' };
      pending.push({ to: v.to, envelope, at: now() });
      return { ok: true };
    },

    size: () => pending.length,
  };
}

module.exports = { createMailbox, MAX_PENDING };
