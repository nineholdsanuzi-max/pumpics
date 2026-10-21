'use strict';
const { realizedPnl, squadScore, rankAndPay, ownership, rareSet } = require('./scoring');
const { isPubkey, entryMessage, newNonce, verifySignature } = require('./auth');

const LAMPORTS = 1e9;
const VOID_AFTER_SECONDS = 18 * 3600; // trade history window is 24h; give up well before basis data ages out

class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

class Game {
  constructor({ db, cfg, roster, source, sources, chain, rosterRefresher = null, now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    Object.assign(this, { db, cfg, roster, chain, rosterRefresher, now, log });
    // Trade sources in priority order. A round is always scored entirely by ONE source.
    this.sources = sources || [source];
    this.sources.forEach((src, i) => { if (!src.name) src.name = 'source' + (i + 1); });
    this.health = Object.fromEntries(this.sources.map((src) => [src.name, { ok: null, at: null, error: null }]));
    this.health.roster = { ok: null, at: null, error: null };
    this.busy = { settle: false, payouts: false, live: false, roster: false };
    this.lastLiveAt = 0;
    this.q = {
      round: db.prepare('SELECT * FROM rounds WHERE id = ?'),
      insRound: db.prepare('INSERT OR IGNORE INTO rounds (id, start_ts, end_ts, status) VALUES (?, ?, ?, ?)'),
      setStatus: db.prepare("UPDATE rounds SET status = ? WHERE id = ? AND status != 'settled'"),
      insNonce: db.prepare('INSERT INTO nonces (nonce, wallet, round_id, picks, message, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
      nonce: db.prepare('SELECT * FROM nonces WHERE nonce = ?'),
      useNonce: db.prepare('UPDATE nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL'),
      upsertEntry: db.prepare(`INSERT INTO entries (round_id, wallet, picks, cost, message, signature, created_at, updated_at)
        VALUES (@round_id, @wallet, @picks, @cost, @message, @signature, @now, @now)
        ON CONFLICT(round_id, wallet) DO UPDATE SET picks = excluded.picks, cost = excluded.cost, message = excluded.message,
        signature = excluded.signature, updated_at = excluded.updated_at`),
      entriesFor: db.prepare('SELECT * FROM entries WHERE round_id = ? ORDER BY created_at, id'),
      entryCount: db.prepare('SELECT COUNT(*) AS n FROM entries WHERE round_id = ?'),
      entryOf: db.prepare('SELECT * FROM entries WHERE round_id = ? AND wallet = ?'),
      upsertScore: db.prepare(`INSERT INTO trader_scores (round_id, trader, pnl, sells, wins, losses, unmatched, final, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(round_id, trader) DO UPDATE SET pnl = excluded.pnl, sells = excluded.sells,
        wins = excluded.wins, losses = excluded.losses, unmatched = excluded.unmatched, final = excluded.final, updated_at = excluded.updated_at`),
      scores: db.prepare('SELECT * FROM trader_scores WHERE round_id = ?'),
      insResult: db.prepare('INSERT OR REPLACE INTO results (round_id, entry_id, wallet, score, rank, payout_lamports) VALUES (?, ?, ?, ?, ?, ?)'),
      results: db.prepare('SELECT r.*, e.picks FROM results r JOIN entries e ON e.id = r.entry_id WHERE r.round_id = ? ORDER BY r.rank, r.entry_id'),
      insPayout: db.prepare('INSERT OR IGNORE INTO payouts (round_id, wallet, lamports, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
      payoutsFor: db.prepare('SELECT * FROM payouts WHERE round_id = ? ORDER BY id'),
      payoutsByStatus: db.prepare('SELECT * FROM payouts WHERE status = ? ORDER BY id'),
      owed: db.prepare("SELECT COALESCE(SUM(lamports), 0) AS l FROM payouts WHERE status IN ('pending', 'sending')"),
      updPayout: db.prepare('UPDATE payouts SET status = @status, tx_sig = @tx_sig, last_valid_height = @lvh, attempts = @attempts, error = @error, updated_at = @now WHERE id = @id'),
      settle: db.prepare("UPDATE rounds SET status = 'settled', pot_lamports = ?, winners = ?, settled_at = ?, note = ? WHERE id = ?"),
      note: db.prepare('UPDATE rounds SET note = ? WHERE id = ?'),
      unsettled: db.prepare("SELECT * FROM rounds WHERE status != 'settled' AND end_ts + ? <= ? ORDER BY id"),
      history: db.prepare(`SELECT e.round_id, e.picks, e.cost, r.score, r.rank, r.payout_lamports, p.status AS payout_status, p.tx_sig
        FROM entries e LEFT JOIN results r ON r.entry_id = e.id LEFT JOIN payouts p ON p.round_id = e.round_id AND p.wallet = e.wallet
        WHERE e.wallet = ? ORDER BY e.round_id DESC LIMIT 50`),
      recent: db.prepare("SELECT * FROM rounds WHERE status = 'settled' ORDER BY id DESC LIMIT ?"),
      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
      setSource: db.prepare('UPDATE rounds SET source = ? WHERE id = ?'),
      setRare: db.prepare('UPDATE rounds SET rare = ? WHERE id = ?'),
      addEvent: db.prepare('INSERT INTO events (at, kind, message) VALUES (?, ?, ?)'),
      events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
      roundsAdmin: db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM entries e WHERE e.round_id = r.id) AS entries FROM rounds r ORDER BY r.id DESC LIMIT ?`),
      payoutsAdmin: db.prepare('SELECT * FROM payouts ORDER BY id DESC LIMIT ?'),
      payout: db.prepare('SELECT * FROM payouts WHERE id = ?'),
      delPayouts: db.prepare("DELETE FROM payouts WHERE round_id = ? AND status IN ('pending', 'dry-run')"),
      paidCount: db.prepare("SELECT COUNT(*) AS n FROM payouts WHERE round_id = ? AND status IN ('sending', 'sent')"),
      zeroResults: db.prepare('UPDATE results SET payout_lamports = 0 WHERE round_id = ?'),
      forceSettle: db.prepare("UPDATE rounds SET status = 'settled', pot_lamports = 0, winners = 0, settled_at = ?, note = ? WHERE id = ?"),
    };
  }

  // ---------- settings & audit log ----------
  setting(key, fallback = null) { const r = this.q.getSetting.get(key); return r ? JSON.parse(r.value) : fallback; }
  setSetting(key, value) { this.q.setSetting.run(key, JSON.stringify(value), this.now()); }
  paused() { return this.setting('paused', { entries: false, payouts: false }); }
  event(kind, message) { this.q.addEvent.run(this.now(), kind, message); this.log(`[${kind}] ${message}`); }

  // ---------- rounds ----------
  roundIdAt(ts) { return Math.floor(ts / this.cfg.roundSeconds); }
  ensureRound(id) {
    const start = id * this.cfg.roundSeconds;
    this.q.insRound.run(id, start, start + this.cfg.roundSeconds, 'open');
    return this.q.round.get(id);
  }
  liveRoundId() { return this.roundIdAt(this.now()); }
  openRoundId() { return this.liveRoundId() + 1; }

  // ---------- pot ----------
  potFromBalance(balanceLamports, owedLamports = 0) {
    const free = balanceLamports - owedLamports - Math.round(this.cfg.reserveSol * LAMPORTS);
    if (free <= 0) return 0;
    return Math.min(Math.floor(free * this.cfg.potShare), Math.round(this.cfg.maxPayoutSol * LAMPORTS));
  }
  async projectedPot() {
    const bal = await this.chain.getTreasuryLamports();
    return { treasuryLamports: bal, potLamports: this.potFromBalance(bal, this.q.owed.get().l) };
  }

  // ---------- entries ----------
  async assertHolder(wallet) {
    if (!this.cfg.tokenMint || !(this.cfg.minTokenHold > 0)) return;
    let held;
    try { held = await this.chain.getTokenBalanceUi(wallet, this.cfg.tokenMint); } catch (e) {
      throw new GameError('Could not check your token balance right now. Try again in a minute.', 503);
    }
    if (held < this.cfg.minTokenHold) {
      throw new GameError(`Hold at least ${this.cfg.minTokenHold.toLocaleString('en-US')} PUMPICS to enter. This wallet holds ${held.toLocaleString('en-US')}.`, 403);
    }
  }

  async challenge(wallet, picks) {
    if (this.paused().entries) throw new GameError('Entries are paused for a moment. Try again shortly.', 503);
    if (!isPubkey(wallet)) throw new GameError('That is not a valid Solana wallet address.');
    const check = this.roster.check(picks, { squadSize: this.cfg.squadSize, budget: this.cfg.budget });
    if (!check.ok) throw new GameError(check.error);
    await this.assertHolder(wallet);
    const roundId = this.openRoundId();
    const round = this.ensureRound(roundId);
    if (round.status === 'settled') throw new GameError('The operator closed this round. Try again for the next one.', 409);
    const nonce = newNonce();
    const now = this.now();
    const message = entryMessage({ wallet, roundId, roundStartIso: new Date(round.start_ts * 1000).toISOString(), picks, nonce, issuedIso: new Date(now * 1000).toISOString() });
    this.q.insNonce.run(nonce, wallet, roundId, JSON.stringify(picks), message, now + this.cfg.nonceTtlSeconds);
    return { nonce, message, roundId, cost: check.cost, closesAt: round.start_ts };
  }

  async submitEntry({ wallet, nonce, signature }) {
    const n = typeof nonce === 'string' && this.q.nonce.get(nonce);
    if (!n || n.wallet !== wallet) throw new GameError('This signing request was not found. Start again.');
    const now = this.now();
    if (n.used_at) throw new GameError('This signature was already used. Start again.');
    if (n.expires_at < now) throw new GameError('This signing request expired. Start again.');
    const round = this.q.round.get(n.round_id);
    if (!round || round.start_ts <= now) throw new GameError('Entries for that round have closed. Pick again for the next round.', 409);
    if (round.status === 'settled') throw new GameError('The operator closed this round. Try again for the next one.', 409);
    if (this.paused().entries) throw new GameError('Entries are paused for a moment. Try again shortly.', 503);
    if (!verifySignature(n.message, signature, wallet)) throw new GameError('The wallet signature did not match. Sign again with the same wallet.', 401);
    const picks = JSON.parse(n.picks);
    const check = this.roster.check(picks, { squadSize: this.cfg.squadSize, budget: this.cfg.budget });
    if (!check.ok) throw new GameError(check.error);
    const tx = this.db.transaction(() => {
      if (this.q.useNonce.run(now, nonce).changes !== 1) throw new GameError('This signature was already used. Start again.');
      this.q.upsertEntry.run({ round_id: n.round_id, wallet, picks: n.picks, cost: check.cost, message: n.message, signature, now });
    });
    tx();
    return { ok: true, roundId: n.round_id, picks, cost: check.cost, startsAt: round.start_ts, endsAt: round.end_ts };
  }

  // ---------- scoring ----------
  /**
   * Score every picked trader for the round. Sources are tried in order and a round is
   * always scored entirely by one source, so every squad is judged on the same data.
   */
  async scoreRound(roundId, { final }) {
    const round = this.q.round.get(roundId);
    const entries = this.q.entriesFor.all(roundId);
    const traders = [...new Set(entries.flatMap((e) => JSON.parse(e.picks)))];
    if (!traders.length) return { traders: 0, source: null };
    const errors = [];
    for (const src of this.sources) {
      const results = [];
      try {
        for (const trader of traders) {
          const trades = await src.fetchTrades(trader);
          results.push([trader, realizedPnl(trades, round.start_ts, round.end_ts)]);
        }
      } catch (e) {
        this.health[src.name] = { ok: false, at: this.now(), error: e.message };
        errors.push(`${src.name}: ${e.message}`);
        continue;
      }
      this.health[src.name] = { ok: true, at: this.now(), error: null };
      const now = this.now();
      this.db.transaction(() => {
        for (const [trader, r] of results) this.q.upsertScore.run(roundId, trader, r.pnl, r.sells, r.wins, r.losses, r.unmatchedSells, final ? 1 : 0, now);
        if (final) this.q.setSource.run(src.name, roundId);
      })();
      if (src !== this.sources[0] && final) this.event('failover', `Round ${roundId} scored with ${src.name} because ${errors[0]}`);
      return { traders: traders.length, source: src.name };
    }
    throw new Error('Scoring incomplete. ' + errors.join(' | '));
  }

  rareFor(entriesParsed) { return rareSet(entriesParsed, this.cfg.rarePickPct); }
  scoreOpts(rare) { return { rare, rareBonus: this.cfg.rarePickBonus }; }

  traderPnlMap(roundId) { return new Map(this.q.scores.all(roundId).map((s) => [s.trader, s.pnl])); }

  async settleRound(roundId) {
    const round = this.q.round.get(roundId);
    if (!round || round.status === 'settled') return { skipped: true };
    const now = this.now();
    if (now < round.end_ts + this.cfg.settleDelaySeconds) return { skipped: true, reason: 'too early' };
    const entries = this.q.entriesFor.all(roundId);
    if (!entries.length) { this.q.settle.run(0, 0, now, 'No entries', roundId); return { settled: true, entries: 0 }; }

    try { await this.scoreRound(roundId, { final: true }); } catch (e) {
      if (now > round.end_ts + VOID_AFTER_SECONDS) {
        this.q.settle.run(0, 0, now, 'Voided: trade data unavailable. ' + e.message, roundId);
        return { settled: true, voided: true };
      }
      this.q.note.run('Waiting to score: ' + e.message, roundId);
      this.log(`round ${roundId}: ${e.message}`);
      return { settled: false, error: e.message };
    }

    const pnl = this.traderPnlMap(roundId);
    const { potLamports } = await this.projectedPot();
    const parsed = entries.map((e) => ({ ...e, picks: JSON.parse(e.picks), createdAt: e.created_at }));
    const rare = this.rareFor(parsed);
    this.q.setRare.run(JSON.stringify([...rare]), roundId);
    const ranked = rankAndPay(parsed, pnl, 0, this.scoreOpts(rare));

    // Winners = everyone tied for the best positive score who still passes the holder gate.
    let winners = [];
    for (const s of ranked) {
      if (s.score <= 0) break;
      if (winners.length && s.score !== winners[0].score) break;
      try { await this.assertHolder(s.entry.wallet); winners.push(s); } catch (e) {
        if (e.status === 503) throw e;
        this.log(`round ${roundId}: ${s.entry.wallet} skipped, no longer holds`);
        if (!winners.length) continue; // next best squad steps up
      }
    }
    const each = winners.length && potLamports > 0 ? Math.floor(potLamports / winners.length) : 0;
    const winSet = new Set(winners.map((w) => w.entry.id));
    const status = this.cfg.payoutMode === 'live' ? 'pending' : 'dry-run';

    this.db.transaction(() => {
      for (const s of ranked) this.q.insResult.run(roundId, s.entry.id, s.entry.wallet, s.score, s.rank, winSet.has(s.entry.id) ? each : 0);
      if (each > 0) for (const w of winners) this.q.insPayout.run(roundId, w.entry.wallet, each, status, now, now);
      const note = each > 0 ? null : winners.length ? 'Pot was empty' : 'No squad finished in profit, pot rolls over';
      this.q.settle.run(each * winners.length, winners.length, now, note, roundId);
    })();
    return { settled: true, entries: entries.length, winners: winners.map((w) => w.entry.wallet), eachLamports: each };
  }

  // ---------- payouts ----------
  async processPayouts() {
    if (this.cfg.payoutMode !== 'live' || this.busy.payouts || this.paused().payouts) return;
    this.busy.payouts = true;
    try {
      const now = this.now();
      for (const p of this.q.payoutsByStatus.all('sending')) {
        const st = await this.chain.status(p.tx_sig);
        if (st === 'confirmed') this.q.updPayout.run({ ...pick(p), status: 'sent', error: null, now });
        else if (st === 'failed') this.q.updPayout.run({ ...pick(p), status: p.attempts >= 5 ? 'failed' : 'pending', error: 'Transaction failed on chain', now });
        else if (st === null && (await this.chain.blockHeight()) > p.last_valid_height) {
          this.q.updPayout.run({ ...pick(p), status: p.attempts >= 5 ? 'failed' : 'pending', error: 'Expired before landing, will resend', now });
        }
      }
      for (const p of this.q.payoutsByStatus.all('pending')) {
        const signed = await this.chain.signTransfer(p.wallet, p.lamports);
        // Record the signature BEFORE sending, so a crash can never cause a double payment.
        this.q.updPayout.run({ id: p.id, status: 'sending', tx_sig: signed.sig, lvh: signed.lastValidBlockHeight, attempts: p.attempts + 1, error: null, now });
        try {
          await this.chain.send(signed.raw);
          const st = await this.chain.status(signed.sig);
          if (st === 'confirmed') this.q.updPayout.run({ id: p.id, status: 'sent', tx_sig: signed.sig, lvh: signed.lastValidBlockHeight, attempts: p.attempts + 1, error: null, now });
        } catch (e) {
          this.q.updPayout.run({ id: p.id, status: 'sending', tx_sig: signed.sig, lvh: signed.lastValidBlockHeight, attempts: p.attempts + 1, error: e.message, now });
          this.log(`payout ${p.id}: ${e.message}`);
        }
      }
    } finally { this.busy.payouts = false; }
  }

  // ---------- scheduler ----------
  async tick() {
    const now = this.now();
    const live = this.liveRoundId();
    this.ensureRound(live); this.ensureRound(live + 1);
    this.q.setStatus.run('live', live);
    if (!this.busy.settle) {
      this.busy.settle = true;
      try {
        for (const r of this.q.unsettled.all(this.cfg.settleDelaySeconds, now)) await this.settleRound(r.id);
      } finally { this.busy.settle = false; }
    }
    await this.processPayouts();
    this.maybeRefreshRoster(now);
    if (!this.busy.live && now - this.lastLiveAt >= this.cfg.liveRefreshSeconds && this.q.entryCount.get(live).n) {
      this.busy.live = true; this.lastLiveAt = now;
      this.scoreRound(live, { final: false }).catch((e) => this.log('live score: ' + e.message)).finally(() => { this.busy.live = false; });
    }
  }

  // ---------- daily roster + cost refresh ----------
  maybeRefreshRoster(now = this.now()) {
    if (!this.rosterRefresher || this.busy.roster || !(this.cfg.rosterRefreshHours > 0)) return null;
    const failed = this.health.roster.ok === false;
    const last = failed ? this.health.roster.at : Math.max(this.roster.updatedAt || 0, this.health.roster.at || 0);
    const wait = failed ? Math.min(3600, this.cfg.rosterRefreshHours * 3600) : this.cfg.rosterRefreshHours * 3600; // after a failure, retry hourly
    if (now - last < wait) return null;
    return this.refreshRosterNow().catch(() => {});
  }
  async refreshRosterNow() {
    if (!this.rosterRefresher) throw new GameError('Roster refresh is not configured.', 400);
    if (this.busy.roster) throw new GameError('A refresh is already running.', 409);
    this.busy.roster = true;
    try {
      const list = await this.rosterRefresher({ previous: this.roster.list });
      const before = new Map(this.roster.list.map((t) => [t.wallet, t.price]));
      const changed = list.filter((t) => before.get(t.wallet) !== t.price).length;
      const added = list.filter((t) => !before.has(t.wallet)).length;
      this.roster.replace(list, { updatedAt: this.now(), source: 'kolscan' });
      this.roster.save(this.db);
      this.health.roster = { ok: true, at: this.now(), error: null };
      this.event('roster', `Roster refreshed: ${list.length} traders, ${added} new, ${changed} cost changes`);
      return { traders: list.length, added, changed };
    } catch (e) {
      this.health.roster = { ok: false, at: this.now(), error: e.message };
      this.event('roster-error', 'Roster refresh failed, kept the current costs: ' + e.message);
      throw e;
    } finally { this.busy.roster = false; }
  }

  // ---------- admin ----------
  async adminOverview() {
    const pot = await this.projectedPot().catch((e) => ({ treasuryLamports: null, potLamports: null, error: e.message }));
    return {
      now: this.now(), payoutMode: this.cfg.payoutMode, paused: this.paused(),
      treasury: this.chain.treasuryPubkey ? this.chain.treasuryPubkey.toBase58() : null, pot,
      owedLamports: this.q.owed.get().l,
      rounds: this.q.roundsAdmin.all(30),
      payouts: this.q.payoutsAdmin.all(30),
      health: this.health,
      sources: this.sources.map((s) => s.name),
      roster: { traders: this.roster.list.length, updatedAt: this.roster.updatedAt, refreshHours: this.cfg.rosterRefreshHours },
      settings: { potShare: this.cfg.potShare, reserveSol: this.cfg.reserveSol, maxPayoutSol: this.cfg.maxPayoutSol, rarePickPct: this.cfg.rarePickPct, rarePickBonus: this.cfg.rarePickBonus, tokenMint: this.cfg.tokenMint || null, minTokenHold: this.cfg.minTokenHold },
      events: this.q.events.all(40),
    };
  }
  setPaused({ entries, payouts }) {
    const cur = this.paused();
    const next = { entries: entries ?? cur.entries, payouts: payouts ?? cur.payouts };
    this.setSetting('paused', next);
    this.event('pause', `Entries ${next.entries ? 'paused' : 'open'}, payouts ${next.payouts ? 'paused' : 'running'}`);
    return next;
  }
  voidRound(roundId, reason = 'Voided by admin') {
    const round = this.q.round.get(roundId);
    if (!round) throw new GameError('Round not found.', 404);
    if (this.q.paidCount.get(roundId).n) throw new GameError('This round already sent a payout on chain, so it cannot be voided.', 409);
    this.db.transaction(() => {
      this.q.delPayouts.run(roundId);
      this.q.zeroResults.run(roundId);
      this.q.forceSettle.run(this.now(), 'Voided: ' + reason, roundId);
    })();
    this.event('void', `Round ${roundId} voided: ${reason}`);
    return this.q.round.get(roundId);
  }
  retryPayout(id) {
    const p = this.q.payout.get(id);
    if (!p) throw new GameError('Payout not found.', 404);
    if (p.status !== 'failed') throw new GameError('Only failed payouts can be retried.', 409);
    this.q.updPayout.run({ id, status: 'pending', tx_sig: null, lvh: null, attempts: 0, error: null, now: this.now() });
    this.event('retry', `Payout ${id} to ${p.wallet} queued again`);
    return this.q.payout.get(id);
  }

  ownership(roundId) {
    const parsed = this.q.entriesFor.all(roundId).map((e) => ({ picks: JSON.parse(e.picks) }));
    const o = ownership(parsed);
    return { roundId, total: o.total, pct: Object.fromEntries([...o.pct].map(([w, p]) => [w, Math.round(p * 10) / 10])), rarePct: this.cfg.rarePickPct, rareBonus: this.cfg.rarePickBonus };
  }

  // ---------- read models ----------
  leaderboard(roundId, limit = 50) {
    const round = this.q.round.get(roundId);
    if (!round) return { round: null, rows: [] };
    if (round.status === 'settled') {
      const rows = this.q.results.all(roundId).slice(0, limit).map((r) => ({ wallet: r.wallet, picks: JSON.parse(r.picks), score: r.score, rank: r.rank, payoutLamports: r.payout_lamports }));
      return { round, final: true, rows, payouts: this.q.payoutsFor.all(roundId).map(publicPayout), rare: round.rare ? JSON.parse(round.rare) : [] };
    }
    const pnl = this.traderPnlMap(roundId);
    const parsed = this.q.entriesFor.all(roundId).map((e) => ({ wallet: e.wallet, picks: JSON.parse(e.picks) }));
    const rare = this.rareFor(parsed);
    const rows = parsed.map((e) => ({ wallet: e.wallet, picks: e.picks, score: squadScore(e.picks, pnl, this.scoreOpts(rare)) }))
      .sort((a, b) => b.score - a.score).slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
    return { round, final: false, rows, traderPnl: Object.fromEntries(pnl), rare: [...rare] };
  }

  async state() {
    const now = this.now();
    const live = this.ensureRound(this.liveRoundId());
    const open = this.ensureRound(live.id + 1);
    const pot = await this.projectedPot().catch(() => ({ treasuryLamports: null, potLamports: null }));
    const last = this.q.recent.all(1)[0] || null;
    return {
      now, roundSeconds: this.cfg.roundSeconds, budget: this.cfg.budget, payoutMode: this.cfg.payoutMode,
      potShare: this.cfg.potShare, treasury: this.chain.treasuryPubkey ? this.chain.treasuryPubkey.toBase58() : null,
      network: this.cfg.network,
      live: { id: live.id, start: live.start_ts, end: live.end_ts, entries: this.q.entryCount.get(live.id).n },
      open: { id: open.id, start: open.start_ts, end: open.end_ts, closesAt: open.start_ts, entries: this.q.entryCount.get(open.id).n },
      pot, lastSettled: last && { id: last.id, potLamports: last.pot_lamports, winners: last.winners, note: last.note },
      tokenGate: this.cfg.tokenMint && this.cfg.minTokenHold > 0 ? { mint: this.cfg.tokenMint, min: this.cfg.minTokenHold } : null,
      paused: this.paused(), rarePickPct: this.cfg.rarePickPct, rarePickBonus: this.cfg.rarePickBonus,
      rosterUpdatedAt: this.roster.updatedAt,
    };
  }

  playerView(wallet) {
    if (!isPubkey(wallet)) throw new GameError('That is not a valid Solana wallet address.');
    const live = this.liveRoundId();
    const parse = (e) => !e ? null : { roundId: e.round_id, picks: JSON.parse(e.picks), cost: e.cost, updatedAt: e.updated_at };
    return {
      open: parse(this.q.entryOf.get(live + 1, wallet)),
      live: parse(this.q.entryOf.get(live, wallet)),
      history: this.q.history.all(wallet).map((h) => ({ roundId: h.round_id, picks: JSON.parse(h.picks), cost: h.cost, score: h.score, rank: h.rank, payoutLamports: h.payout_lamports || 0, payoutStatus: h.payout_status, txSig: h.tx_sig })),
    };
  }
}

const pick = (p) => ({ id: p.id, tx_sig: p.tx_sig, lvh: p.last_valid_height, attempts: p.attempts });
const publicPayout = (p) => ({ wallet: p.wallet, lamports: p.lamports, status: p.status, txSig: p.tx_sig });

module.exports = { Game, GameError, LAMPORTS };
