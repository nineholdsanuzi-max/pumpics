'use strict';
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');

function parseSecret(secret) {
  if (!secret) return null;
  const s = secret.trim();
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  if (bytes.length !== 64) throw new Error('TREASURY_SECRET must be a 64-byte secret key');
  return Keypair.fromSecretKey(bytes);
}

/** Sum the raw token amount held by `owner` across token accounts (both token programs). */
function sumTokenAccounts(accounts, mint) {
  let raw = 0n;
  for (const data of accounts) {
    const acc = AccountLayout.decode(Buffer.from(data).subarray(0, AccountLayout.span));
    if (new PublicKey(acc.mint).equals(mint)) raw += BigInt(acc.amount);
  }
  return raw;
}

function buildTransfer(from, to, lamports, blockhash) {
  const tx = new Transaction({ feePayer: from.publicKey, recentBlockhash: blockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }));
  tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports }));
  tx.sign(from);
  return { raw: tx.serialize(), sig: bs58.encode(tx.signature), tx };
}

/** Production adapter: a Solana JSON-RPC endpoint. */
class RpcChain {
  constructor({ rpcUrl, treasury, treasuryAddress }) {
    this.conn = new Connection(rpcUrl, 'confirmed');
    this.treasury = treasury;
    this.treasuryPubkey = treasury ? treasury.publicKey : (treasuryAddress ? new PublicKey(treasuryAddress) : null);
  }
  async getTreasuryLamports() { return this.treasuryPubkey ? this.conn.getBalance(this.treasuryPubkey) : 0; }
  async getTokenBalanceUi(owner, mintAddr) {
    const mint = new PublicKey(mintAddr);
    const mintInfo = await this.conn.getAccountInfo(mint);
    if (!mintInfo) throw new Error('Token mint not found');
    const decimals = MintLayout.decode(mintInfo.data.subarray(0, MintLayout.span)).decimals;
    let raw = 0n;
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await this.conn.getTokenAccountsByOwner(new PublicKey(owner), { programId });
      raw += sumTokenAccounts(res.value.map((v) => v.account.data), mint);
    }
    return Number(raw) / 10 ** decimals;
  }
  async signTransfer(to, lamports) {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const { raw, sig } = buildTransfer(this.treasury, to, lamports, blockhash);
    return { raw, sig, lastValidBlockHeight };
  }
  async send(raw) { await this.conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 }); }
  async status(sig) {
    const { value } = await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = value[0];
    if (!s) return null;
    if (s.err) return 'failed';
    return s.confirmationStatus === 'processed' ? 'processing' : 'confirmed';
  }
  async blockHeight() { return this.conn.getBlockHeight('confirmed'); }
}

/** In-process Solana runtime (LiteSVM). Used by the test suite and local demo mode. */
class LiteSvmChain {
  constructor({ svm, treasury }) {
    this.svm = svm; this.treasury = treasury; this.treasuryPubkey = treasury.publicKey;
    this.sent = new Map(); this.height = 1000;
  }
  async getTreasuryLamports() { return Number(this.svm.getBalance(this.treasuryPubkey) || 0n); }
  async getTokenBalanceUi(owner, mintAddr) {
    const mint = new PublicKey(mintAddr);
    const mintAcc = this.svm.getAccount(mint);
    if (!mintAcc) throw new Error('Token mint not found');
    const decimals = MintLayout.decode(Buffer.from(mintAcc.data).subarray(0, MintLayout.span)).decimals;
    const accs = (this.tokenAccountsOf && this.tokenAccountsOf(owner)) || [];
    const datas = accs.map((a) => this.svm.getAccount(a)).filter(Boolean).map((a) => a.data);
    return Number(sumTokenAccounts(datas, mint)) / 10 ** decimals;
  }
  async signTransfer(to, lamports) {
    const { raw, sig, tx } = buildTransfer(this.treasury, to, lamports, this.svm.latestBlockhash());
    this._pending = this._pending || new Map();
    this._pending.set(sig, tx);
    return { raw, sig, lastValidBlockHeight: this.height + 150 };
  }
  async send(raw) {
    const tx = Transaction.from(raw);
    const sig = bs58.encode(tx.signature);
    if (this.failNextSend) { this.failNextSend = false; throw new Error('simulated network error'); }
    const res = this.svm.sendTransaction(tx);
    const ok = !(res && typeof res.err === 'function');
    this.sent.set(sig, ok ? 'confirmed' : 'failed');
    if (!ok) throw new Error('Transaction failed: ' + String(res.err()));
  }
  async status(sig) { return this.sent.get(sig) || null; }
  async blockHeight() { return this.height; }
}

module.exports = { RpcChain, LiteSvmChain, parseSecret, sumTokenAccounts, buildTransfer };
