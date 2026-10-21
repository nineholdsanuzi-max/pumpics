'use strict';
// Pre-launch check: can THIS server reach Kolscan and score the last hour?
// Run on your host: npm run check:kolscan
require('../src/env').loadDotEnv();
const { KolscanSource } = require('../src/kolscan');
const { realizedPnl } = require('../src/scoring');
const { Roster } = require('../src/roster');

(async () => {
  const roster = Roster.load();
  const wallets = roster.list.filter((t) => t.rank30d && t.rank30d <= 5).map((t) => t);
  const src = new KolscanSource({ base: process.env.KOLSCAN_BASE || 'https://kolscan.io', log: console.log });
  const end = Math.floor(Date.now() / 3600000) * 3600, start = end - 3600;
  console.log(`Scoring ${new Date(start * 1000).toISOString()} → ${new Date(end * 1000).toISOString()}`);
  let failed = 0;
  for (const t of wallets) {
    try {
      const trades = await src.fetchTrades(t.wallet);
      const r = realizedPnl(trades, start, end);
      console.log(`  ✓ ${t.name.padEnd(16)} ${String(trades.length).padStart(5)} trades in 24h   last hour ${r.pnl.toFixed(3)} SOL (${r.sells} sells)`);
    } catch (e) { failed++; console.log(`  ✗ ${t.name.padEnd(16)} ${e.message}`); }
  }
  if (failed) { console.log('\nKolscan is not reachable from this server. See README → "If Kolscan blocks your server".'); process.exit(1); }
  console.log('\nKolscan scoring works from this server.');
})();
