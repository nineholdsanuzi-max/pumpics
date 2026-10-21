'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { makeGame, player, enter, cheapSquad, roundTrip, balance, SOL } = require('./helpers');

/** Put a round's entries in, move the clock past the settle delay, run the scheduler. */
async function playRound(ctx, setup) {
  const { game, clock, R, cfg } = ctx;
  await game.tick(); // the scheduler creates the live and next rounds
  const roundId = game.openRoundId();
  const start = roundId * R;
  await setup({ roundId, start, end: start + R });
  clock.set(start + R + cfg.settleDelaySeconds + 1);
  await game.tick();
  return roundId;
}

test('entry: connect, sign, stored for the next round', async () => {
  const { game, roster } = makeGame();
  const p = player();
  const picks = cheapSquad(roster);
  const res = await enter(game, p, picks);
  assert.equal(res.ok, true);
  assert.equal(res.roundId, game.openRoundId());
  assert.deepEqual(game.playerView(p.wallet).open.picks, picks);
  const st = await game.state();
  assert.equal(st.open.entries, 1);
});

test('entry: re-entering the same round replaces the squad', async () => {
  const { game, roster } = makeGame();
  const p = player();
  await enter(game, p, cheapSquad(roster, 0));
  await enter(game, p, cheapSquad(roster, 5));
  assert.equal((await game.state()).open.entries, 1);
  assert.deepEqual(game.playerView(p.wallet).open.picks, cheapSquad(roster, 5));
});

test('entry: replayed, expired, wrong-wallet and late signatures are rejected', async () => {
  const { game, roster, clock, R } = makeGame();
  const p = player(), q = player();
  const picks = cheapSquad(roster);

  const ch = await game.challenge(p.wallet, picks);
  const sig = p.sign(ch.message);
  await game.submitEntry({ wallet: p.wallet, nonce: ch.nonce, signature: sig });
  await assert.rejects(game.submitEntry({ wallet: p.wallet, nonce: ch.nonce, signature: sig }), /already used/);

  const ch2 = await game.challenge(p.wallet, picks);
  await assert.rejects(game.submitEntry({ wallet: p.wallet, nonce: ch2.nonce, signature: q.sign(ch2.message) }), (e) => e.status === 401);
  await assert.rejects(game.submitEntry({ wallet: q.wallet, nonce: ch2.nonce, signature: q.sign(ch2.message) }), /not found/);

  const ch3 = await game.challenge(p.wallet, picks);
  clock.add(601);
  await assert.rejects(game.submitEntry({ wallet: p.wallet, nonce: ch3.nonce, signature: p.sign(ch3.message) }), /expired/);

  // Signed just before the hour, submitted after the round started.
  clock.set(game.openRoundId() * R - 5);
  const ch4 = await game.challenge(p.wallet, picks);
  clock.add(10);
  await assert.rejects(game.submitEntry({ wallet: p.wallet, nonce: ch4.nonce, signature: p.sign(ch4.message) }), (e) => e.status === 409);
});

test('entry: bad wallets and bad squads are rejected before signing', async () => {
  const { game, roster } = makeGame();
  await assert.rejects(game.challenge('nope', cheapSquad(roster)), /valid Solana wallet/);
  await assert.rejects(game.challenge(player().wallet, cheapSquad(roster).slice(0, 4)), /exactly 5/);
});

test('settlement: best squad wins, #1 counts double, SOL lands in the winner wallet', async () => {
  const ctx = makeGame({ treasurySol: 100 });
  const { game, roster, source, svm, treasury } = ctx;
  const [a, b, c] = [player(), player(), player()];
  const squad = cheapSquad(roster, 0);
  const alt = [squad[1], squad[0], ...squad.slice(2)]; // same five, different #1
  const before = balance(svm, treasury.publicKey);

  const roundId = await playRound(ctx, async ({ start }) => {
    source.byWallet[squad[0]] = roundTrip('T1', start + 100, 1, 4);   // +3
    source.byWallet[squad[1]] = roundTrip('T2', start + 200, 2, 3);   // +1
    source.byWallet[squad[2]] = roundTrip('T3', start - 500, 1, 9);   // sold before the round: 0
    source.byWallet[squad[3]] = roundTrip('T4', start + 3000, 2, 1);  // -1
    await enter(game, a, squad);   // 2*3 + 1 + 0 - 1 = 6
    await enter(game, b, alt);     // 2*1 + 3 + 0 - 1 = 4
    await enter(game, c, cheapSquad(roster, 5)); // 0
  });

  const lb = game.leaderboard(roundId);
  assert.equal(lb.final, true);
  assert.deepEqual(lb.rows.map((r) => [r.wallet, r.score, r.rank]), [[a.wallet, 6, 1], [b.wallet, 4, 2], [c.wallet, 0, 3]]);
  const pot = Math.floor((100 * SOL - 0.05 * SOL) * 0.1);
  assert.equal(lb.rows[0].payoutLamports, pot);
  assert.equal(lb.payouts[0].status, 'sent');
  assert.ok(lb.payouts[0].txSig);
  assert.equal(balance(svm, a.wallet), pot, 'winner received exactly the pot');
  assert.equal(balance(svm, b.wallet), 0);
  assert.ok(before - balance(svm, treasury.publicKey) >= pot);

  // Running the scheduler again never pays twice.
  await game.tick(); await game.tick();
  assert.equal(balance(svm, a.wallet), pot);
  assert.equal(game.q.payoutsFor.all(roundId).length, 1);
  assert.equal(game.playerView(a.wallet).history[0].payoutStatus, 'sent');
});

