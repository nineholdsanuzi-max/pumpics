'use strict';
const express = require('express');
const path = require('path');
const { GameError } = require('./game');

/** Minimal fixed-window rate limiter keyed by client IP. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const k = req.ip + req.path;
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > max) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
    next();
  };
}

function createApp({ game, roster, cfg }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });

  const api = express.Router();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    const status = e instanceof GameError ? e.status : 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: status === 500 ? 'Something went wrong on our side.' : e.message });
  });

  api.get('/health', (req, res) => res.json({ ok: true, time: game.now() }));
  api.get('/traders', (req, res) => { res.set('Cache-Control', 'public, max-age=120'); res.json({ traders: game.roster.list, updatedAt: game.roster.updatedAt }); });
  api.get('/ownership/:round', wrap(async (req, res) => {
    const id = req.params.round === 'open' ? game.openRoundId() : req.params.round === 'live' ? game.liveRoundId() : Number(req.params.round);
    if (!Number.isInteger(id)) throw new GameError('Unknown round.');
    res.json(game.ownership(id));
  }));
  api.get('/state', wrap(async (req, res) => res.json(await game.state())));
  api.post('/entry/challenge', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
    const { wallet, picks } = req.body || {};
    res.json(await game.challenge(wallet, picks));
  }));
  api.post('/entry', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
    const { wallet, nonce, signature } = req.body || {};
    res.json(await game.submitEntry({ wallet, nonce, signature }));
  }));
  api.get('/player/:wallet', wrap(async (req, res) => res.json(game.playerView(req.params.wallet))));
  api.get('/leaderboard/:round', wrap(async (req, res) => {
    const id = req.params.round === 'live' ? game.liveRoundId() : req.params.round === 'last' ? (game.q.recent.all(1)[0] || {}).id : Number(req.params.round);
    if (!Number.isInteger(id)) return res.json({ round: null, rows: [] });
    res.json(game.leaderboard(id));
  }));
  api.get('/rounds', wrap(async (req, res) => res.json({ rounds: game.q.recent.all(24) })));

  // ---------- admin (Authorization: Bearer ADMIN_TOKEN) ----------
  const admin = express.Router();
  const adminLimiter = rateLimit({ windowMs: 60000, max: 60 });
  admin.use(adminLimiter, (req, res, next) => {
    const ok = cfg.adminToken && cfg.adminToken.length >= 12 && req.get('authorization') === `Bearer ${cfg.adminToken}`;
    if (!ok) return res.status(403).json({ error: cfg.adminToken && cfg.adminToken.length >= 12 ? 'Wrong admin token.' : 'Set ADMIN_TOKEN (12+ characters) on the server to use the admin panel.' });
    next();
  });
  admin.get('/overview', wrap(async (req, res) => res.json(await game.adminOverview())));
  admin.post('/pause', wrap(async (req, res) => {
    const { entries, payouts } = req.body || {};
    res.json(game.setPaused({ entries: typeof entries === 'boolean' ? entries : undefined, payouts: typeof payouts === 'boolean' ? payouts : undefined }));
  }));
  admin.post('/rounds/:id/void', wrap(async (req, res) => res.json(game.voidRound(Number(req.params.id), String((req.body && req.body.reason) || 'Voided by admin').slice(0, 200)))));
  admin.post('/payouts/:id/retry', wrap(async (req, res) => res.json(game.retryPayout(Number(req.params.id)))));
  admin.post('/roster/refresh', wrap(async (req, res) => {
    try { res.json(await game.refreshRosterNow()); } catch (e) { if (e instanceof GameError) throw e; throw new GameError('Refresh failed: ' + e.message, 502); }
  }));
  admin.post('/tick', wrap(async (req, res) => { await game.tick(); res.json({ ok: true }); }));
  api.use('/admin', admin);

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '5m' }));
  return app;
}

module.exports = { createApp };
