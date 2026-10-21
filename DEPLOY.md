# Putting PUMPICS live

PUMPICS needs a host that keeps one server running around the clock, because rounds settle every hour. Vercel and Netlify won't work for this. This guide uses **Railway**: it deploys straight from GitHub, keeps the database on a disk, and gives you a web address with HTTPS.

## 1. Put the code on GitHub
1. Create a new **private** repository on github.com (for example `pumpics`).
2. Upload the contents of the `pumpics` folder (not the zip itself), with **Add file → Upload files**. Skip `node_modules` if it's there.

## 2. Create the Railway service
1. On railway.com: **New Project → Deploy from GitHub repo →** pick `pumpics`.
2. Railway finds the `Dockerfile` and `railway.json` and builds them automatically.

## 3. Add a volume (important)
In the service: **Settings → Volumes → Add Volume**, mount path **`/data`**.
This is where the database lives: entries, results and payout records. Without a volume, every redeploy wipes them.

## 4. Set the variables
Service → **Variables**. Start in test mode:

| Variable | Value |
|---|---|
| `PAYOUT_MODE` | `dry-run` |
| `ADMIN_TOKEN` | a long random password (20+ characters) |
| `RPC_URL` | your Helius RPC URL, e.g. `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| `HELIUS_API_KEY` | your Helius key (turns on the backup scorer) |
| `TREASURY_ADDRESS` | the wallet that receives the creator fees (watch-only for now) |

Later, once the coin is live: `TOKEN_MINT` and `MIN_TOKEN_HOLD` for the holder gate.

## 5. Get the web address
Service → **Settings → Networking → Generate Domain** gives you a `*.up.railway.app` address.
For your own domain, choose **Custom Domain**, enter e.g. `pumpics.xyz`, and add the CNAME record Railway shows at your domain registrar.

## 6. Check it works
- Open the site. The prize, countdown and 539+ traders should load.
- Open `/admin` and sign in with `ADMIN_TOKEN`.
- Service → **⋯ → Shell**, run `npm run check:kolscan`. If Kolscan blocks Railway's servers, the Helius key keeps rounds scoring.
- Enter a squad with your own wallet. After the next full hour plus 5 minutes, the round shows as settled in `/admin`.

## 7. Switch on real payouts
Only after a test round settles correctly:
1. Create a **dedicated hot wallet** for payouts. Never use your main wallet. Keep only a few rounds' worth of SOL in it, and top it up from the creator-fee wallet.
2. Add `TREASURY_SECRET` (that wallet's secret key) and remove `TREASURY_ADDRESS`.
3. Set `MAX_PAYOUT_SOL` low at first (e.g. `1`), then `PAYOUT_MODE=live`.
4. Watch the first payout land in `/admin` and on Solscan.

You can pause payouts or entries from `/admin` at any time without redeploying.
