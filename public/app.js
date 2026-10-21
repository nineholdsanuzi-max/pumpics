(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sol = (l) => (l / 1e9).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const short = (w) => w.slice(0, 4) + '…' + w.slice(-4);
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let tt; const toast = (m, ms = 2600) => { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), ms); };

async function api(path, body) {
  if (window.PUMPICS_DEMO) return window.PUMPICS_DEMO(path, body);
  const res = await fetch('/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let json = null; try { json = await res.json(); } catch {}
  if (!res.ok) { const e = new Error((json && json.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return json;
}

// ---------------------------------------------------------------- base58
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (const byte of bytes) { if (byte === 0) out += '1'; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// ---------------------------------------------------------------- wallets
// Wallet Standard (Phantom, Solflare, Backpack, Glow, Magic Eden…) plus legacy injected providers as a fallback.
const Wallets = (() => {
  const std = [];
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => f());
  const ok = (w) => w && Array.isArray(w.chains) && w.chains.some((c) => String(c).startsWith('solana:')) && w.features && w.features['standard:connect'] && w.features['solana:signMessage'];
  const reg = { register: (...ws) => { ws.forEach((w) => { if (ok(w) && !std.includes(w)) std.push(w); }); changed(); return () => {}; } };
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(reg); } catch {} });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: reg })); } catch {}

  function legacy() {
    const out = [];
    const ph = window.phantom && window.phantom.solana;
    if (ph && ph.isPhantom) out.push({ name: 'Phantom', provider: ph });
    if (window.solflare && window.solflare.isSolflare) out.push({ name: 'Solflare', provider: window.solflare });
    const bp = window.backpack && (window.backpack.solana || window.backpack);
    if (bp && bp.connect) out.push({ name: 'Backpack', provider: bp });
    if (!out.length && window.solana && window.solana.connect) out.push({ name: window.solana.isPhantom ? 'Phantom' : 'Solana wallet', provider: window.solana });
    return out;
  }

  function list() {
    const names = new Set(std.map((w) => w.name));
    return [
      ...std.map((w) => ({ name: w.name, icon: w.icon, kind: 'std', w })),
      ...legacy().filter((l) => !names.has(l.name)).map((l) => ({ name: l.name, kind: 'legacy', provider: l.provider })),
    ];
  }

  async function connect(entry, { silent = false } = {}) {
    if (entry.kind === 'std') {
      const w = entry.w;
      const res = await w.features['standard:connect'].connect(silent ? { silent: true } : undefined);
      const account = (res && res.accounts && res.accounts[0]) || w.accounts[0];
      if (!account) throw new Error('The wallet did not share an account.');
      let off = () => {};
      if (w.features['standard:events']) off = w.features['standard:events'].on('change', ({ accounts }) => { if (accounts) session.onChange(accounts[0] ? accounts[0].address : null); });
      return {
        name: w.name, address: account.address,
        signMessage: async (bytes) => { const [out] = await w.features['solana:signMessage'].signMessage({ account, message: bytes }); return out.signature; },
        disconnect: async () => { off(); if (w.features['standard:disconnect']) await w.features['standard:disconnect'].disconnect(); },
      };
    }
    const p = entry.provider;
    const r = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
    const pk = (r && r.publicKey) || p.publicKey;
    if (!pk) throw new Error('The wallet did not share an account.');
    const onAcc = (next) => session.onChange(next ? next.toString() : null);
    if (p.on) p.on('accountChanged', onAcc);
    return {
      name: entry.name, address: pk.toString(),
      signMessage: async (bytes) => { const s = await p.signMessage(bytes, 'utf8'); return s.signature || s; },
      disconnect: async () => { if (p.off) p.off('accountChanged', onAcc); if (p.disconnect) await p.disconnect(); },
    };
  }
  return { list, connect, onChange: (f) => listeners.add(f) };
})();

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const session = {
  wallet: null,
  async use(entry, opts) {
    const w = await Wallets.connect(entry, opts);
    this.wallet = w; store.set('pumpics-wallet', w.name);
    renderWalletBtn(); loadPlayer();
    return w;
  },
  async logout() { const w = this.wallet; this.wallet = null; store.set('pumpics-wallet', null); renderWalletBtn(); renderMine(null); renderLock(); try { await w?.disconnect(); } catch {} },
  onChange(addr) {
    if (!this.wallet) return;
    if (!addr) return this.logout();
    if (addr !== this.wallet.address) { this.wallet.address = addr; toast('Switched to ' + short(addr)); renderWalletBtn(); loadPlayer(); }
  },
};

