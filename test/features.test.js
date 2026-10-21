'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FixtureSource, makeGame, player, enter, cheapSquad, roundTrip, balance, SOL } = require('./helpers');
const { parseLeaderboardPage, buildRoster, priceFor } = require('../src/roster-refresh');
const { Roster } = require('../src/roster');
const { openDb } = require('../src/db');
const { squadScore, rareSet } = require('../src/scoring');

const PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'kolscan_leaderboard_page.html'), 'utf8');

async function playRound(ctx, setup) {
  const { game, clock, R, cfg } = ctx;
  await game.tick();
  const roundId = game.openRoundId();
  const start = roundId * R;
  await setup({ roundId, start });
  clock.set(start + R + cfg.settleDelaySeconds + 1);
  await game.tick();
  return roundId;
}

// ---------------- rare-pick bonus ----------------
test('rare bonus: an unpopular pick at 1.5× beats a crowd that all picked the same squad', async () => {
  const ctx = makeGame({ treasurySol: 50 });
  const { game, roster, source, svm } = ctx;
  const cheap = roster.list.filter((t) => t.price === 4).map((t) => t.wallet);
  const common = cheap.slice(0, 5), X = common[0];
  const Y = cheap[20];
  const contrarian = [Y, ...cheap.slice(1, 5)];
  const crowd = Array.from({ length: 20 }, () => player());
  const lone = player();
  const id = await playRound(ctx, async ({ start }) => {
    source.byWallet[X] = roundTrip('TX', start + 100, 1, 3);    // +2 for the crowd's #1
    source.byWallet[Y] = roundTrip('TY', start + 200, 1, 2.6);  // +1.6, rare
    for (const p of crowd) await enter(game, p, common);
    await enter(game, lone, contrarian);
  });
  const lb = game.leaderboard(id);
  // crowd: 2*2 = 4. lone: 2 * (1.6 * 1.5) = 4.8 (without the bonus it would be 3.2 and lose)
  assert.equal(lb.rows[0].wallet, lone.wallet);
  assert.equal(lb.rows[0].score, 4.8);
  assert.equal(lb.rows[1].score, 4);
  assert.deepEqual(lb.rare, [Y]);
  assert.ok(balance(svm, lone.wallet) > 0);
  assert.equal(balance(svm, crowd[0].wallet), 0);
});

test('rare bonus never makes a loss bigger, and tiny rounds have no rare picks', () => {
  const pnl = new Map([['a', -2], ['b', 3]]);
  assert.equal(squadScore(['a', 'b'], pnl, { rare: new Set(['a', 'b']), rareBonus: 1.5 }), -4 + 4.5);
  const few = [{ picks: ['a', 'b'] }, { picks: ['a', 'c'] }, { picks: ['a', 'd'] }];
  assert.equal(rareSet(few, 5).size, 0, 'with 3 squads a single pick is 33%, never rare');
});

test('ownership endpoint data: share of squads that picked each trader', async () => {
  const { game, roster } = makeGame();
  const s = cheapSquad(roster);
  await enter(game, player(), s);
  await enter(game, player(), [s[0], ...cheapSquad(roster, 5).slice(0, 4)]);
  const o = game.ownership(game.openRoundId());
  assert.equal(o.total, 2);
  assert.equal(o.pct[s[0]], 100);
  assert.equal(o.pct[s[1]], 50);
});

// ---------------- data source failover ----------------
test('failover: if Kolscan fails, the whole round is scored by the backup source', async () => {
  const kol = new FixtureSource({}, 'kolscan'), backup = new FixtureSource({}, 'helius');
  const ctx = makeGame({ sources: [kol, backup] });
  const { game, roster, svm } = ctx;
  const a = player(); const squad = cheapSquad(roster);
  kol.failing.add(squad[3]);
  const id = await playRound(ctx, async ({ start }) => {
    kol.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 99);    // Kolscan's numbers must NOT be used
    backup.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2);  // backup says +1
    await enter(game, a, squad);
  });
  const round = game.q.round.get(id);
  assert.equal(round.status, 'settled');
  assert.equal(round.source, 'helius');
  assert.equal(game.leaderboard(id).rows[0].score, 2, 'scored entirely from the backup: #1 pick +1 × 2');
  assert.ok(balance(svm, a.wallet) > 0);
  assert.equal(game.health.kolscan.ok, false);
  assert.equal(game.health.helius.ok, true);
  assert.ok(game.q.events.all(10).some((e) => e.kind === 'failover'));
});

