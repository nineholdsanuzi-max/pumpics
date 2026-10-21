'use strict';
require('./src/env').loadDotEnv();
const { loadConfig } = require('./src/config');
const { openDb } = require('./src/db');
const { Roster } = require('./src/roster');
const { KolscanSource } = require('./src/kolscan');
const { HeliusSource } = require('./src/helius');
const { refreshRoster } = require('./src/roster-refresh');
const { RpcChain, parseSecret } = require('./src/chain');
const { Game } = require('./src/game');
const { createApp } = require('./src/app');

const cfg = loadConfig();
const log = (m) => console.log(new Date().toISOString(), m);
const db = openDb(cfg.dbPath);
const sources = [new KolscanSource({ base: cfg.kolscanBase, minGapMs: cfg.kolscanMinGapMs, log })];
if (cfg.heliusApiKey) sources.push(new HeliusSource({ apiKey: cfg.heliusApiKey, log }));
const game = new Game({
  db,
  cfg,
  roster: Roster.fromDb(db),
  sources,
  rosterRefresher: ({ previous }) => refreshRoster({ previous, base: cfg.kolscanBase }),
  chain: new RpcChain({ rpcUrl: cfg.rpcUrl, treasury: parseSecret(cfg.treasurySecret), treasuryAddress: cfg.treasuryAddress }),
  log,
});

const app = createApp({ game, roster: game.roster, cfg });
const server = app.listen(cfg.port, () => log(`PUMPICS on :${cfg.port} · payouts ${cfg.payoutMode} · scoring via ${sources.map((s) => s.name).join(' → ')} · ${game.roster.list.length} traders`));

const loop = () => game.tick().catch((e) => log('tick: ' + e.message));
loop();
const timer = setInterval(loop, 15000);

// Clean shutdown on redeploys: stop scheduling, finish in-flight requests, close the database.
function shutdown(sig) {
  log(`${sig} received, shutting down`);
  clearInterval(timer);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
