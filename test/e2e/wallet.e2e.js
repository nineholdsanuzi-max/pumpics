'use strict';
/**
 * Browser end-to-end tests in headless Chromium.
 * A test wallet is injected the same way real wallets inject themselves:
 *   - "Wallet Standard" registration (how Phantom, Solflare, Backpack announce today)
 *   - the legacy window.phantom.solana provider
 * Signatures are real ed25519 signatures made with a test keypair.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { startTestServer } = require('./server');

const EXE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

function testWallet() {
  const kp = nacl.sign.keyPair();
  return { address: bs58.encode(kp.publicKey), sign: (bytes) => Array.from(nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey)) };
}

/** Injected into the page before any site code runs. */
function injectWallet({ address, mode, reject }) {
  const pk = { toString: () => address, toBase58: () => address };
  const sign = async (bytes) => {
    if (reject) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
    return new Uint8Array(await window.__nodeSign(Array.from(bytes)));
  };
  if (mode === 'standard') {
    const account = { address, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: ['solana:signMessage'] };
    const wallet = {
      version: '1.0.0', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      chains: ['solana:mainnet', 'solana:devnet'], accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: async (o) => { window.__connects = (window.__connects || 0) + 1; window.__silent = !!(o && o.silent); wallet.accounts = [account]; return { accounts: [account] }; } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signMessage': { version: '1.0.0', signMessage: async ({ message }) => [{ signedMessage: message, signature: await sign(message) }] },
      },
    };
    const register = (api) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
    try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch {}
  } else if (mode === 'legacy') {
    const provider = { isPhantom: true, publicKey: null, connect: async () => { provider.publicKey = pk; return { publicKey: pk }; }, disconnect: async () => {}, on: () => {}, off: () => {}, signMessage: async (b) => ({ signature: await sign(b), publicKey: pk }) };
    window.phantom = { solana: provider };
  }
}