test('failover: if every source fails the round waits instead of paying on bad data', async () => {
  const kol = new FixtureSource({}, 'kolscan'), backup = new FixtureSource({}, 'helius');
  const ctx = makeGame({ sources: [kol, backup] });
  const squad = cheapSquad(ctx.roster);
  kol.failing.add(squad[0]); backup.failing.add(squad[1]);
  const id = await playRound(ctx, async () => { await enter(ctx.game, player(), squad); });
  const r = ctx.game.q.round.get(id);
  assert.notEqual(r.status, 'settled');
  assert.match(r.note, /kolscan: .*helius: /);
});

// ---------------- daily cost refresh ----------------
test('refresh parser reads the real Kolscan page, including records split across chunks', () => {
  const p = parseLeaderboardPage(PAGE);
  assert.ok(p.directory.size >= 500, 'directory ' + p.directory.size);
  assert.equal(p.boards[1].size, 50);
  assert.equal(p.boards[7].size, 50);
  assert.equal(p.boards[30].size, 50);
  assert.ok(p.boards[30].get('4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9'), 'decu’s split record parsed');
  const r = buildRoster(p, []);
  assert.ok(r.every((t) => t.price >= 4 && t.price <= 30 && t.name));
  assert.equal(Math.max(...r.map((t) => t.price)), 30);
  assert.equal(r.filter((t) => t.rank30d).length, 50);
});

test('refresh keeps traders that left Kolscan so saved squads never break', () => {
  const prev = Roster.load().list;
  const gone = { ...prev[0], wallet: '11111111111111111111111111111112', name: 'Left Kolscan' };
  const r = buildRoster(parseLeaderboardPage(PAGE), [...prev, gone]);
  const kept = r.find((t) => t.wallet === gone.wallet);
  assert.ok(kept);
  assert.equal(kept.price, 4);
  assert.equal(kept.pnl30d, null);
});

test('cost formula: top trader 30, unranked or losing 4, monotonic', () => {
  assert.equal(priceFor(1000, 1000), 30);
  assert.equal(priceFor(0, 1000), 4);
  assert.equal(priceFor(-5, 1000), 4);
  assert.ok(priceFor(500, 1000) > priceFor(100, 1000));
});

test('game refresh: runs when due, saves to the database, survives a restart, keeps entered costs', async () => {
  let calls = 0;
  const refresher = async ({ previous }) => { calls++; return buildRoster(parseLeaderboardPage(PAGE), previous); };
  const ctx = makeGame({ rosterRefresher: refresher, env: { ROSTER_REFRESH_HOURS: '24' } });
  const { game, roster, clock } = ctx;
  const p = player();
  const squad = cheapSquad(roster);
  const entry = await enter(game, p, squad);
  await game.tick(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1, 'first boot refreshes the bundled costs');
  assert.ok(game.roster.updatedAt);
  await game.tick();
  assert.equal(calls, 1, 'not again until 24h later');
  clock.add(24 * 3600 + 1);
  await game.tick(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
  const again = Roster.fromDb(game.db);
  assert.equal(again.list.length, game.roster.list.length, 'stored roster loads after a restart');
  assert.equal(game.q.entryOf.get(entry.roundId, p.wallet).cost, entry.cost, 'entered squads keep the cost they were entered at');
});

test('game refresh failure keeps the current costs and shows the error', async () => {
  const ctx = makeGame({ rosterRefresher: async () => { throw new Error('Kolscan returned HTTP 403'); } });
  const before = ctx.game.roster.list.length;
  await assert.rejects(ctx.game.refreshRosterNow(), /403/);
  assert.equal(ctx.game.roster.list.length, before);
  assert.equal(ctx.game.health.roster.ok, false);
  assert.ok(ctx.game.q.events.all(5).some((e) => e.kind === 'roster-error'));
});

test('game refresh: after a failure it retries an hour later, not a day later', async () => {
  let calls = 0;
  const ctx = makeGame({ rosterRefresher: async () => { calls++; throw new Error('blocked'); } });
  await ctx.game.tick(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  ctx.clock.add(1800); await ctx.game.tick(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  ctx.clock.add(1900); await ctx.game.tick(); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);
});

// ---------------- admin controls ----------------
test('admin: pausing entries blocks new squads; pausing payouts holds SOL until resumed', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm, clock, R, cfg } = ctx;
  game.setPaused({ entries: true });
  await assert.rejects(enter(game, player(), cheapSquad(roster)), (e) => e.status === 503);
  game.setPaused({ entries: false, payouts: true });
  const a = player(); const squad = cheapSquad(roster);
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2); await enter(game, a, squad); });
  assert.equal(game.q.payoutsFor.all(id)[0].status, 'pending');
  assert.equal(balance(svm, a.wallet), 0, 'paused: nothing sent');
  game.setPaused({ payouts: false });
  await game.tick();
  assert.equal(game.q.payoutsFor.all(id)[0].status, 'sent');
  assert.ok(balance(svm, a.wallet) > 0);
});