test('settlement: tied winners split the pot', async () => {
  const ctx = makeGame({ treasurySol: 10 });
  const { game, roster, source, svm } = ctx;
  const [a, b] = [player(), player()];
  const squad = cheapSquad(roster);
  await playRound(ctx, async ({ start }) => {
    source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2);
    await enter(game, a, squad); await enter(game, b, squad);
  });
  const each = Math.floor(Math.floor((10 * SOL - 0.05 * SOL) * 0.1) / 2);
  assert.equal(balance(svm, a.wallet), each);
  assert.equal(balance(svm, b.wallet), each);
});

test('settlement: if every squad lost money, nobody is paid and the pot rolls over', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm, treasury } = ctx;
  const a = player();
  const squad = cheapSquad(roster);
  const before = balance(svm, treasury.publicKey);
  const id = await playRound(ctx, async ({ start }) => {
    source.byWallet[squad[0]] = roundTrip('T', start + 60, 3, 1);
    await enter(game, a, squad);
  });
  assert.equal(game.q.round.get(id).status, 'settled');
  assert.match(game.q.round.get(id).note, /rolls over/);
  assert.equal(balance(svm, treasury.publicKey), before);
});

test('settlement: empty rounds settle quietly', async () => {
  const ctx = makeGame();
  const id = await playRound(ctx, async () => {});
  assert.equal(ctx.game.q.round.get(id).note, 'No entries');
});

test('settlement waits for the settle delay before scoring', async () => {
  const { game, roster, clock, R, source } = makeGame();
  const id = game.openRoundId();
  await enter(game, player(), cheapSquad(roster));
  clock.set((id + 1) * R + 10); // round over, delay not passed
  await game.tick();
  assert.notEqual(game.q.round.get(id).status, 'settled');
  assert.equal(source.calls, 0);
});

test('dry-run mode records winners but never moves SOL', async () => {
  const ctx = makeGame({ env: { PAYOUT_MODE: 'dry-run' } });
  const { game, roster, source, svm, treasury } = ctx;
  const a = player(); const squad = cheapSquad(roster);
  const before = balance(svm, treasury.publicKey);
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2); await enter(game, a, squad); });
  assert.equal(game.q.payoutsFor.all(id)[0].status, 'dry-run');
  assert.equal(balance(svm, a.wallet), 0);
  assert.equal(balance(svm, treasury.publicKey), before);
});

test('payout recovery: a send that errors is not repeated until its blockhash has expired', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm, chain } = ctx;
  const a = player(); const squad = cheapSquad(roster);
  chain.failNextSend = true;
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 2); await enter(game, a, squad); });
  let p = game.q.payoutsFor.all(id)[0];
  assert.equal(p.status, 'sending');
  assert.equal(balance(svm, a.wallet), 0);
  await game.tick();                                     // blockhash still valid: wait, do not resend
  assert.equal(game.q.payoutsFor.all(id)[0].attempts, 1);
  chain.height += 200;                                   // blockhash expired: safe to rebuild
  svm.expireBlockhash();
  await game.tick();                                     // marks pending
  await game.tick();                                     // resends
  p = game.q.payoutsFor.all(id)[0];
  assert.equal(p.status, 'sent');
  assert.equal(balance(svm, a.wallet), p.lamports, 'paid exactly once');
});

test('pot math: reserve, share, cap, and money already owed', () => {
  const { game } = makeGame({ env: { POT_SHARE: '0.5', RESERVE_SOL: '1', MAX_PAYOUT_SOL: '3' } });
  assert.equal(game.potFromBalance(0.5 * SOL), 0);
  assert.equal(game.potFromBalance(3 * SOL), 1 * SOL);
  assert.equal(game.potFromBalance(100 * SOL), 3 * SOL);
  assert.equal(game.potFromBalance(5 * SOL, 2 * SOL), 1 * SOL);
});

