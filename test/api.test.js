'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { makeGame, player, cheapSquad, roundTrip, balance } = require('./helpers');

async function serve(env = {}) {
  const ctx = makeGame({ env: { ADMIN_TOKEN: 'secret-admin-token', ...env } });
  const app = createApp({ game: ctx.game, roster: ctx.roster, cfg: ctx.cfg });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { ...ctx, base, call, close: () => server.close() };
}

test('API: health, state, traders and the site itself', async (t) => {
  const s = await serve(); t.after(s.close);
  assert.equal((await s.call('GET', '/api/health')).json.ok, true);
  const st = (await s.call('GET', '/api/state')).json;
  assert.equal(st.open.id, st.live.id + 1);
  assert.equal(st.roundSeconds, 3600);
  assert.ok(st.pot.potLamports > 0);
  const tr = (await s.call('GET', '/api/traders')).json.traders;
  assert.equal(tr.length, 514);
  const page = await s.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /PUMPICS/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('API: full entry flow over HTTP with a real signature', async (t) => {
  const s = await serve(); t.after(s.close);
  const p = player();
  const picks = cheapSquad(s.roster);
  const ch = await s.call('POST', '/api/entry/challenge', { wallet: p.wallet, picks });
  assert.equal(ch.status, 200);
  assert.match(ch.json.message, new RegExp(p.wallet));
  const ok = await s.call('POST', '/api/entry', { wallet: p.wallet, nonce: ch.json.nonce, signature: p.sign(ch.json.message) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.picks, picks);
  const me = (await s.call('GET', `/api/player/${p.wallet}`)).json;
  assert.deepEqual(me.open.picks, picks);
  const lb = (await s.call('GET', `/api/leaderboard/${ok.json.roundId}`)).json;
  assert.equal(lb.rows[0].wallet, p.wallet);
});

test('API: helpful errors with the right status codes', async (t) => {
  const s = await serve(); t.after(s.close);
  const p = player();
  let r = await s.call('POST', '/api/entry/challenge', { wallet: p.wallet, picks: ['x'] });
  assert.equal(r.status, 400); assert.match(r.json.error, /exactly 5/);
  r = await s.call('POST', '/api/entry/challenge', { wallet: 'bad', picks: cheapSquad(s.roster) });
  assert.equal(r.status, 400);
  const ch = (await s.call('POST', '/api/entry/challenge', { wallet: p.wallet, picks: cheapSquad(s.roster) })).json;
  r = await s.call('POST', '/api/entry', { wallet: p.wallet, nonce: ch.nonce, signature: player().sign(ch.message) });
  assert.equal(r.status, 401);
  r = await s.call('GET', '/api/player/nope'); assert.equal(r.status, 400);
  r = await s.call('GET', '/api/nothing'); assert.equal(r.status, 404);
  r = await fetch(s.base + '/api/entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal(r.status, 400);
});

test('API: admin tick needs the token and settles + pays the round', async (t) => {
  const s = await serve(); t.after(s.close);
  assert.equal((await s.call('POST', '/api/admin/tick')).status, 403);
  assert.equal((await s.call('POST', '/api/admin/tick', null, { Authorization: 'Bearer wrong' })).status, 403);
  await s.game.tick();
  const p = player(); const picks = cheapSquad(s.roster);
  const ch = (await s.call('POST', '/api/entry/challenge', { wallet: p.wallet, picks })).json;
  await s.call('POST', '/api/entry', { wallet: p.wallet, nonce: ch.nonce, signature: p.sign(ch.message) });
  const start = ch.roundId * s.R;
  s.source.byWallet[picks[0]] = roundTrip('T', start + 99, 1, 2);
  s.clock.set(start + s.R + s.cfg.settleDelaySeconds + 1);
  assert.equal((await s.call('POST', '/api/admin/tick', null, { Authorization: 'Bearer secret-admin-token' })).status, 200);
  const lb = (await s.call('GET', '/api/leaderboard/last')).json;
  assert.equal(lb.final, true);
  assert.equal(lb.payouts[0].status, 'sent');
  assert.equal(balance(s.svm, p.wallet), lb.payouts[0].lamports);
});

test('API: signing endpoints are rate limited per IP', async (t) => {
  const s = await serve(); t.after(s.close);
  let last;
  for (let i = 0; i < 32; i++) last = await s.call('POST', '/api/entry/challenge', { wallet: 'bad', picks: [] });
  assert.equal(last.status, 429);
});

test('API: admin panel endpoints need a strong token and work end to end', async (t) => {
  const s = await serve(); t.after(s.close);
  const H = { Authorization: 'Bearer secret-admin-token' };
  assert.equal((await s.call('GET', '/api/admin/overview')).status, 403);
  assert.equal((await s.call('GET', '/api/admin/overview', null, { Authorization: 'Bearer nope' })).status, 403);
  const o = await s.call('GET', '/api/admin/overview', null, H);
  assert.equal(o.status, 200); assert.equal(o.json.payoutMode, 'live');
  const pz = await s.call('POST', '/api/admin/pause', { entries: true }, H);
  assert.deepEqual(pz.json, { entries: true, payouts: false });
  const p = player();
  const ch = await s.call('POST', '/api/entry/challenge', { wallet: p.wallet, picks: cheapSquad(s.roster) });
  assert.equal(ch.status, 503); assert.match(ch.json.error, /paused/);
  assert.equal((await s.call('GET', '/api/state')).json.paused.entries, true);
  await s.call('POST', '/api/admin/pause', { entries: false }, H);
  assert.equal((await s.call('POST', '/api/admin/roster/refresh', {}, H)).status, 400, 'no refresher configured in tests');
  assert.equal((await s.call('POST', '/api/admin/rounds/123/void', {}, H)).status, 404);
  assert.equal((await s.call('POST', '/api/admin/payouts/9/retry', {}, H)).status, 404);
  const page = await s.call('GET', '/admin');
  assert.equal(page.status, 200); assert.match(page.text, /Operator sign-in/);
});

test('API: a short ADMIN_TOKEN is refused with a clear message', async (t) => {
  const s = await serve({ ADMIN_TOKEN: 'short' }); t.after(s.close);
  const r = await s.call('GET', '/api/admin/overview', null, { Authorization: 'Bearer short' });
  assert.equal(r.status, 403); assert.match(r.json.error, /12\+ characters/);
});

test('API: ownership shows the share of squads picking each trader', async (t) => {
  const s = await serve(); t.after(s.close);
  const p = player(); const picks = cheapSquad(s.roster);
  const ch = (await s.call('POST', '/api/entry/challenge', { wallet: p.wallet, picks })).json;
  await s.call('POST', '/api/entry', { wallet: p.wallet, nonce: ch.nonce, signature: p.sign(ch.message) });
  const o = (await s.call('GET', '/api/ownership/open')).json;
  assert.equal(o.total, 1); assert.equal(o.pct[picks[0]], 100); assert.equal(o.rareBonus, 1.5);
  assert.equal((await s.call('GET', '/api/ownership/nope')).status, 400);
});
