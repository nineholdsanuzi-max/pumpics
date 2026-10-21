'use strict';
const fs = require('fs');
const path = require('path');

class Roster {
  constructor(traders, { updatedAt = null, source = 'file' } = {}) {
    this.replace(traders, { updatedAt, source });
  }
  replace(traders, { updatedAt = Math.floor(Date.now() / 1000), source = 'kolscan' } = {}) {
    this.list = traders;
    this.byWallet = new Map(traders.map((t) => [t.wallet, t]));
    this.updatedAt = updatedAt;
    this.source = source;
  }
  static load(file = path.join(__dirname, '..', 'data', 'traders.json')) {
    return new Roster(JSON.parse(fs.readFileSync(file, 'utf8')).traders);
  }
  /** Prefer the latest refreshed roster saved in the database; fall back to the bundled file. */
  static fromDb(db, file) {
    const row = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'roster'").get();
    if (row) {
      try { return new Roster(JSON.parse(row.value), { updatedAt: row.updated_at, source: 'kolscan' }); } catch {}
    }
    return Roster.load(file);
  }
  save(db) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('roster', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(this.list), this.updatedAt);
  }
  /** Validate a squad. Returns { ok, error, cost }. */
  check(picks, { squadSize = 5, budget = 100 } = {}) {
    if (!Array.isArray(picks)) return { ok: false, error: 'Picks must be a list of trader wallets.' };
    if (picks.length !== squadSize) return { ok: false, error: `Pick exactly ${squadSize} traders.` };
    if (new Set(picks).size !== picks.length) return { ok: false, error: 'Each trader can only be picked once.' };
    let cost = 0;
    for (const w of picks) {
      const t = typeof w === 'string' && this.byWallet.get(w);
      if (!t) return { ok: false, error: 'One of your picks is not on the PUMPICS roster.' };
      cost += t.price;
    }
    if (cost > budget) return { ok: false, error: `Your squad costs ${cost} credits. The limit is ${budget}.` };
    return { ok: true, cost };
  }
}

module.exports = { Roster };