async function newPage(browser, url, wallet, opts = {}) {
  const context = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The test sandbox has no internet, so Google Fonts cannot load; every same-origin request must succeed.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('requestfailed', (r) => { if (r.url().startsWith(url)) errors.push('request failed: ' + r.url()); });
  page.on('response', (r) => { if (r.url().startsWith(url) && r.status() >= 400) errors.push(r.status() + ' ' + r.url()); });
  if (wallet) {
    await page.exposeFunction('__nodeSign', (bytes) => wallet.sign(bytes));
    await page.addInitScript(injectWallet, { address: wallet.address, mode: opts.mode || 'standard', reject: !!opts.reject });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#rows .row');
  return { page, context, errors };
}
const post = (url, p, body) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const toastText = (page) => page.waitForFunction(() => document.querySelector('#toast.on')?.textContent).then((h) => h.jsonValue());

let browser, srv;
test.before(async () => { srv = await startTestServer(); browser = await chromium.launch({ executablePath: EXE }); });
test.after(async () => { await browser?.close(); srv?.server.close(); });

test('site loads with the full roster, live state and no console errors', async () => {
  const { page, context, errors } = await newPage(browser, srv.url);
  assert.equal(await page.locator('#count').textContent(), '514');
  assert.match(await page.locator('#pot').textContent(), /^\d/);
  assert.match(await page.locator('#roundlabel').textContent(), /Round \d+ locks in/);
  assert.match(await page.locator('#clock').textContent(), /^\d\d:\d\d$/);
  assert.equal(await page.locator('#testmode').isVisible(), false, 'live payouts: no test banner');
  await page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});

test('Wallet Standard wallet: connect, sign, enter, win, get paid on-chain, auto-reconnect', async () => {
  const w = testWallet();
  const { page, context, errors } = await newPage(browser, srv.url, w);
  await page.click('#auto');
  assert.equal(await page.locator('.spot .n').count(), 5);
  await page.click('#lock');                                   // not connected: opens the wallet picker
  await page.waitForSelector('#wmodal:not([hidden]) .wopt');
  assert.match(await page.locator('#wlist').textContent(), /Test Wallet/);
  await page.screenshot({ path: path.join(SHOTS, 'wallet-picker.png') });
  await page.click('#wlist .wopt');                            // connect, then the entry continues automatically
  await page.waitForFunction(() => /Entered for round/.test(document.querySelector('#entrystatus').textContent), null, { timeout: 10000 });
  assert.match(await page.locator('#wallet').textContent(), new RegExp(w.address.slice(0, 4)));
  assert.equal(await page.locator('#lock').textContent(), 'Entered ✓');
  assert.match(await page.locator('#mine').textContent(), /Round \d+ · starts in/);

  // Server agrees the entry is real and signed by this wallet.
  const me = await fetch(`${srv.url}/api/player/${w.address}`).then((r) => r.json());
  assert.equal(me.open.picks.length, 5);
  const picks = me.open.picks;

  // Changing the squad shows unsaved changes; re-signing updates it.
  await page.click('.spot.p2');                                // move #2 to #1
  assert.match(await page.locator('#entrystatus').textContent(), /Changes not saved/);
  await page.click('#lock');
  await page.waitForFunction(() => /Entered for round/.test(document.querySelector('#entrystatus').textContent));
  const me2 = await fetch(`${srv.url}/api/player/${w.address}`).then((r) => r.json());
  assert.equal(me2.open.picks[0], picks[1]);

  // Play the round: the #1 pick makes +2 SOL during the hour.
  const R = srv.ctx.R, start = me2.open.roundId * R;
  await post(srv.url, '/__test/trades', { wallet: me2.open.picks[0], start: start + 120, cost: 1, proceeds: 3 });
  await post(srv.url, '/__test/clock', { set: start + 60 });
  await post(srv.url, '/__test/tick');
  await page.reload(); await page.waitForSelector('#rows .row');
  await page.waitForFunction(() => /Playing now/.test(document.querySelector('#mine').textContent), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__silent), true, 'reconnected silently after reload');

  await post(srv.url, '/__test/clock', { set: start + R + 301 });
  await post(srv.url, '/__test/tick');
  const bal = await fetch(`${srv.url}/__test/balance/${w.address}`).then((r) => r.json());
  assert.ok(bal.lamports > 0, 'winner wallet received SOL');

  await page.click('#lbtabs [data-t="last"]');
  await page.waitForFunction(() => /Paid .* SOL/.test(document.querySelector('#lb').textContent));
  const href = await page.locator('#lb a.prize').getAttribute('href');
  assert.match(href, /^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  await page.evaluate(() => document.querySelector('#refresh-mine') || null);
  await page.reload(); await page.waitForSelector('#rows .row');
  await page.waitForFunction(() => /Results/.test(document.querySelector('#mine').textContent), null, { timeout: 5000 });
  assert.match(await page.locator('#mine').textContent(), /#1/);
  await page.screenshot({ path: path.join(SHOTS, 'after-win.png'), fullPage: true });

  await page.click('#wallet');                                 // disconnect
  assert.equal(await page.locator('#wallet').textContent(), 'Connect wallet');
  assert.deepEqual(errors, []);
  await context.close();
});

test('legacy Phantom provider (window.phantom.solana) also works', async () => {
  const w = testWallet();
  const { page, context, errors } = await newPage(browser, srv.url, w, { mode: 'legacy' });
  await page.click('#wallet');
  await page.waitForSelector('#wmodal:not([hidden]) .wopt');
  assert.match(await page.locator('#wlist').textContent(), /Phantom/);
  await page.click('#wlist .wopt');
  await page.waitForFunction(() => document.querySelector('#wallet').classList.contains('on'));
  await page.click('#auto'); await page.click('#lock');
  await page.waitForFunction(() => /Entered for round/.test(document.querySelector('#entrystatus').textContent), null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('cancelling the signature in the wallet shows a clear message and enters nothing', async () => {
  const w = testWallet();
  const { page, context } = await newPage(browser, srv.url, w, { reject: true });
  await page.click('#auto'); await page.click('#lock');
  await page.click('#wlist .wopt');
  await page.waitForFunction(() => /cancelled/i.test(document.querySelector('#toast.on')?.textContent || ''));
  const me = await fetch(`${srv.url}/api/player/${w.address}`).then((r) => r.json());
  assert.equal(me.open, null);
  assert.equal(await page.locator('#lock').isDisabled(), false, 'can try again');
  await context.close();
});

test('no wallet installed: desktop gets install links, phones get open-in-wallet links', async () => {
  const d = await newPage(browser, srv.url, null);
  await d.page.click('#wallet');
  const links = await d.page.locator('#wlist a').evaluateAll((as) => as.map((a) => a.href));
  assert.deepEqual(links.map((h) => new URL(h).host), ['phantom.com', 'solflare.com', 'backpack.app']);
  await d.context.close();

  const m = await newPage(browser, srv.url, null, { mobile: true });
  await m.page.click('#wallet');
  const mlinks = await m.page.locator('#wlist a').evaluateAll((as) => as.map((a) => a.href));
  assert.match(mlinks[0], /^https:\/\/phantom\.app\/ul\/browse\/http/);
  assert.match(mlinks[1], /^https:\/\/solflare\.com\/ul\/v1\/browse\/http/);
  await m.page.keyboard.press('Escape');
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px on a phone`);
  await m.page.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
  await m.context.close();
});

test('server rejects an entry when the wallet signs a different squad than it submits', async () => {
  const w = testWallet();
  const picks = srv.ctx.roster.list.filter((t) => t.price === 4).slice(0, 5).map((t) => t.wallet);
  const ch = await post(srv.url, '/api/entry/challenge', { wallet: w.address, picks });
  const forged = ch.message.replace(picks[0], picks[1]);
  const sig = bs58.encode(Uint8Array.from(w.sign(Array.from(new TextEncoder().encode(forged)))));
  const res = await fetch(srv.url + '/api/entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: w.address, nonce: ch.nonce, signature: sig }) });
  assert.equal(res.status, 401);
});