test('admin: void a round before payout; a round that already paid cannot be voided', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm } = ctx;
  game.setPaused({ payouts: true });
  const a = player(); const squad = cheapSquad(roster);
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2); await enter(game, a, squad); });
  const r = game.voidRound(id, 'Suspicious entries');
  assert.match(r.note, /Voided: Suspicious entries/);
  assert.equal(game.q.payoutsFor.all(id).length, 0);
  game.setPaused({ payouts: false }); await game.tick();
  assert.equal(balance(svm, a.wallet), 0, 'voided round never pays');

  const b = player(); const squad2 = cheapSquad(roster, 5);
  const id2 = await playRound(ctx, async ({ start }) => { source.byWallet[squad2[0]] = roundTrip('T2', start + 60, 1, 2); await enter(game, b, squad2); });
  assert.equal(game.q.payoutsFor.all(id2)[0].status, 'sent');
  assert.throws(() => game.voidRound(id2), (e) => e.status === 409);
});

test('admin: nobody can enter a round the operator voided', async () => {
  const { game, roster } = makeGame();
  const p = player();
  const ch = await game.challenge(p.wallet, cheapSquad(roster));
  game.voidRound(ch.roundId, 'closed early');
  await assert.rejects(game.submitEntry({ wallet: p.wallet, nonce: ch.nonce, signature: p.sign(ch.message) }), (e) => e.status === 409);
  await assert.rejects(game.challenge(p.wallet, cheapSquad(roster)), (e) => e.status === 409);
});

test('admin: a failed payout can be retried and then lands once', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm } = ctx;
  const a = player(); const squad = cheapSquad(roster);
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2); await enter(game, a, squad); game.setPaused({ payouts: true }); });
  const p = game.q.payoutsFor.all(id)[0];
  game.db.prepare("UPDATE payouts SET status = 'failed', attempts = 5, error = 'test' WHERE id = ?").run(p.id);
  assert.throws(() => game.retryPayout(9999), (e) => e.status === 404);
  game.retryPayout(p.id);
  assert.throws(() => game.retryPayout(p.id), (e) => e.status === 409);
  game.setPaused({ payouts: false }); await game.tick();
  assert.equal(game.q.payoutsFor.all(id)[0].status, 'sent');
  assert.equal(balance(svm, a.wallet), p.lamports);
});

test('admin overview has everything the panel shows', async () => {
  const { game } = makeGame();
  await game.tick();
  const o = await game.adminOverview();
  for (const k of ['payoutMode', 'paused', 'treasury', 'pot', 'owedLamports', 'rounds', 'payouts', 'health', 'sources', 'roster', 'settings', 'events']) assert.ok(k in o, k);
  assert.ok(o.pot.treasuryLamports > 0);
});
