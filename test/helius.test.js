'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HeliusSource, txToTrade, WSOL } = require('../src/helius');
const { realizedPnl } = require('../src/scoring');

const W = 'Wa11et1111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const tx = (sig, ts, lamports, tokenRaw, { decimals = 6, mint = MINT, wsolRaw = 0, err = null, extraMint = null } = {}) => ({
  signature: sig, timestamp: ts, transactionError: err,
  accountData: [
    { account: W, nativeBalanceChange: lamports, tokenBalanceChanges: [] },
    { account: 'tokenacct', nativeBalanceChange: 0, tokenBalanceChanges: [
      ...(tokenRaw ? [{ userAccount: W, mint, rawTokenAmount: { tokenAmount: String(tokenRaw), decimals } }] : []),
      ...(wsolRaw ? [{ userAccount: W, mint: WSOL, rawTokenAmount: { tokenAmount: String(wsolRaw), decimals: 9 } }] : []),
      ...(extraMint ? [{ userAccount: W, mint: extraMint, rawTokenAmount: { tokenAmount: '5', decimals: 0 } }] : []),
      { userAccount: 'someoneElse', mint, rawTokenAmount: { tokenAmount: '-999999', decimals } },
    ] },
  ],
});

test('Helius: SOL out + token in is a buy, token out + SOL in is a sell', () => {
  assert.deepEqual(txToTrade(tx('a', 100, -1_010_000_000, 2_000_000), W), { ts: 100, side: 'buy', token: MINT, amount: 2, sol: 1.01, sig: 'a' });
  assert.deepEqual(txToTrade(tx('b', 200, 3_000_000_000, -2_000_000), W), { ts: 200, side: 'sell', token: MINT, amount: 2, sol: 3, sig: 'b' });
});

test('Helius: wrapped SOL counts as SOL', () => {
  assert.equal(txToTrade(tx('c', 1, -5000, 1_000_000, { wsolRaw: -500_000_000 }), W).sol, 0.500005);
});

test('Helius: transfers, failed transactions and multi-token routes are ignored', () => {
  assert.equal(txToTrade(tx('d', 1, 0, 1_000_000), W), null, 'token arrived but no SOL left: a transfer');
  assert.equal(txToTrade(tx('e', 1, -1e9, 1_000_000, { err: 'InstructionError' }), W), null);
  assert.equal(txToTrade(tx('f', 1, -1e9, 1_000_000, { extraMint: 'Other111111111111111111111111111111111111' }), W), null);
});

const resp = (status, body) => ({ status, ok: status < 300, json: async () => body });

test('Helius: pages back 24 hours with ?before= and the scores add up', async () => {
  const now = 100000;
  const page1 = [tx('s3', now - 100, 3e9, -2_000_000), tx('s2', now - 200, -1e9, 2_000_000)];
  const page2 = [tx('s1', now - 300, -5e8, 1_000_000), tx('old', now - 90000, -9e9, 1_000_000)];
  const urls = [];
  const src = new HeliusSource({ apiKey: 'k', now: () => now, minGapMs: 0, fetchImpl: async (u) => { urls.push(u); return resp(200, urls.length === 1 ? page1 : page2); } });
  const trades = await src.fetchTrades(W);
  assert.equal(trades.length, 3, 'stops at the 24h boundary');
  assert.match(urls[0], /\/v0\/addresses\/Wa11et1+\/transactions\?api-key=k&limit=100$/);
  assert.match(urls[1], /&before=s2$/);
  // bought 2 for 1 SOL, then sold 2 of the 3 held (avg cost 0.5) for 3 SOL => +2
  assert.equal(realizedPnl(trades, now - 3600, now).pnl, 2);
});

test('Helius: errors fail loudly, 429 is retried', async () => {
  const bad = new HeliusSource({ apiKey: 'k', minGapMs: 0, fetchImpl: async () => resp(401, { error: 'bad key' }) });
  await assert.rejects(bad.fetchTrades(W), /HTTP 401/);
  let n = 0;
  const flaky = new HeliusSource({ apiKey: 'k', minGapMs: 0, fetchImpl: async () => (++n === 1 ? resp(429, {}) : resp(200, [])) });
  assert.deepEqual(await flaky.fetchTrades(W), []);
  assert.throws(() => new HeliusSource({}), /API key/);
});
