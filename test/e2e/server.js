'use strict';
/**
 * Test server: the real app, but with an in-process Solana runtime (LiteSVM),
 * fixture trade data and a controllable clock. Never use in production.
 */
const { makeGame, roundTrip, balance } = require('../helpers');
const { createApp } = require('../../src/app');

function startTestServer(port = 0) {
  const ctx = makeGame({ env: { ADMIN_TOKEN: 'e2e-admin-token-123' }, treasurySol: 50 });
  const app = createApp({ game: ctx.game, roster: ctx.roster, cfg: ctx.cfg });
  const express = require('express');
  const t = express.Router();
  t.use(express.json());
  t.post('/clock', (req, res) => { if (req.body.set) ctx.clock.set(req.body.set); if (req.body.add) ctx.clock.add(req.body.add); res.json({ now: ctx.clock() }); });
  t.post('/trades', (req, res) => { const { wallet, start, cost, proceeds } = req.body; ctx.source.byWallet[wallet] = roundTrip('T' + wallet.slice(0, 4), start, cost, proceeds); res.json({ ok: true }); });
  t.post('/tick', async (req, res) => { await ctx.game.tick(); res.json({ ok: true }); });
  t.get('/balance/:w', (req, res) => res.json({ lamports: balance(ctx.svm, req.params.w) }));
  // mount test routes before the app's /api 404 handler
  const outer = express();
  outer.use('/__test', t);
  outer.use(app);
  return new Promise((resolve) => {
    const server = outer.listen(port, () => resolve({ server, ctx, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = { startTestServer };
if (require.main === module) startTestServer(Number(process.env.PORT) || 3100).then(({ url }) => console.log('e2e server', url));
