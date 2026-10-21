'use strict';
/**
 * Realized PnL scoring from a wallet's swap history.
 *
 * A trade is { ts, side: 'buy'|'sell', token, amount, sol } where `sol` is the
 * absolute SOL spent (buy) or received (sell).
 *
 * Cost basis is the running average cost per token unit. A sell realizes
 * (sol received - average cost of the units sold). Only sells whose timestamp
 * falls inside [start, end) count toward the score. Sells of tokens with no
 * buy in the visible history have an unknown cost basis and score 0 (they are
 * reported in `unmatchedSells` so nobody gets credit for tokens they were
 * airdropped or bought outside the lookback).
 */
function realizedPnl(trades, start, end) {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const book = new Map(); // token -> { qty, cost }
  let pnl = 0, sells = 0, wins = 0, losses = 0, unmatchedSells = 0, volume = 0;
  for (const t of sorted) {
    if (t.ts >= end) break;
    if (!t.token || !(t.amount > 0) || !(t.sol >= 0)) continue;
    let pos = book.get(t.token);
    if (!pos) { pos = { qty: 0, cost: 0 }; book.set(t.token, pos); }
    if (t.side === 'buy') {
      pos.qty += t.amount; pos.cost += t.sol;
      if (t.ts >= start) volume += t.sol;
      continue;
    }
    // sell
    const inWindow = t.ts >= start;
    if (inWindow) volume += t.sol;
    if (pos.qty <= 0) { if (inWindow) unmatchedSells++; continue; }
    const sold = Math.min(t.amount, pos.qty);
    const basis = pos.cost * (sold / pos.qty);
    // proceeds attributable to the units we have a basis for
    const proceeds = t.sol * (sold / t.amount);
    pos.qty -= sold; pos.cost -= basis;
    if (pos.qty < 1e-9) { pos.qty = 0; pos.cost = 0; }
    if (inWindow) {
      const r = proceeds - basis;
      pnl += r; sells++;
      if (r > 0) wins++; else if (r < 0) losses++;
    }
  }
  return { pnl: round9(pnl), sells, wins, losses, unmatchedSells, volume: round9(volume) };
}
const round9 = (x) => Math.round(x * 1e9) / 1e9;

/**
 * How many squads picked each trader, as a share of all squads in the round.
 * Returns { total, counts: Map(trader -> n), pct: Map(trader -> 0..100) }.
 */
function ownership(entries) {
  const counts = new Map();
  for (const e of entries) for (const w of new Set(e.picks)) counts.set(w, (counts.get(w) || 0) + 1);
  const total = entries.length;
  const pct = new Map([...counts].map(([w, n]) => [w, total ? (n / total) * 100 : 0]));
  return { total, counts, pct };
}

/** Traders picked by fewer than `rarePct`% of squads. A lone pick in a tiny round never qualifies. */
function rareSet(entries, rarePct) {
  const { pct } = ownership(entries);
  return new Set([...pct].filter(([, p]) => p < rarePct).map(([w]) => w));
}

/**
 * Squad score: sum of trader profit. The #1 spot counts double.
 * Rare picks earn a bonus on profit (never on losses), so contrarian squads can beat the crowd.
 */
function squadScore(picks, traderPnl, { rare = null, rareBonus = 1 } = {}) {
  return round9(picks.reduce((acc, wallet, i) => {
    let v = traderPnl.get(wallet) || 0;
    if (v > 0 && rare && rare.has(wallet)) v *= rareBonus;
    return acc + v * (i === 0 ? 2 : 1);
  }, 0));
}

/**
 * Rank entries and split the payout. Ties for first share the prize equally.
 * Returns [{ entry, score, rank, payoutLamports }].
 */
function rankAndPay(entries, traderPnl, potLamports, opts = {}) {
  const scored = entries.map((e) => ({ entry: e, score: squadScore(e.picks, traderPnl, opts) }));
  scored.sort((a, b) => b.score - a.score || a.entry.createdAt - b.entry.createdAt);
  let rank = 0, prev = null;
  scored.forEach((s, i) => { if (prev === null || s.score !== prev) { rank = i + 1; prev = s.score; } s.rank = rank; s.payoutLamports = 0; });
  const winners = scored.filter((s) => s.rank === 1 && s.score > 0);
  if (winners.length && potLamports > 0) {
    const each = Math.floor(potLamports / winners.length);
    winners.forEach((w) => { w.payoutLamports = each; });
  }
  return scored;
}

module.exports = { realizedPnl, squadScore, rankAndPay, ownership, rareSet };