test('scoring outage: the round waits, then is voided without paying anyone', async () => {
  const ctx = makeGame();
  const { game, roster, source, clock, svm } = ctx;
  const a = player(); const squad = cheapSquad(roster);
  source.failing.add(squad[2]);
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 5); await enter(game, a, squad); });
  assert.notEqual(game.q.round.get(id).status, 'settled');
  assert.match(game.q.round.get(id).note, /Waiting to score/);
  clock.add(19 * 3600);
  await game.tick();
  assert.equal(game.q.round.get(id).status, 'settled');
  assert.match(game.q.round.get(id).note, /Voided/);
  assert.equal(balance(svm, a.wallet), 0);
});

test('scoring outage that recovers settles normally', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm } = ctx;
  const a = player(); const squad = cheapSquad(roster);
  source.failing.add(squad[2]);
  const id = await playRound(ctx, async ({ start }) => { source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 5); await enter(game, a, squad); });
  source.failing.clear();
  await game.tick();
  assert.equal(game.q.round.get(id).status, 'settled');
  assert.ok(balance(svm, a.wallet) > 0);
});

// ---- holder gate against a real SPL token inside the Solana runtime ----
function makeToken(ctx) {
  const { svm, treasury, chain } = ctx;
  const mint = Keypair.generate();
  const rent = Number(svm.minimumBalanceForRentExemption(BigInt(spl.MINT_SIZE)));
  const tx = new Transaction({ feePayer: treasury.publicKey, recentBlockhash: svm.latestBlockhash() }).add(
    SystemProgram.createAccount({ fromPubkey: treasury.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: spl.MINT_SIZE, programId: spl.TOKEN_PROGRAM_ID }),
    spl.createInitializeMint2Instruction(mint.publicKey, 6, treasury.publicKey, null));
  tx.sign(treasury, mint);
  const r = svm.sendTransaction(tx); assert.ok(!(r && r.err), 'mint created');
  chain.tokenAccountsOf = (owner) => [spl.getAssociatedTokenAddressSync(mint.publicKey, new PublicKey(owner))];
  const give = (owner, ui) => {
    const ata = spl.getAssociatedTokenAddressSync(mint.publicKey, new PublicKey(owner));
    const t = new Transaction({ feePayer: treasury.publicKey, recentBlockhash: svm.latestBlockhash() }).add(
      spl.createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, ata, new PublicKey(owner), mint.publicKey),
      spl.createMintToInstruction(mint.publicKey, ata, treasury.publicKey, BigInt(Math.round(ui * 1e6))));
    t.sign(treasury); const res = svm.sendTransaction(t); assert.ok(!(res && res.err), 'tokens minted');
  };
  return { mint: mint.publicKey.toBase58(), give };
}

test('holder gate: only wallets holding enough of the coin can enter', async () => {
  const ctx = makeGame();
  const tok = makeToken(ctx);
  ctx.cfg.tokenMint = tok.mint; ctx.cfg.minTokenHold = 1000;
  const holder = player(), small = player(), none = player();
  tok.give(holder.wallet, 1500); tok.give(small.wallet, 10);
  assert.equal(await ctx.chain.getTokenBalanceUi(holder.wallet, tok.mint), 1500);
  await enter(ctx.game, holder, cheapSquad(ctx.roster));
  await assert.rejects(enter(ctx.game, small, cheapSquad(ctx.roster)), (e) => e.status === 403 && /holds 10/.test(e.message));
  await assert.rejects(enter(ctx.game, none, cheapSquad(ctx.roster)), (e) => e.status === 403);
});

test('holder gate: a winner who sold the coin before settlement is skipped', async () => {
  const ctx = makeGame();
  const { game, roster, source, svm } = ctx;
  const tok = makeToken(ctx);
  ctx.cfg.tokenMint = tok.mint; ctx.cfg.minTokenHold = 100;
  const a = player(), b = player();
  tok.give(a.wallet, 100); tok.give(b.wallet, 100);
  const squad = cheapSquad(roster), squadB = [...cheapSquad(roster, 5).slice(0, 4), squad[0]];
  await playRound(ctx, async ({ start }) => {
    source.byWallet[squad[0]] = roundTrip('T', start + 60, 1, 3);
    await enter(game, a, squad); await enter(game, b, squadB);
    ctx.chain.tokenAccountsOf = (owner) => owner === a.wallet ? [] : [spl.getAssociatedTokenAddressSync(new PublicKey(tok.mint), new PublicKey(owner))];
  });
  assert.equal(balance(svm, a.wallet), 0);
  assert.ok(balance(svm, b.wallet) > 0, 'next best holder was paid');
});
