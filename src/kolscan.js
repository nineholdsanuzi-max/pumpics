'use strict';
/**
 * Trade history source backed by Kolscan's data API (the same endpoint
 * kolscan.io's own wallet pages call). Requests are queued one at a time with
 * a minimum gap, and HTTP 429 responses are retried after `Retry-After`.
 *
 * fetchTrades(wallet) resolves to trades from roughly the last 24 hours:
 *   [{ ts, side: 'buy'|'sell', token, amount, sol, sig }]
 * It throws if the data could not be fetched completely, so a round is never
 * scored on partial data.
 */
class KolscanSource {
  constructor({ base = 'https://kolscan.io', minGapMs = 1200, fetchImpl = globalThis.fetch, maxPages = 20, timeoutMs = 15000, log = () => {} } = {}) {
    Object.assign(this, { base, minGapMs, maxPages, timeoutMs, log });
    // Call fetch unbound: invoking it as a method of this object throws "Illegal invocation" in some runtimes.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.name = 'kolscan';
    this.queue = Promise.resolve();
    this.lastAt = 0;
  }

  _schedule(fn) {
    const run = this.queue.then(async () => {
      const wait = this.lastAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.lastAt = Date.now(); }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async _post(body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this._schedule(async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          return await this.fetchImpl(`${this.base}/api/data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: this.base, Referer: `${this.base}/leaderboard` },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } finally { clearTimeout(t); }
      });
      if (res.status === 429 || res.status >= 500) {
        const h = res.headers.get('retry-after');
        const ra = h !== null && h !== '' && !Number.isNaN(Number(h)) ? Number(h) : 10 * (attempt + 1);
        this.log(`kolscan ${res.status}, retrying in ${ra}s`);
        await sleep(Math.min(ra, 120) * 1000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`Kolscan returned HTTP ${res.status}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('Kolscan returned a non-JSON page (likely a bot check)'); }
      if (!json || !Array.isArray(json.data)) throw new Error('Kolscan response had no data array');
      return json.data;
    }
    throw new Error('Kolscan kept rate-limiting after 5 attempts');
  }

  async fetchTrades(wallet) {
    const limit = 500;
    const out = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const rows = await this._post({ method: 'fetchTransactions', params: { table: 'transactions', walletAddress: wallet, timeframe: 1, limit, page } });
      for (const r of rows) {
        const t = mapRow(r);
        if (t) out.push(t);
      }
      if (rows.length < limit) return out;
    }
    throw new Error(`More than ${this.maxPages * limit} trades in 24h for ${wallet}; refusing to score on a truncated history`);
  }
}

function mapRow(r) {
  if (!r || typeof r.timestamp !== 'number') return null;
  const buy = r.spl_direction === 'Buy';
  const sell = r.spl_direction === 'Sell';
  if (!buy && !sell) return null;
  return {
    ts: r.timestamp,
    side: buy ? 'buy' : 'sell',
    token: buy ? r.out_token_address : r.in_token_address,
    amount: Number(buy ? r.out_amount : r.in_amount),
    sol: Math.abs(Number(r.sol_change)),
    sig: r.signature,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { KolscanSource, mapRow };
