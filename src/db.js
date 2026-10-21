'use strict';
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS rounds (
  id            INTEGER PRIMARY KEY,           -- floor(start / roundSeconds)
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- open | live | settled
  pot_lamports  INTEGER,
  winners       INTEGER,
  settled_at    INTEGER,
  note          TEXT
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce       TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  round_id    INTEGER NOT NULL,
  picks       TEXT NOT NULL,
  message     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id    INTEGER NOT NULL REFERENCES rounds(id),
  wallet      TEXT NOT NULL,
  picks       TEXT NOT NULL,                   -- JSON array of 5 trader wallets, index 0 scores 2x
  cost        INTEGER NOT NULL,
  message     TEXT NOT NULL,
  signature   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (round_id, wallet)
);
CREATE TABLE IF NOT EXISTS trader_scores (
  round_id    INTEGER NOT NULL,
  trader      TEXT NOT NULL,
  pnl         REAL NOT NULL,
  sells       INTEGER NOT NULL,
  wins        INTEGER NOT NULL,
  losses      INTEGER NOT NULL,
  unmatched   INTEGER NOT NULL,
  final       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (round_id, trader)
);
CREATE TABLE IF NOT EXISTS results (
  round_id         INTEGER NOT NULL,
  entry_id         INTEGER NOT NULL REFERENCES entries(id),
  wallet           TEXT NOT NULL,
  score            REAL NOT NULL,
  rank             INTEGER NOT NULL,
  payout_lamports  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round_id, entry_id)
);
CREATE TABLE IF NOT EXISTS payouts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id           INTEGER NOT NULL,
  wallet             TEXT NOT NULL,
  lamports           INTEGER NOT NULL,
  status             TEXT NOT NULL,          -- pending | sending | sent | dry-run | failed
  tx_sig             TEXT,
  last_valid_height  INTEGER,
  attempts           INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (round_id, wallet)
);
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_wallet ON entries(wallet);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
`;

function openDb(path) {
  const db = new Database(path);
  db.exec(SCHEMA);
  // additive migrations for databases created by earlier versions
  for (const sql of ["ALTER TABLE rounds ADD COLUMN source TEXT", "ALTER TABLE rounds ADD COLUMN rare TEXT"]) {
    try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  return db;
}

module.exports = { openDb };
