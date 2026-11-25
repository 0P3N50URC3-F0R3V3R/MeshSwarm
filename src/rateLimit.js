'use strict';

function createLimiter({ perMinute, now = Date.now }) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (t - b.start >= 60_000) buckets.delete(k);
    let b = buckets.get(key);
    if (!b || t - b.start >= 60_000) { b = { start: t, n: 0 }; buckets.set(key, b); }
    return ++b.n <= perMinute;
  };
}

module.exports = { createLimiter };
