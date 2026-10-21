'use strict';
/**
 * Daily roster + cost refresh from kolscan.io/leaderboard.
 *
 * The leaderboard page embeds (as escaped JSON in the page payload):
 *   - the full KOL directory: { wallet_address, name, pfp, telegram, twitter, ... }
 *   - the daily / weekly / monthly top-50 boards: { wallet_address, name, twitter, profit, wins, losses, timeframe }
 * We rebuild the roster from both and re-price every trader on their latest form.
 * Traders already on the roster are never dropped, so a saved squad can't break.
 */
const { isPubkey } = require('./auth');

// Next.js streams the payload in <script> chunks that can split a record in half: stitch them back first.
const stitch = (html) => html.replace(/"\]\)<\/script><script>self\.__next_f\.push\(\[1,"/g, '');
const unescape = (html) => stitch(html).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
const handle = (u) => {
  if (!u) return null;
  const h = String(u).replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9_]{3,15}$/.test(h) && h.toLowerCase() !== 'https' ? h : null;
};
const cleanName = (n, h, w) => {
  let s = String(n || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16))).trim();
  if (!s.replace(/[^\p{L}\p{N}]/gu, '')) s = h || w.slice(0, 6);
  return s.slice(0, 40);
};

function parseLeaderboardPage(html) {
  const t = unescape(html);
  const directory = new Map();
  const dirRe = /\{"wallet_address":"([1-9A-HJ-NP-Za-km-z]{32,44})","name":"((?:[^"\\]|\\.)*)","pfp":(?:null|"[^"]*"),"telegram":(?:null|"[^"]*"),"twitter":(null|"[^"]*")/g;
  let m;
  while ((m = dirRe.exec(t))) {
    if (!directory.has(m[1])) directory.set(m[1], { wallet: m[1], rawName: m[2], twitter: m[3] === 'null' ? null : m[3].slice(1, -1) });
  }
  const boards = { 1: new Map(), 7: new Map(), 30: new Map() };
  const lbRe = /\{"wallet_address":"([1-9A-HJ-NP-Za-km-z]{32,44})","name":"((?:[^"\\]|\\.)*)","telegram":(?:null|"[^"]*"),"twitter":(null|"[^"]*"),"profit":(-?[0-9.eE+-]+),"wins":(\d+),"losses":(\d+),"timeframe":(\d+),"currency":"SOL"\}/g;
  while ((m = lbRe.exec(t))) {
    const tf = Number(m[7]);
    if (!boards[tf] || boards[tf].has(m[1])) continue;
    boards[tf].set(m[1], { profit: Number(m[4]), wins: Number(m[5]), losses: Number(m[6]) });
    if (!directory.has(m[1])) directory.set(m[1], { wallet: m[1], rawName: m[2], twitter: m[3] === 'null' ? null : m[3].slice(1, -1) });
  }
  return { directory, boards };
}

/** Cost from form: 30-day profit, else 2× the 7-day, else 4× the 24-hour. 4 credits if unranked or losing. */
function priceFor(score, max) {
  if (!(score > 0) || !(max > 0)) return 4;
  return Math.max(5, Math.min(30, Math.round(5 + 25 * Math.sqrt(Math.min(score, max) / max))));
}

function buildRoster({ directory, boards }, previous = []) {
  const all = new Map(previous.map((t) => [t.wallet, { wallet: t.wallet, rawName: t.name, twitter: t.x ? `https://x.com/${t.x}` : null }]));
  for (const [w, d] of directory) all.set(w, { ...all.get(w), ...d });
  const max = Math.max(0, ...[...boards[30].values()].map((r) => r.profit));
  const rank30 = new Map([...boards[30]].sort((a, b) => b[1].profit - a[1].profit).map(([w], i) => [w, i + 1]));
  const out = [];
  for (const [w, d] of all) {
    if (!isPubkey(w)) continue;
    const b30 = boards[30].get(w), b7 = boards[7].get(w), b1 = boards[1].get(w);
    const x = handle(d.twitter);
    const score = b30 ? b30.profit : b7 ? b7.profit * 2 : b1 ? b1.profit * 4 : 0;
    out.push({
      wallet: w, name: cleanName(d.rawName, x, w), x,
      pnl30d: b30 ? round2(b30.profit) : null, wins30d: b30 ? b30.wins : null, losses30d: b30 ? b30.losses : null,
      pnl7d: b7 ? round2(b7.profit) : null, pnl24h: b1 ? round2(b1.profit) : null,
      price: priceFor(score, max), rank30d: rank30.get(w) || null,
    });
  }
  out.sort((a, b) => (b.pnl30d ?? -1e9) - (a.pnl30d ?? -1e9) || (b.pnl7d ?? -1e9) - (a.pnl7d ?? -1e9) || a.name.localeCompare(b.name));
  return out;
}
const round2 = (x) => Math.round(x * 100) / 100;

async function fetchLeaderboardPage({ base = 'https://kolscan.io', fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/leaderboard`, { headers: { Accept: 'text/html' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Kolscan leaderboard returned HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

/** Fetch, parse and sanity-check. Throws instead of returning a broken roster. */
async function refreshRoster({ previous, ...opts }) {
  const html = await fetchLeaderboardPage(opts);
  const parsed = parseLeaderboardPage(html);
  if (parsed.directory.size < 100) throw new Error(`Kolscan page had only ${parsed.directory.size} traders; keeping the current roster`);
  if (parsed.boards[30].size < 10) throw new Error('Kolscan 30-day board looked empty; keeping the current roster');
  return buildRoster(parsed, previous);
}

module.exports = { parseLeaderboardPage, buildRoster, priceFor, refreshRoster };
