'use strict';

const { DatabaseSync } = require('node:sqlite');
const DAY = 86_400_000;

function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS entries (
    url TEXT PRIMARY KEY, pub TEXT NOT NULL, advert TEXT NOT NULL, updated REAL NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS entries_seen ON entries (last_seen)`);

  const get = db.prepare('SELECT pub, first_seen, last_seen FROM entries WHERE url = ?');
  const upsert = db.prepare(`INSERT INTO entries (url, pub, advert, updated, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET advert = excluded.advert, updated = excluded.updated, last_seen = excluded.last_seen`);

  return {
    announce(advertString, advert, now) {
      const cur = get.get(advert.url);
      if (cur && cur.pub !== advert.pub) return { status: 'conflict', created: false };
      upsert.run(advert.url, advert.pub, advertString, advert.updated, cur ? cur.first_seen : now, now);
      return { status: 'ok', created: !cur };
    },

    import(advertString, advert, lastSeen, now) {
      const seen = Math.min(Number(lastSeen) || 0, now);
      const cur = get.get(advert.url);
      if (cur && cur.pub !== advert.pub) return false;
      if (cur && seen <= cur.last_seen) return false;
      upsert.run(advert.url, advert.pub, advertString, advert.updated, cur ? cur.first_seen : now, seen);
      return true;
    },

    remove(url, pub) {
      const cur = get.get(url);
      if (!cur || cur.pub !== pub) return false;
      db.prepare('DELETE FROM entries WHERE url = ?').run(url);
      return true;
    },

    list({ since = 0, limit = 500 }) {
      return db.prepare('SELECT advert, last_seen FROM entries WHERE last_seen > ? ORDER BY last_seen DESC LIMIT ?')
        .all(Number(since) || 0, Math.max(1, Math.min(Number(limit) || 500, 5000)))
        .map((r) => ({ advert: r.advert, lastSeen: r.last_seen }));
    },

    sweep(now, retentionDays, maxEntries) {
      let removed = Number(db.prepare('DELETE FROM entries WHERE last_seen < ?').run(now - retentionDays * DAY).changes);
      const over = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n - maxEntries;
      if (over > 0) removed += Number(db.prepare('DELETE FROM entries WHERE url IN (SELECT url FROM entries ORDER BY last_seen ASC LIMIT ?)').run(over).changes);
      return removed;
    },

    has: (url) => !!get.get(url),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,
    close: () => db.close(),
  };
}

module.exports = { openStore };
