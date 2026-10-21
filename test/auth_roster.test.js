'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { Keypair } = require('@solana/web3.js');
const { isPubkey, entryMessage, verifySignature } = require('../src/auth');
const { Roster } = require('../src/roster');
const { player } = require('./helpers');

const msg = 'PUMPICS squad entry\nNonce: abc';

test('valid wallet signatures verify (base58 and base64)', () => {
  const p = player();
  assert.ok(verifySignature(msg, p.sign(msg), p.wallet));
  const b64 = Buffer.from(bs58.decode(p.sign(msg))).toString('base64');
  assert.ok(verifySignature(msg, b64, p.wallet));
});

test('a Solana web3 Keypair signature verifies (same format Phantom returns)', () => {
  const kp = Keypair.generate();
  const sig = nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey);
  assert.ok(verifySignature(msg, bs58.encode(sig), kp.publicKey.toBase58()));
});

test('wrong wallet, tampered message and junk are rejected', () => {
  const p = player(), q = player();
  const sig = p.sign(msg);
  assert.equal(verifySignature(msg, sig, q.wallet), false);
  assert.equal(verifySignature(msg + ' ', sig, p.wallet), false);
  assert.equal(verifySignature(msg, 'notasig', p.wallet), false);
  assert.equal(verifySignature(msg, sig, 'not-a-wallet'), false);
  assert.equal(verifySignature(msg, undefined, p.wallet), false);
});

test('pubkey validation', () => {
  assert.ok(isPubkey(Keypair.generate().publicKey.toBase58()));
  assert.ok(!isPubkey('0OIl' + 'x'.repeat(40)));
  assert.ok(!isPubkey(''));
  assert.ok(!isPubkey(123));
});

test('the signed message names the wallet, round and every pick in order', () => {
  const picks = ['a1', 'b2', 'c3', 'd4', 'e5'];
  const m = entryMessage({ wallet: 'W', roundId: 7, roundStartIso: 'T', picks, nonce: 'n', issuedIso: 'I' });
  assert.match(m, /Wallet: W/); assert.match(m, /Round: 7/); assert.match(m, /#1 \(2x\): a1/); assert.match(m, /#5: e5/);
  assert.match(m, /does not send a transaction/);
});

test('roster has 514 unique traders with valid wallets and prices', () => {
  const r = Roster.load();
  assert.equal(r.list.length, 514);
  assert.equal(r.byWallet.size, 514);
  for (const t of r.list) { assert.ok(isPubkey(t.wallet), t.wallet); assert.ok(t.price >= 4 && t.price <= 30); assert.ok(t.name); }
});

test('squad rules: exactly 5, unique, on the roster, within budget', () => {
  const r = Roster.load();
  const cheap = r.list.filter((t) => t.price === 4).map((t) => t.wallet);
  const pricey = [...r.list].sort((a, b) => b.price - a.price).map((t) => t.wallet);
  assert.equal(r.check(cheap.slice(0, 5)).ok, true);
  assert.equal(r.check(cheap.slice(0, 5)).cost, 20);
  assert.match(r.check(cheap.slice(0, 4)).error, /exactly 5/);
  assert.match(r.check([cheap[0], cheap[0], ...cheap.slice(1, 4)]).error, /only be picked once/);
  assert.match(r.check([...cheap.slice(0, 4), Keypair.generate().publicKey.toBase58()]).error, /not on the PUMPICS roster/);
  assert.match(r.check(pricey.slice(0, 5)).error, /limit is 100/);
  assert.match(r.check('nope').error, /list/);
});
