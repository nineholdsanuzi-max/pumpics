'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { realizedPnl, squadScore, rankAndPay } = require('../src/scoring');
const fx = require('./fixtures/kolscan_live_sample.json');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const B = (ts, token, amount, sol) => ({ ts, side: 'buy', token, amount, sol });
const S = (ts, token, amount, sol) => ({ ts, side: 'sell', token, amount, sol });

test('buy then sell inside the window realizes the difference', () => {
  const r = realizedPnl([B(100, 'A', 1000, 2), S(200, 'A', 1000, 5)], 0, 1000);
  close(r.pnl, 3); assert.equal(r.sells, 1); assert.equal(r.wins, 1);
});

test('partial sells use average cost', () => {
  const t = [B(10, 'A', 100, 1), B(20, 'A', 100, 3), S(30, 'A', 50, 2), S(40, 'A', 150, 3)];
  // avg cost 0.02/unit. sell 50 -> basis 1, pnl +1. sell 150 -> basis 3, pnl 0
  const r = realizedPnl(t, 0, 100);
  close(r.pnl, 1); assert.equal(r.wins, 1); assert.equal(r.losses, 0);
});

test('buys before the window are cost basis, only sells inside the window score', () => {
  const t = [B(10, 'A', 100, 1), S(20, 'A', 50, 2), S(150, 'A', 50, 0.2)];
  const r = realizedPnl(t, 100, 200);
  close(r.pnl, 0.2 - 0.5); assert.equal(r.sells, 1); assert.equal(r.losses, 1);
});

test('open positions and trades after the window do not score', () => {
  const r = realizedPnl([B(150, 'A', 100, 5), S(250, 'A', 100, 50)], 100, 200);
  close(r.pnl, 0); assert.equal(r.sells, 0);
});

test('selling a token with no visible buy scores zero and is flagged', () => {
  const r = realizedPnl([S(150, 'X', 100, 9)], 100, 200);
  close(r.pnl, 0); assert.equal(r.unmatchedSells, 1);
});

test('selling more than was bought only credits the matched part', () => {
  const r = realizedPnl([B(110, 'A', 100, 1), S(150, 'A', 200, 4)], 100, 200);
  close(r.pnl, 1); // half the proceeds (2) minus full basis (1)
});

test('#1 spot counts double', () => {
  const pnl = new Map([['a', 10], ['b', -2], ['c', 1], ['d', 0], ['e', 3]]);
  close(squadScore(['a', 'b', 'c', 'd', 'e'], pnl), 22);
  close(squadScore(['b', 'a', 'c', 'd', 'e'], pnl), 10);
});

test('ties for first split the pot; nobody is paid for a loss', () => {
  const pnl = new Map([['a', 5], ['b', 5], ['c', -1]]);
  const entries = [
    { id: 1, picks: ['a', 'c', 'x', 'y', 'z'], createdAt: 1 },
    { id: 2, picks: ['b', 'c', 'x', 'y', 'z'], createdAt: 2 },
    { id: 3, picks: ['c', 'x', 'y', 'z', 'w'], createdAt: 3 },
  ];
  const r = rankAndPay(entries, pnl, 1001);
  assert.deepEqual(r.map((x) => [x.entry.id, x.rank, x.payoutLamports]), [[1, 1, 500], [2, 1, 500], [3, 3, 0]]);
  const losers = rankAndPay([{ id: 9, picks: ['c'], createdAt: 1 }], pnl, 1000);
  assert.equal(losers[0].payoutLamports, 0);
});

// ---- Real Kolscan data captured from kolscan.io on Oct 12 2026 ----
const tradesOf = (w) => w.tx.map((r) => ({ ts: r[0], side: r[1] === 'B' ? 'buy' : 'sell', token: fx.tokens[r[2]], amount: r[3], sol: r[4] }));

test('real data: 24 hourly windows add up to the full-day score for every wallet', () => {
  const end = Math.floor(fx.fetched_at / 3600) * 3600;
  for (const w of fx.wallets) {
    const t = tradesOf(w);
    const day = realizedPnl(t, end - 24 * 3600, end).pnl;
    let sum = 0;
    for (let h = 24; h >= 1; h--) sum += realizedPnl(t, end - h * 3600, end - (h - 1) * 3600).pnl;
    close(sum, day, 1e-5);
  }
});

test('real data: a clean round trip matches the on-chain amounts exactly', () => {
  const w = fx.wallets.find((x) => x.name === 'decu');
  const token = fx.tokens.find((t) => t.startsWith('GMAUA5'));
  const r = realizedPnl(tradesOf(w).filter((t) => t.token === token), 0, 2e9);
  close(r.pnl, 5.445763 - 2.933333, 1e-6);
});

test('real data: scoring 500+ trades takes well under 50ms', () => {
  const t = tradesOf(fx.wallets.find((x) => x.name === 'slingoor'));
  const s = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) realizedPnl(t, fx.fetched_at - 3600, fx.fetched_at);
  assert.ok(Number(process.hrtime.bigint() - s) / 1e6 / 10 < 50);
});
