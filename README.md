# PUMPICS

Pick 5 real memecoin traders. Every hour, the squad whose traders made the most realized profit wins a share of the creator-fee treasury, paid in SOL.

## How a round works

1. **Entries.** You always enter the *next* hourly round, never the one already running. Picks lock at the top of the hour.
2. **Wallet sign-in.** The player signs a plain-text message that names their wallet, the round and all five picks in order. Signing is free and sends no transaction. The server checks the ed25519 signature, and each signature can be used once.
3. **Scoring.** About 5 minutes after the hour ends (`SETTLE_DELAY_SECONDS`), the server pulls each picked trader's last 24 hours of swaps from Kolscan. It scores realized PnL for sells inside the hour, using the average cost of the tokens sold. The #1 spot counts double.
4. **Payout.** The top squad gets `POT_SHARE` of the treasury balance, minus `RESERVE_SOL` and capped at `MAX_PAYOUT_SOL`. Ties split the payout. If no squad made a profit, nothing is paid and the money stays for the next round.

## Fairness and operations

- **Rare picks.** A trader picked by fewer than 5% of squads in a round scores ×1.5 on profit (never on losses). This stops everyone copying the same squad, because the crowd can be beaten by a smart unpopular pick. The site shows each trader's pick % and a "Rare" badge. Auto-pick is randomized, so its squads differ too.
- **Daily costs.** Every 24 hours (`ROSTER_REFRESH_HOURS`) the server re-reads kolscan.io/leaderboard, adds new traders and re-prices everyone on their latest form. Traders who leave Kolscan stay on the roster at the minimum cost, so saved squads never break, and an entered squad keeps the cost it was entered at. If a refresh fails, the current costs stay.
- **Backup data.** With `HELIUS_API_KEY` set, a round that Kolscan can't score is scored entirely from Helius (on-chain transaction history). One round is always scored by one source.
- **Admin panel.** Open `/admin` and sign in with `ADMIN_TOKEN`. From there you can:
  - see the treasury, next prize, data-source health and an activity log
  - pause entries or payouts
  - void a round (only before it has paid)
  - retry a failed payout
  - refresh costs now
  - settle due rounds

## Run it

```bash
npm install
cp .env.example .env      # fill in RPC_URL and TREASURY_SECRET
npm run check:chain       # RPC, treasury balance, token mint
npm run check:kolscan     # can this server reach Kolscan and score the last hour?
npm start                 # http://localhost:3000
```

You need a host that keeps one Node process running, such as Railway, Render, Fly.io or a VPS. Vercel serverless won't work, because the hourly scheduler and the SQLite file both need a long-running process. Mount a persistent disk at `DB_PATH`.

### Going live with payouts

1. Run at least one full round with `PAYOUT_MODE=dry-run`. Winners are recorded and shown as "Won (test)", and no SOL moves.
2. Point your coin's creator fees at the treasury wallet, or forward them to it.
3. Set `PAYOUT_MODE=live` and keep `MAX_PAYOUT_SOL` small at first.

Each payout's signature is saved **before** it is sent. If the server crashes mid-send, it checks on chain before trying again, so a winner is never paid twice.

## Tests

```bash
npm test          # 69 unit + API tests (scoring, signatures, rounds, payouts in a real Solana runtime)
npm run test:e2e  # 9 browser tests in headless Chromium (wallet connect, sign, enter, win, payout, admin panel)
```

The payout tests run real SOL and SPL-token transactions inside LiteSVM, an in-process Solana runtime.

## If Kolscan blocks your server

Scoring uses Kolscan's data endpoint, the same one its wallet pages use. It is unofficial and rate-limited: requests are spaced 1.2 s apart, and the server waits and retries after a 429. If Kolscan is down or blocks your host, the round is **not** scored on partial data. It waits and retries. Set `HELIUS_API_KEY` and the round is scored from Helius instead. If both sources fail, the round waits; after 18 hours it is voided and nobody is paid. Any other source can be added by implementing `fetchTrades(wallet)` (see `src/helius.js`).

## API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | rounds, pot, entry counts |
| GET | `/api/traders` | the trader roster with current costs |
| POST | `/api/entry/challenge` | `{ wallet, picks[5] }` → message to sign |
| POST | `/api/entry` | `{ wallet, nonce, signature }` |
| GET | `/api/player/:wallet` | your entries, results, payouts |
| GET | `/api/leaderboard/live\|last\|:round` | standings and payout transactions |
| GET | `/api/ownership/open` | % of squads picking each trader |
| — | `/api/admin/*` | admin panel API (`Authorization: Bearer ADMIN_TOKEN`) |
