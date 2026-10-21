'use strict';
/** All settings come from environment variables. See .env.example. */
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

function loadConfig(env = process.env) {
  const cfg = {
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH || './pumpics.db',
    rpcUrl: env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    network: env.SOLANA_NETWORK || 'mainnet-beta',
    // Treasury = the wallet that receives the coin's creator fees and pays winners.
    treasurySecret: env.TREASURY_SECRET || '',          // base58 secret key or JSON byte array
    treasuryAddress: env.TREASURY_ADDRESS || '',        // optional: watch-only when no secret is set
    payoutMode: (env.PAYOUT_MODE || 'dry-run').toLowerCase(), // 'dry-run' | 'live'
    potShare: num(env.POT_SHARE, 0.1),                  // share of the treasury balance paid out per round
    reserveSol: num(env.RESERVE_SOL, 0.05),             // never pay below this balance (keeps fees + rent)
    maxPayoutSol: num(env.MAX_PAYOUT_SOL, 50),          // hard cap per round, safety valve
    roundSeconds: num(env.ROUND_SECONDS, 3600),
    settleDelaySeconds: num(env.SETTLE_DELAY_SECONDS, 300), // wait for Kolscan to index the last trades
    budget: num(env.BUDGET, 100),
    squadSize: 5,
    // Optional holder gate: entrants must hold this many of your coin.
    tokenMint: env.TOKEN_MINT || '',
    minTokenHold: num(env.MIN_TOKEN_HOLD, 0),
    // Scoring source
    kolscanBase: env.KOLSCAN_BASE || 'https://kolscan.io',
    kolscanMinGapMs: num(env.KOLSCAN_MIN_GAP_MS, 1200),
    liveRefreshSeconds: num(env.LIVE_REFRESH_SECONDS, 300),
    nonceTtlSeconds: num(env.NONCE_TTL_SECONDS, 600),
    heliusApiKey: env.HELIUS_API_KEY || '',
    rarePickPct: num(env.RARE_PICK_PCT, 5),          // picked by fewer than this % of squads = rare
    rarePickBonus: num(env.RARE_PICK_BONUS, 1.5),    // profit multiplier for rare picks (never applied to losses)
    rosterRefreshHours: num(env.ROSTER_REFRESH_HOURS, 24),
    adminToken: env.ADMIN_TOKEN || '',
    siteUrl: env.SITE_URL || '',
  };
  if (!['dry-run', 'live'].includes(cfg.payoutMode)) throw new Error('PAYOUT_MODE must be dry-run or live');
  if (cfg.payoutMode === 'live' && !cfg.treasurySecret) throw new Error('PAYOUT_MODE=live needs TREASURY_SECRET');
  if (!(cfg.potShare > 0 && cfg.potShare <= 1)) throw new Error('POT_SHARE must be between 0 and 1');
  if (cfg.roundSeconds < 60) throw new Error('ROUND_SECONDS must be at least 60');
  return cfg;
}

module.exports = { loadConfig };
