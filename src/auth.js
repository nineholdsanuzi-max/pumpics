'use strict';
const nacl = require('tweetnacl');
const crypto = require('crypto');
const bs58 = require('bs58').default || require('bs58');

/** True if `s` is a base58 string that decodes to a 32-byte Solana public key. */
function isPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return bs58.decode(s).length === 32; } catch { return false; }
}

/**
 * The exact text the player signs. It names the round and the squad, so a
 * signature can never be replayed for a different squad, round or wallet.
 */
function entryMessage({ wallet, roundId, roundStartIso, picks, nonce, issuedIso }) {
  return [
    'PUMPICS squad entry',
    '',
    `Wallet: ${wallet}`,
    `Round: ${roundId} (starts ${roundStartIso})`,
    `#1 (2x): ${picks[0]}`,
    `#2: ${picks[1]}`,
    `#3: ${picks[2]}`,
    `#4: ${picks[3]}`,
    `#5: ${picks[4]}`,
    '',
    'Signing is free and does not send a transaction.',
    `Nonce: ${nonce}`,
    `Issued: ${issuedIso}`,
  ].join('\n');
}

function newNonce() { return crypto.randomBytes(16).toString('hex'); }

/** Verify an ed25519 signature (base58 or base64) over `message` by `wallet`. */
function verifySignature(message, signature, wallet) {
  if (!isPubkey(wallet) || typeof signature !== 'string') return false;
  let sig;
  try { sig = bs58.decode(signature); } catch { sig = null; }
  if (!sig || sig.length !== 64) {
    try { sig = Buffer.from(signature, 'base64'); } catch { return false; }
  }
  if (sig.length !== 64) return false;
  return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, bs58.decode(wallet));
}

module.exports = { isPubkey, entryMessage, newNonce, verifySignature };
