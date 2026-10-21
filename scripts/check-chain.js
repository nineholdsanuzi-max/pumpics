'use strict';
// Pre-launch check: RPC reachable, treasury readable, token mint valid.
// Run on your host: npm run check:chain
require('../src/env').loadDotEnv();
const { loadConfig } = require('../src/config');
const { RpcChain, parseSecret } = require('../src/chain');

(async () => {
  const cfg = loadConfig();
  const treasury = parseSecret(cfg.treasurySecret);
  const chain = new RpcChain({ rpcUrl: cfg.rpcUrl, treasury, treasuryAddress: cfg.treasuryAddress });
  const ok = (m) => console.log('  ✓ ' + m), bad = (m) => { console.log('  ✗ ' + m); process.exitCode = 1; };
  console.log(`RPC ${cfg.rpcUrl}`);
  try { ok(`connected, block height ${await chain.blockHeight()}`); } catch (e) { return bad('RPC unreachable: ' + e.message); }
  if (!chain.treasuryPubkey) bad('No TREASURY_SECRET or TREASURY_ADDRESS set');
  else {
    const l = await chain.getTreasuryLamports();
    ok(`treasury ${chain.treasuryPubkey.toBase58()} holds ${(l / 1e9).toFixed(4)} SOL`);
    if (!treasury) console.log('  · watch-only: no secret key, so payouts cannot be sent');
  }
  console.log(`  · payouts: ${cfg.payoutMode}${cfg.payoutMode === 'dry-run' ? ' (winners are recorded, no SOL is sent)' : ''}`);
  if (cfg.tokenMint) {
    try { await chain.getTokenBalanceUi(chain.treasuryPubkey ? chain.treasuryPubkey.toBase58() : cfg.tokenMint, cfg.tokenMint); ok(`token mint ${cfg.tokenMint} found, holder gate ${cfg.minTokenHold}`); }
    catch (e) { bad('Token mint check failed: ' + e.message); }
  }
})();
