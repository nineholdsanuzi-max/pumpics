'use strict';
/**
 * Backup trade source: Helius parsed transaction history, read straight from the chain.
 * https://docs.helius.dev — GET /v0/addresses/{address}/transactions
 *
 * Each transaction's balance changes for the wallet are turned into a swap:
 *   SOL out + one token in  -> buy
 *   token out + SOL in      -> sell
 * Wrapped SOL counts as SOL. Anything else (transfers, multi-token routes) is skipped.
 * The SOL amount includes network fees, so scores are a touch more conservative than Kolscan's.
 */
const WSOL = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

function txToTrade(tx, wallet) {
  if (!tx || tx.transactionError || typeof tx.timestamp !== 'number') return null;
  let sol = 0;
  const tokens = new Map();
  for (const acc of tx.accountData || []) {
    if (acc.account === wallet && typeof acc.nativeBalanceChange === 'number') sol += acc.nativeBalanceChange / LAMPORTS;
    for (const c of acc.tokenBalanceChanges || []) {
      if (c.userAccount !== wallet || !c.rawTokenAmount) continue;
      const amt = Number(c.rawTokenAmount.tokenAmount) / 10 ** Number(c.rawTokenAmount.decimals || 0);
      if (c.mint === WSOL) sol += amt;
      else tokens.set(c.mint, (tokens.get(c.mint) || 0) + amt);
    }
  }
  const moved = [...tokens].filter(([, a]) => Math.abs(a) > 0);
  if (moved.length !== 1) return null;
  const [token, delta] = moved[0];
  if (delta > 0 && sol < 0) return { ts: tx.timestamp, side: 'buy', token, amount: delta, sol: -sol, sig: tx.signature };
  if (delta < 0 && sol > 0) return { ts: tx.timestamp, side: 'sell', token, amount: -delta, sol, sig: tx.signature };
  return null;
}

class HeliusSource {
  constructor({ apiKey, base = 'https://api.helius.xyz', fetchImpl = globalThis.fetch, lookbackSeconds = 86400, maxPages = 60, now = () => Math.floor(Date.now() / 1000), minGapMs = 120, log = () => {} } = {}) {
    if (!apiKey) throw new Error('HeliusSource needs an API key');
    Object.assign(this, { apiKey, base, lookbackSeconds, maxPages, now, minGapMs, log });
    this.fetchImpl = (...a) => fetchImpl(...a);
    this.name = 'helius';
  }
  async _get(url) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (this.minGapMs) await new Promise((r) => setTimeout(r, this.minGapMs));
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, Math.min(2000 * (attempt + 1), 10000))); continue; }
      if (!res.ok) throw new Error(`Helius returned HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error('Helius response was not a list');
      return json;
    }
    throw new Error('Helius kept rate-limiting after 5 attempts');
  }
  async fetchTrades(wallet) {
    const since = this.now() - this.lookbackSeconds;
    const out = [];
    let before = null;
    for (let page = 0; page < this.maxPages; page++) {
      const url = `${this.base}/v0/addresses/${wallet}/transactions?api-key=${encodeURIComponent(this.apiKey)}&limit=100${before ? `&before=${before}` : ''}`;
      const txs = await this._get(url);
      if (!txs.length) return out;
      for (const tx of txs) {
        if (tx.timestamp < since) return out;
        const t = txToTrade(tx, wallet);
        if (t) out.push(t);
      }
      before = txs[txs.length - 1].signature;
    }
    throw new Error(`Helius history for ${wallet} is longer than ${this.maxPages * 100} transactions in 24h; refusing to score on a truncated history`);
  }
}

module.exports = { HeliusSource, txToTrade, WSOL };
