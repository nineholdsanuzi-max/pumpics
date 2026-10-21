'use strict';
const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const { LiteSVM } = require('litesvm');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { openDb } = require('../src/db');
const { Roster } = require('../src/roster');
const { Game } = require('../src/game');
const { LiteSvmChain } = require('../src/chain');
const { loadConfig } = require('../src/config');

const SOL = 1_000_000_000;

class FixtureSource {
  constructor(byWallet = {}, name = 'kolscan') { this.byWallet = byWallet; this.failing = new Set(); this.calls = 0; this.name = name; }
  async fetchTrades(wallet) {
    this.calls++;
    if (this.failing.has(wallet)) throw new Error('Kolscan returned HTTP 503');
    return this.byWallet[wallet] || [];
  }
}

function makeClock(start) {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = v; };
  now.add = (s) => { t += s; };
  return now;
}

function makeGame({ env = {}, treasurySol = 100, start, sources, rosterRefresher = null } = {}) {
  const roster = Roster.load();
  const cfg = loadConfig({ PAYOUT_MODE: 'live', TREASURY_SECRET: 'x', ...env });
  const svm = new LiteSVM();
  const treasury = Keypair.generate();
  svm.airdrop(treasury.publicKey, BigInt(Math.round(treasurySol * SOL)));
  const chain = new LiteSvmChain({ svm, treasury });
  const source = new FixtureSource();
  const R = cfg.roundSeconds;
  const clock = makeClock(start ?? (Math.floor(1791820000 / R) * R + 600)); // 10 minutes into a round
  const game = new Game({ db: openDb(':memory:'), cfg, roster, sources: sources || [source], chain, rosterRefresher, now: clock });
  return { game, cfg, roster, svm, chain, treasury, source, clock, R };
}

function player() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  return { wallet, sign: (msg) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)) };
}

async function enter(game, p, picks) {
  const ch = await game.challenge(p.wallet, picks);
  return game.submitEntry({ wallet: p.wallet, nonce: ch.nonce, signature: p.sign(ch.message) });
}

/** Cheap valid squad from the roster (5 unranked traders cost 4 each). */
function cheapSquad(roster, offset = 0) {
  return roster.list.filter((t) => t.price === 4).slice(offset, offset + 5).map((t) => t.wallet);
}

/** A trader who buys `cost` SOL of a token then sells it for `proceeds` at time ts. */
function roundTrip(token, ts, cost, proceeds) {
  return [
    { ts: ts - 30, side: 'buy', token, amount: 1000, sol: cost },
    { ts, side: 'sell', token, amount: 1000, sol: proceeds },
  ];
}

const balance = (svm, pk) => Number(svm.getBalance(new PublicKey(pk)) || 0n);

module.exports = { FixtureSource, makeGame, player, enter, cheapSquad, roundTrip, balance, SOL, Keypair, SystemProgram, Transaction };