function renderWalletBtn() {
  const b = $('wallet');
  if (session.wallet) { b.innerHTML = `<span class="dot"></span>${esc(short(session.wallet.address))}`; b.classList.add('on'); b.title = 'Disconnect'; }
  else { b.textContent = 'Connect wallet'; b.classList.remove('on'); b.title = ''; }
}

let pendingConnect = null;
function openWalletModal() {
  const wl = Wallets.list();
  const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
  let html = wl.map((w, i) => `<button type="button" class="wopt" data-i="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : `<span class="wi">${esc(w.name[0])}</span>`}${esc(w.name)}<small>Detected</small></button>`).join('');
  if (!wl.length) {
    $('wm-sub').textContent = isMobile ? 'Open PUMPICS inside your wallet app to connect.' : 'No Solana wallet was found in this browser. Install one, then reload this page.';
    html = isMobile
      ? `<a class="wopt" href="https://phantom.app/ul/browse/${here}?ref=${ref}"><span class="wi">P</span>Open in Phantom</a>
         <a class="wopt" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}"><span class="wi">S</span>Open in Solflare</a>`
      : `<a class="wopt" href="https://phantom.com/download" target="_blank" rel="noopener"><span class="wi">P</span>Get Phantom<small>phantom.com</small></a>
         <a class="wopt" href="https://solflare.com/download" target="_blank" rel="noopener"><span class="wi">S</span>Get Solflare<small>solflare.com</small></a>
         <a class="wopt" href="https://backpack.app/downloads" target="_blank" rel="noopener"><span class="wi">B</span>Get Backpack<small>backpack.app</small></a>`;
  } else $('wm-sub').textContent = 'Pick the Solana wallet you want to play with.';
  $('wlist').innerHTML = html;
  $('wlist').querySelectorAll('button.wopt').forEach((b) => b.onclick = async () => {
    const entry = wl[+b.dataset.i];
    b.disabled = true; b.querySelector('small').textContent = 'Approve in wallet…';
    try { await session.use(entry); closeWalletModal(); toast('Connected ' + short(session.wallet.address)); if (pendingConnect) { const f = pendingConnect; pendingConnect = null; f(); } }
    catch (e) { b.disabled = false; b.querySelector('small').textContent = 'Detected'; toast(rejected(e) ? 'Connection cancelled in the wallet' : 'Could not connect: ' + (e.message || e)); }
  });
  $('wmodal').hidden = false;
  const first = $('wlist').querySelector('.wopt'); if (first) first.focus();
}
function closeWalletModal() { $('wmodal').hidden = true; }
const rejected = (e) => e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ''));
$('wclose').onclick = () => { pendingConnect = null; closeWalletModal(); };
$('wmodal').addEventListener('click', (e) => { if (e.target === $('wmodal')) { pendingConnect = null; closeWalletModal(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('wmodal').hidden) { pendingConnect = null; closeWalletModal(); } });
$('wallet').onclick = () => { if (session.wallet) { session.logout(); toast('Disconnected'); } else openWalletModal(); };

// ---------------------------------------------------------------- traders + podium
// ---------------------------------------------------------------- the mark: five interlaced rings
// Geometry traced from the PUMPICS logo.
const RING = { r: 227, w: 48, gap: 16 };
const INK = '#0b3a21'; // outline so the white rings read on the light background
const RINGS = { TL: [337, 334], TM: [899, 334], TR: [1461, 334], BL: [618, 556], BR: [1180, 556] };
const DRAW_ORDER = ['TL', 'TM', 'TR', 'BL', 'BR'];
const CROSSINGS = [['TL', 'BL'], ['TM', 'BL'], ['TM', 'BR'], ['TR', 'BR']]; // top ring passes over at the upper crossing
const LOGO_COLORS = { TL: '#2DE499', TM: '#FFFFFF', TR: '#2DE499', BL: '#FFFFFF', BR: '#2DE499' };
function upperCrossing(a, b) {
  const [x0, y0] = RINGS[a], [x1, y1] = RINGS[b], R = RING.r;
  const d = Math.hypot(x1 - x0, y1 - y0), l = d / 2, h = Math.sqrt(R * R - l * l);
  const mx = x0 + (x1 - x0) * l / d, my = y0 + (y1 - y0) * l / d;
  const p1 = [mx + h * (y1 - y0) / d, my - h * (x1 - x0) / d], p2 = [mx - h * (y1 - y0) / d, my + h * (x1 - x0) / d];
  return p1[1] < p2[1] ? p1 : p2;
}
function arcPath(name, pt, deg) {
  const [x, y] = RINGS[name], R = RING.r, th = Math.atan2(pt[1] - y, pt[0] - x), d = deg * Math.PI / 180;
  const f = (a) => `${(x + R * Math.cos(a)).toFixed(1)} ${(y + R * Math.sin(a)).toFixed(1)}`;
  return `M${f(th - d)}A${R} ${R} 0 0 1 ${f(th + d)}`;
}
function ringsSVG(colors, label = 'PUMPICS') {
  const gap = 'var(--pm-gap,#f3f8f4)', gw = RING.w + 2 * RING.gap;
  let out = '';
  for (const n of DRAW_ORDER) {
    const [x, y] = RINGS[n];
    out += `<circle cx="${x}" cy="${y}" r="${RING.r}" stroke="${gap}" stroke-width="${gw}" fill="none"/><circle cx="${x}" cy="${y}" r="${RING.r}" stroke="${INK}" stroke-width="${RING.w + 22}" fill="none"/><circle class="c-${n}" cx="${x}" cy="${y}" r="${RING.r}" stroke="${colors[n]}" stroke-width="${RING.w}" fill="none"/>`;
  }
  for (const [a, b] of CROSSINGS) {
    const pt = upperCrossing(a, b);
    out += `<path d="${arcPath(a, pt, 22)}" stroke="${gap}" stroke-width="${gw}" fill="none"/><path d="${arcPath(a, pt, 24)}" stroke="${INK}" stroke-width="${RING.w + 22}" fill="none"/><path class="c-${a}" d="${arcPath(a, pt, 26)}" stroke="${colors[a]}" stroke-width="${RING.w}" fill="none"/>`;
  }
  return `<svg viewBox="80 76 1640 762" role="img" aria-label="${label}">${out}</svg>`;
}

let T = [], byWallet = new Map(), BUDGET = 100, PAGE = 80;
let squad = [null, null, null, null, null];
let sortKey = 'p30', sortDir = -1, filter = 'All', q = '', shown = PAGE, scout = null;
let state = null, mine = null, clockSkew = 0, lbTab = 'live', lastLive = null, own = { total: 0, pct: {}, rarePct: 5, rareBonus: 1.5 }, rosterAt = null;
const pickPct = (w) => own.pct[w] || 0;
/* A trader counts as rare once there are enough squads for the % to mean something. */
const isRare = (w) => own.total >= Math.ceil(100 / own.rarePct) && pickPct(w) < own.rarePct;
const ago = (t) => { if (!t) return ''; const s = Math.max(0, Date.now() / 1000 - t); return s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };

const ini = (n) => { const c = [...String(n).replace(/[^\p{L}\p{N}]/gu, '')]; return (c.slice(0, 2).join('') || '?').toUpperCase(); };
const spent = () => squad.reduce((a, w) => a + (w ? byWallet.get(w).price : 0), 0);
const P = (t) => t.p30 ?? 0;

const AVBG = ['#c9f0d6', '#ffffff', '#e3f4e8', '#b6ebc9', '#f0faf3'];
const ORDER = [3, 1, 0, 2, 4]; /* left to right: 4th, 2nd, 1st, 3rd, 5th */
const MEDAL = ['#e9b52a', '#b7c2bc', '#d68a4c', '#cfe1d5', '#cfe1d5'];
function mascot(place, empty, face) {
  const m = MEDAL[place];
  if (empty) return `<svg viewBox="0 0 100 110" aria-hidden="true"><rect x="22" y="14" width="56" height="80" rx="28" fill="rgba(28,195,90,.06)" stroke="#9fc7ad" stroke-width="3" stroke-dasharray="7 6"/><text x="50" y="62" text-anchor="middle" font-family="Fredoka, sans-serif" font-weight="700" font-size="30" fill="#9fc7ad">+</text></svg>`;
  const eyes = face % 3 === 2 ? '<path d="M38 40 q4 -4 8 0" stroke="#0b3a21" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="60" cy="40" r="3.6" fill="#0b3a21"/>' : '<circle cx="41" cy="40" r="3.6" fill="#0b3a21"/><circle cx="59" cy="40" r="3.6" fill="#0b3a21"/>';
  const mouth = face % 2 ? '<path d="M44 49 q6 7 12 0" stroke="#0b3a21" stroke-width="3" fill="#e2566b" stroke-linecap="round"/>' : '<path d="M44 49 q6 5 12 0" stroke="#0b3a21" stroke-width="3" fill="none" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 100 110" aria-hidden="true"><path d="M24 66 q-14 -6 -12 -22" stroke="#0b3a21" stroke-width="2.5" fill="#1cc35a"/><path d="M76 66 q14 -6 12 -22" stroke="#0b3a21" stroke-width="2.5" fill="#1cc35a"/><path d="M22 56 V78 a28 28 0 0 0 56 0 V56 Z" fill="#1cc35a" stroke="#0b3a21" stroke-width="2.5"/><path d="M22 56 V42 a28 28 0 0 1 56 0 V56 Z" fill="#ffffff" stroke="#0b3a21" stroke-width="2.5"/><ellipse cx="36" cy="48" rx="4.5" ry="2.6" fill="#f6a6b2" opacity=".8"/><ellipse cx="64" cy="48" rx="4.5" ry="2.6" fill="#f6a6b2" opacity=".8"/>${eyes}${mouth}<path d="M40 57 L50 70 L60 57" stroke="#0b3a21" stroke-width="2" fill="none"/><circle cx="50" cy="78" r="10" fill="${m}" stroke="#0b3a21" stroke-width="2.5"/><text x="50" y="82.5" text-anchor="middle" font-family="Fredoka, sans-serif" font-weight="700" font-size="12" fill="#0b3a21">${place + 1}</text><rect x="34" y="100" width="12" height="7" rx="3.5" fill="#1cc35a" stroke="#0b3a21" stroke-width="2"/><rect x="54" y="100" width="12" height="7" rx="3.5" fill="#1cc35a" stroke="#0b3a21" stroke-width="2"/></svg>`;
}

function renderPodium() {
  const p = $('podium'); p.innerHTML = '';
  ORDER.forEach((i) => {
    const t = squad[i] ? byWallet.get(squad[i]) : null;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'spot p' + (i + 1); b.dataset.i = i;
    b.setAttribute('aria-label', t ? `${t.name} is your #${i + 1} pick. Tap to ${i === 0 ? 'remove' : 'make them #1'}` : `Empty #${i + 1} spot`);
    b.innerHTML = `<div class="mascot">${mascot(i, !t, t ? t.idx : 0)}</div><div class="tag-name">${t ? `<span class="n">${esc(t.name)}</span><span class="p num ${t.p30 == null ? '' : t.p30 >= 0 ? 'up' : 'down'}">${t.p30 == null ? 'Unranked' : fmt(t.p30, 0) + ' SOL'}</span>` : `<span class="pos">${i === 0 ? '#1 · 2×' : 'Spot ' + (i + 1)}</span>`}</div><div class="block">${i + 1}</div>`;
    b.onclick = () => spotClick(i); p.appendChild(b);
  });
}
function spotClick(i) {
  const w = squad[i]; if (!w) return toast('Pick a trader from the list');
  scout = w; renderScout();
  if (i !== 0) { [squad[0], squad[i]] = [squad[i], squad[0]]; toast(byWallet.get(w).name + ' is now your #1 pick (2× points)'); }
  else { squad[0] = null; toast(byWallet.get(w).name + ' removed'); }
  update();
}
function addTrader(w) {
  scout = w; renderScout();
  const at = squad.indexOf(w);
  if (at > -1) { squad[at] = null; update(); return toast(byWallet.get(w).name + ' removed'); }
  const free = squad.indexOf(null);
  if (free < 0) return toast('Your podium is full. Tap a mascot to remove someone');
  const t = byWallet.get(w);
  if (spent() + t.price > BUDGET) return toast(`That's ${spent() + t.price - BUDGET} credits over budget`);
  squad[free] = w; update();
  const el = $('podium').querySelector(`.spot[data-i="${free}"]`); if (el) el.classList.add('pop');
}

const FILTERS = { All: () => true, Month: (t) => t.p30 != null, Week: (t) => t.p7 != null, Today: (t) => t.p1 != null, Unranked: (t) => t.p30 == null && t.p7 == null && t.p1 == null };
const FLABEL = { All: 'All traders', Month: 'Best this month', Week: 'Best this week', Today: 'Best today', Unranked: 'Budget picks' };
function cmp(a, b) {
  if (sortKey === 'name') return a.name.localeCompare(b.name) * sortDir;
  if (sortKey === 'price') return (a.price - b.price) * sortDir || ((b.p30 ?? -1e9) - (a.p30 ?? -1e9));
  const x = a[sortKey], y = b[sortKey];
  if (x == null && y == null) return ((b.p7 ?? -1e9) - (a.p7 ?? -1e9)) || a.name.localeCompare(b.name);
  if (x == null) return 1; if (y == null) return -1; return (x - y) * sortDir;
}
function renderMarket() {
  const ql = q.toLowerCase();
  const list = T.filter((t) => FILTERS[filter](t) && (t.name + ' ' + (t.x || '') + ' ' + t.wallet).toLowerCase().includes(ql)).sort(cmp);
  $('count').textContent = T.length.toLocaleString('en-US');
  const cell = (v) => v == null ? '<span class="num nil">—</span>' : `<span class="num ${v >= 0 ? 'up' : 'down'}">${fmt(v)}</span>`;
  $('rows').innerHTML = list.slice(0, shown).map((t) => {
    const inS = squad.includes(t.wallet);
    return `<button type="button" class="row${inS ? ' in' : ''}" data-w="${t.wallet}" aria-label="${inS ? 'Remove' : 'Add'} ${esc(t.name)}, ${t.price} credits">
      <span class="who"><span class="av" style="background:${AVBG[t.idx % 5]}">${esc(ini(t.name)[0])}</span><span class="t"><b>${esc(t.name)}${t.rank && t.rank <= 10 ? ` <span class="medal">#${t.rank}</span>` : ''}${isRare(t.wallet) ? ` <span class="rare">Rare ×${own.rareBonus}</span>` : ''}</b><small class="num">${t.x ? '@' + esc(t.x) + ' · ' : ''}${pickPct(t.wallet) > 0 ? `${pickPct(t.wallet).toFixed(0)}% picked` : short(t.wallet)}</small></span></span>
      ${cell(t.p30)}<span class="c-7">${cell(t.p7)}</span>
      <span style="display:flex;align-items:center;justify-content:flex-end;gap:10px"><span class="num">${t.price}</span><span class="add">${inS ? '✓' : '+'}</span></span></button>`;
  }).join('') || '<div class="empty">No traders match that search.</div>';
  if (list.length > shown) $('rows').insertAdjacentHTML('beforeend', `<button type="button" class="more" id="more">Show ${Math.min(PAGE, list.length - shown)} more of ${list.length - shown}</button>`);
  $('rows').querySelectorAll('.row').forEach((r) => r.onclick = () => addTrader(r.dataset.w));
  const m = $('more'); if (m) m.onclick = () => { shown += PAGE; renderMarket(); };
}
function renderFilters() {
  $('styles').innerHTML = Object.keys(FILTERS).map((x) => `<button type="button" class="chip" aria-pressed="${x === filter}" data-s="${x}">${FLABEL[x]}</button>`).join('');
  $('styles').querySelectorAll('.chip').forEach((c) => c.onclick = () => { filter = c.dataset.s; shown = PAGE; renderFilters(); renderMarket(); });
}
function renderScout() {
  const t = scout && byWallet.get(scout); if (!t) { $('scout').innerHTML = ''; return; }
  const stat = (l, v, c) => `<div><div class="label">${l}</div><div class="num ${c || ''}" style="font-size:16px">${v}</div></div>`;
  const pv = (v) => v == null ? ['Not in top 50', ''] : [fmt(v, 2) + ' SOL', v >= 0 ? 'up' : 'down'];
  const live = lastLive && lastLive.traderPnl && lastLive.traderPnl[t.wallet];
  $('scout').innerHTML = `<div class="sc-top"><span class="av" style="background:${AVBG[t.idx % 5]};width:40px;height:40px;font-size:18px">${esc(ini(t.name)[0])}</span>
    <div style="min-width:0"><b style="font-size:16px">${esc(t.name)}</b><div class="sc-links">${t.x ? `<a href="https://x.com/${esc(t.x)}" target="_blank" rel="noopener">@${esc(t.x)}</a>` : '<span>No X linked</span>'}<a href="https://kolscan.io/account/${t.wallet}" target="_blank" rel="noopener">Kolscan</a><a href="https://solscan.io/account/${t.wallet}" target="_blank" rel="noopener">Solscan</a></div></div>
    <span class="price-tag num">${t.price} credits</span></div>
    <div class="sc-wallet"><code class="num" id="wfull">${t.wallet}</code><button type="button" class="chip" id="copyw">Copy</button></div>
    <div class="sc-stats">${stat('This hour', live == null ? '—' : fmt(live, 2) + ' SOL', live == null ? '' : live >= 0 ? 'up' : 'down')}${stat('Picked by', own.total ? pickPct(t.wallet).toFixed(1) + '%' + (isRare(t.wallet) ? ' · rare' : '') : 'No squads yet')}${stat('Profit · 30d', ...pv(t.p30))}${stat('Profit · 7d', ...pv(t.p7))}${stat('Wins / losses', t.w == null ? '—' : t.w.toLocaleString('en-US') + ' / ' + t.l.toLocaleString('en-US'))}</div>`;
  $('copyw').onclick = () => { const sel = () => { const r = document.createRange(); r.selectNodeContents($('wfull')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Wallet selected'); }; try { navigator.clipboard.writeText(t.wallet).then(() => toast('Wallet copied'), sel); } catch { sel(); } };
}

const sameSquad = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
function renderLock() {
  const sp = spent(), left = BUDGET - sp;
  $('left').textContent = left.toFixed(0);
  $('bfill').style.width = Math.min(100, sp / BUDGET * 100) + '%';
  $('bwrap').classList.toggle('over', left < 0);
  const tot = squad.reduce((a, w, i) => a + (w ? P(byWallet.get(w)) * (i === 0 ? 2 : 1) : 0), 0);
  $('proj').textContent = fmt(tot) + ' SOL'; $('proj').className = 'num ' + (tot >= 0 ? 'up' : 'down');
  $('capname').textContent = squad[0] ? byWallet.get(squad[0]).name : 'Nobody yet';
  const full = squad.every(Boolean);
  const entered = mine && mine.open;
  const same = entered && sameSquad(entered.picks, squad);
  const rid = state ? state.open.id : '';
  const st = $('entrystatus');
  if (entered && same) { st.className = 'status in'; st.textContent = `Entered for round ${entered.roundId}`; }
  else if (entered) { st.className = 'status dirty'; st.textContent = 'Changes not saved'; }
  else { st.className = 'status'; st.textContent = 'Not entered'; }
  const lock = $('lock');
  lock.disabled = !full || same || busy;
  lock.textContent = busy ? 'Check your wallet…' : same ? 'Entered ✓' : entered ? `Sign & update round ${rid}` : `Sign & enter round ${rid}`;
  const n = squad.filter((x) => !x).length;
  $('hint').textContent = !full ? `Pick ${n} more trader${n > 1 ? 's' : ''} to fill the podium. You have ${left} credits left.`
    : !session.wallet ? 'Squad ready. Connect a wallet to enter. Signing is free.'
    : same ? `You're in. Change your squad any time before round ${rid} starts.`
    : 'Squad ready. Signing proves this wallet is yours and costs nothing.';
}
function update() { renderPodium(); renderMarket(); renderLock(); store.set('pumpics-squad', squad); }

let busy = false;
async function lockIn() {
  if (!squad.every(Boolean)) return;
  if (!session.wallet) { pendingConnect = lockIn; openWalletModal(); return; }
  busy = true; renderLock();
  try {
    const wallet = session.wallet.address;
    const ch = await api('/entry/challenge', { wallet, picks: squad });
    const sigBytes = await session.wallet.signMessage(new TextEncoder().encode(ch.message));
    const res = await api('/entry', { wallet, nonce: ch.nonce, signature: b58(sigBytes) });
    toast(`You're in for round ${res.roundId}. Good luck!`, 3500);
    await loadPlayer();
    refresh();
  } catch (e) {
    toast(rejected(e) ? 'Signature cancelled in the wallet' : e.message || 'Something went wrong', 4200);
  } finally { busy = false; renderLock(); }
}
$('lock').onclick = lockIn;

$('clear').onclick = () => { squad = [null, null, null, null, null]; update(); };
$('auto').onclick = () => {
  // Varied on purpose: a weighted random pick among good-value traders, so Auto-pick squads don't all match.
  const pool = T.filter((t) => t.p30 != null || t.p7 != null).map((t) => ({ t, v: Math.max(0.01, (t.p30 ?? (t.p7 || 0) * 2) / t.price) }));
  const cheapest = [...pool].sort((a, b) => a.t.price - b.t.price);
  for (let attempt = 0; attempt < 40; attempt++) {
    squad = [null, null, null, null, null];
    const used = new Set();
    for (let i = 0; i < 5; i++) {
      const reserve = cheapest.filter((x) => !used.has(x.t.wallet)).slice(0, 4 - i).reduce((a, x) => a + x.t.price, 0);
      const ok = pool.filter((x) => !used.has(x.t.wallet) && spent() + x.t.price + reserve <= BUDGET);
      if (!ok.length) break;
      const total = ok.reduce((a, x) => a + Math.sqrt(x.v) * (isRare(x.t.wallet) ? 1.6 : 1), 0);
      let r = Math.random() * total, pick = ok[0];
      for (const x of ok) { r -= Math.sqrt(x.v) * (isRare(x.t.wallet) ? 1.6 : 1); if (r <= 0) { pick = x; break; } }
      squad[i] = pick.t.wallet; used.add(pick.t.wallet);
    }
    if (squad.every(Boolean)) break;
  }
  squad.sort((a, b) => (b ? P(byWallet.get(b)) : -1e9) - (a ? P(byWallet.get(a)) : -1e9));
  update(); toast('Auto-picked a fresh five. Tap again for another mix');
};
document.querySelectorAll('.mhead [data-sort]').forEach((b) => b.onclick = () => {
  const k = b.dataset.sort; if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === 'name' ? 1 : -1; }
  document.querySelectorAll('.mhead [data-sort]').forEach((x) => { x.classList.toggle('on', x.dataset.sort === sortKey); x.textContent = x.textContent.replace(/ [↑↓]$/, ''); });
  b.textContent += sortDir < 0 ? ' ↓' : ' ↑'; renderMarket();
});
$('q').oninput = (e) => { q = e.target.value.trim(); shown = PAGE; renderMarket(); };

// ---------------------------------------------------------------- live data
const nameOf = (w) => (byWallet.get(w) || {}).name || short(w);
function renderBoard() {
  if (!state) return;
  const tm = $('testmode');
  if (state.paused && state.paused.entries) { tm.textContent = 'Entries are paused for a moment. Your saved squad is safe.'; tm.classList.add('on'); }
  else if (state.payoutMode !== 'live') { tm.textContent = 'Test mode: winners are recorded, but no SOL is sent yet.'; tm.classList.add('on'); }
  else tm.classList.remove('on');
  const pot = state.pot.potLamports;
  $('pot').textContent = pot == null ? '–' : sol(pot);
  $('feed').innerHTML = state.pot.treasuryLamports == null ? 'Treasury unavailable right now'
    : `Paid from the <a href="https://solscan.io/account/${esc(state.treasury || '')}" target="_blank" rel="noopener">creator-fee treasury</a>`;
  $('roundlabel').textContent = `Round ${state.open.id} locks in`;
  $('entries').textContent = state.open.entries.toLocaleString('en-US');
  $('entriesnote').textContent = `for round ${state.open.id} · ${state.live.entries} playing this hour`;
}
function tickClock() {
  if (!state) return;
  const now = Date.now() / 1000 + clockSkew;
  const s = Math.max(0, Math.floor(state.open.start - now));
  const txt = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  $('clock').textContent = txt;
  document.querySelectorAll('[data-cd]').forEach((e) => { e.textContent = txt; });
  if (s === 0) refresh();
}
function renderLB(data) {
  const me = session.wallet && session.wallet.address;
  const rows = data.rows || [];
  if (lbTab === 'live') {
    const top = rows[0];
    $('topscore').textContent = top ? fmt(top.score, 2) : '–';
    $('topscore').className = 'big num ' + (top ? (top.score >= 0 ? 'up' : 'down') : '');
    $('topnote').textContent = top ? `SOL profit · ${short(top.wallet)}` : `No squads playing round ${state ? state.live.id : ''} yet`;
  }
  if (!rows.length) {
    $('lb').innerHTML = `<div class="empty">${lbTab === 'live' ? 'No squads are playing this hour yet. Lock one in for the next round.' : 'No settled rounds yet.'}</div>`;
  } else {
    const paid = new Map((data.payouts || []).map((p) => [p.wallet, p]));
    $('lb').innerHTML = rows.slice(0, 15).map((r, i) => {
      const p = paid.get(r.wallet);
      const prize = p ? (p.txSig ? `<a class="prize" href="https://solscan.io/tx/${esc(p.txSig)}" target="_blank" rel="noopener">Paid ${sol(p.lamports)} SOL ↗</a>` : `<span class="prize">${p.status === 'dry-run' ? 'Won (test)' : 'Paying…'} ${sol(p.lamports)}</span>`)
        : i === 0 && lbTab === 'live' && r.score > 0 ? '<span class="prize">Leading</span>' : '<span></span>';
      return `<div class="lb${i === 0 ? ' first' : ''}${r.wallet === me ? ' you' : ''}"><span class="rk">${r.rank}</span>
        <span class="mgr"><b>${r.wallet === me ? 'You' : esc(short(r.wallet))}</b><small>${r.picks.map(nameOf).map(esc).join(' · ')}</small></span>${prize}
        <span class="num ${r.score >= 0 ? 'up' : 'down'}">${fmt(r.score, 2)}</span></div>`;
    }).join('');
  }
  $('lbnote').textContent = lbTab === 'live' ? 'Live scores refresh every few minutes from Kolscan trade history. Final scores are taken a few minutes after the hour.'
    : data.round ? `Round ${data.round.id} · ${data.round.note || `${data.round.winners || 0} winner(s), ${sol(data.round.pot_lamports || 0)} SOL paid`}` : '';
}
document.querySelectorAll('#lbtabs .chip').forEach((c) => c.onclick = () => { lbTab = c.dataset.t; document.querySelectorAll('#lbtabs .chip').forEach((x) => x.setAttribute('aria-pressed', x === c)); loadLB(); });
async function loadLB() { try { const d = await api('/leaderboard/' + lbTab); if (lbTab === 'live') { lastLive = d; renderScout(); } renderLB(d); } catch {} }

function renderMine(data) {
  if (!data) { $('mine').innerHTML = '<div class="card empty">Connect a wallet to see your squads and winnings.</div>'; return; }
  const pk = (picks) => `<div class="picks">${picks.map((w) => `<span>${esc(nameOf(w))}</span>`).join('')}</div>`;
  let h = '';
  h += data.open ? `<div class="card"><h3>Round ${data.open.roundId} · starts in <span class="num" data-cd="1">${$('clock').textContent}</span></h3>${pk(data.open.picks)}</div>` : `<div class="card"><h3>Next round</h3><p class="note" style="margin:0">Not entered yet.</p></div>`;
  if (data.live) h += `<div class="card"><h3>Playing now · round ${data.live.roundId}</h3>${pk(data.live.picks)}</div>`;
  const past = data.history.filter((x) => x.rank != null);
  if (past.length) h += `<div class="card"><h3>Results</h3><div class="hist">${past.slice(0, 10).map((x) => `<div><span class="num">#${x.rank}</span><span>Round ${x.roundId} · <span class="num ${x.score >= 0 ? 'up' : 'down'}">${fmt(x.score, 2)}</span></span>${x.payoutLamports ? (x.txSig ? `<a class="prize" href="https://solscan.io/tx/${esc(x.txSig)}" target="_blank" rel="noopener">+${sol(x.payoutLamports)} SOL ↗</a>` : `<span class="prize">+${sol(x.payoutLamports)} ${x.payoutStatus === 'dry-run' ? '(test)' : '…'}</span>`) : '<span></span>'}</div>`).join('')}</div></div>`;
  $('mine').innerHTML = h;
}
async function loadPlayer() {
  if (!session.wallet) { mine = null; renderMine(null); renderLock(); return; }
  try { mine = await api('/player/' + session.wallet.address); renderMine(mine); } catch (e) { toast(e.message); }
  renderLock();
}

async function refresh() {
  try {
    const prevOpen = state && state.open.id;
    state = await api('/state');
    clockSkew = state.now - Date.now() / 1000;
    BUDGET = state.budget;
    renderBoard();
    if (prevOpen && prevOpen !== state.open.id) { loadPlayer(); toast(`Round ${state.live.id} has started`); }
    renderLock();
  } catch { $('feed').textContent = 'Reconnecting…'; }
  loadLB();
  try { own = await api('/ownership/open'); renderMarket(); } catch {}
}

// ---------------------------------------------------------------- boot
async function boot() {
  document.querySelectorAll('[data-logo]').forEach((el) => { el.outerHTML = ringsSVG(LOGO_COLORS); });
  const { traders, updatedAt } = await api('/traders');
  rosterAt = updatedAt;
  const cn = $('costnote'); if (cn && rosterAt) cn.textContent = `Costs updated ${ago(rosterAt)} from Kolscan's latest leaderboards.`;
  T = traders.map((t, idx) => ({ idx, wallet: t.wallet, name: t.name, x: t.x, p30: t.pnl30d, w: t.wins30d, l: t.losses30d, p7: t.pnl7d, p1: t.pnl24h, price: t.price, rank: t.rank30d }));
  byWallet = new Map(T.map((t) => [t.wallet, t]));
  const saved = store.get('pumpics-squad');
  if (Array.isArray(saved) && saved.length === 5) squad = saved.map((w) => (w && byWallet.has(w) ? w : null));
  renderFilters(); update(); await refresh();
  setInterval(refresh, 20000); setInterval(tickClock, 1000); tickClock();
  // Quietly reconnect a wallet the player already trusted.
  const last = store.get('pumpics-wallet');
  if (last) setTimeout(async () => { const w = Wallets.list().find((x) => x.name === last); if (w) { try { await session.use(w, { silent: true }); } catch {} } }, 400);
}
boot().catch((e) => { console.error(e); toast('Could not load PUMPICS. Refresh to try again.', 6000); });
window.__pumpics = { session, Wallets, b58 };
})();
