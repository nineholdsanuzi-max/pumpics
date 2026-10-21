'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KolscanSource, mapRow } = require('../src/kolscan');

const row = (i, dir = 'Buy') => ({ timestamp: 1000 + i, spl_direction: dir, out_token_address: dir === 'Buy' ? 'T' : '', out_amount: dir === 'Buy' ? 10 : 0, in_token_address: dir === 'Sell' ? 'T' : '', in_amount: dir === 'Sell' ? 10 : 0, sol_change: 1.5, signature: 's' + i });
const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('maps Kolscan buy and sell rows', () => {
  assert.deepEqual(mapRow(row(1)), { ts: 1001, side: 'buy', token: 'T', amount: 10, sol: 1.5, sig: 's1' });
  assert.equal(mapRow(row(2, 'Sell')).side, 'sell');
  assert.equal(mapRow({ timestamp: 1, spl_direction: 'Transfer' }), null);
});

test('pages through history, sends the right request, honours 429 Retry-After', async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    n++;
    if (n === 2) return resp(429, '<html>slow down</html>', { 'retry-after': '0' });
    const page = JSON.parse(opts.body).params.page;
    return resp(200, { data: page === 1 ? Array.from({ length: 500 }, (_, i) => row(i)) : [row(900, 'Sell')] });
  };
  const src = new KolscanSource({ fetchImpl, minGapMs: 0 });
  const trades = await src.fetchTrades('WALLET');
  assert.equal(trades.length, 501);
  assert.equal(calls[0].url, 'https://kolscan.io/api/data');
  assert.deepEqual(calls[0].body, { method: 'fetchTransactions', params: { table: 'transactions', walletAddress: 'WALLET', timeframe: 1, limit: 500, page: 1 } });
  assert.equal(calls.length, 3); // page1, 429, page2 retried
});

test('a bot-check HTML page fails loudly instead of scoring zero', async () => {
  const src = new KolscanSource({ fetchImpl: async () => resp(200, '<!doctype html><title>Just a moment</title>'), minGapMs: 0 });
  await assert.rejects(src.fetchTrades('W'), /non-JSON/);
});

test('HTTP 403 fails loudly', async () => {
  const src = new KolscanSource({ fetchImpl: async () => resp(403, 'forbidden'), minGapMs: 0 });
  await assert.rejects(src.fetchTrades('W'), /HTTP 403/);
});

test('refuses to score a truncated history', async () => {
  const src = new KolscanSource({ fetchImpl: async () => resp(200, { data: Array.from({ length: 500 }, (_, i) => row(i)) }), minGapMs: 0, maxPages: 2 });
  await assert.rejects(src.fetchTrades('W'), /truncated/);
});

test('requests are spaced by the minimum gap', async () => {
  const times = [];
  const src = new KolscanSource({ fetchImpl: async () => { times.push(Date.now()); return resp(200, { data: [] }); }, minGapMs: 80 });
  await Promise.all([src.fetchTrades('a'), src.fetchTrades('b'), src.fetchTrades('c')]);
  assert.ok(times[1] - times[0] >= 75 && times[2] - times[1] >= 75, JSON.stringify(times));
});

test('fetch is called unbound (browsers and some runtimes throw "Illegal invocation" otherwise)', async () => {
  const strictFetch = function (url) { 'use strict'; if (this !== undefined) throw new TypeError('Illegal invocation'); return Promise.resolve(resp(200, { data: [] })); };
  const src = new KolscanSource({ fetchImpl: strictFetch, minGapMs: 0 });
  assert.deepEqual(await src.fetchTrades('W'), []);
});
