'use strict';
/** Browser tests: the admin panel and the new player-facing features (pick %, rare badges, varied Auto-pick, pause notice). */
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
const TOKEN = 'e2e-admin-token-123';

let browser, srv;
test.before(async () => { srv = await startTestServer(); browser = await chromium.launch({ executablePath: EXE }); });
test.after(async () => { await browser?.close(); srv?.server.close(); });

async function open(url, viewport = { width: 1360, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.url().startsWith(srv.url) && r.status() >= 500) errors.push(r.status() + ' ' + r.url()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, context, errors };
}
function signedEntry(picks) {
  const kp = nacl.sign.keyPair(); const wallet = bs58.encode(kp.publicKey);
  return fetch(srv.url + '/api/entry/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet, picks }) })
    .then((r) => r.json()).then((ch) => fetch(srv.url + '/api/entry', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, nonce: ch.nonce, signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey)) }) }).then((r) => r.json()));
}

test('admin panel: wrong token is refused, right token opens it, pausing entries shows on the site', async () => {
  const { page, context, errors } = await open(srv.url + '/admin');
  await page.fill('#tok', 'wrong-token-value');
  await page.click('#gate button[type=submit]');
  await page.waitForFunction(() => /Wrong admin token/.test(document.querySelector('#gerr').textContent));
  await page.fill('#tok', TOKEN);
  await page.click('#gate button[type=submit]');
  await page.waitForSelector('#panel:not([hidden]) #rounds tr');
  assert.equal(await page.locator('#mode').textContent(), 'Live');
  assert.match(await page.locator('#treasury').textContent(), /^50\.00 SOL$/);
  assert.match(await page.locator('#rosterCount').textContent(), /514 traders/);

  await page.click('#tEntries');
  await page.waitForFunction(() => document.querySelector('#pEntries').textContent === 'paused');
  const site = await open(srv.url + '/');
  await site.page.waitForFunction(() => /Entries are paused/.test(document.querySelector('#testmode').textContent));
  await site.context.close();
  await page.click('#tEntries');
  await page.waitForFunction(() => document.querySelector('#pEntries').textContent === 'open');
  assert.match(await page.locator('#log').textContent(), /Entries paused/);
  await page.screenshot({ path: path.join(SHOTS, 'admin.png'), fullPage: true });

  // stays signed in across a reload (session only)
  await page.reload();
  await page.waitForSelector('#panel:not([hidden])');
  await page.click('#logout');
  assert.equal(await page.locator('#gate').isVisible(), true);
  assert.deepEqual(errors.filter((e) => !/403/.test(e)), []);
  await context.close();
});

test('admin panel: void a round with a two-step confirm', async () => {
  const picks = srv.ctx.roster.list.filter((t) => t.price === 4).slice(10, 15).map((t) => t.wallet);
  const entry = await signedEntry(picks);
  assert.ok(entry.ok, JSON.stringify(entry));
  const { page, context } = await open(srv.url + '/admin');
  await page.fill('#tok', TOKEN); await page.click('#gate button[type=submit]');
  const btn = page.locator(`[data-void="${entry.roundId}"]`);
  await btn.waitFor();
  await btn.click();
  assert.equal(await btn.textContent(), 'Confirm void');
  await btn.click();
  await page.waitForFunction((id) => [...document.querySelectorAll('#rounds tr')].some((tr) => tr.textContent.includes(String(id)) && /voided/.test(tr.textContent)), entry.roundId);
  await context.close();
});

test('site: pick percentages and rare badges show once squads are in; Auto-pick varies', async () => {
  const cheap = srv.ctx.roster.list.filter((t) => t.price === 4).map((t) => t.wallet);
  srv.ctx.clock.add(3600); // the previous test voided the open round; move on to a fresh one
  for (let i = 0; i < 21; i++) await signedEntry(cheap.slice(30, 35)); // a crowd on the same five
  const { page, context, errors } = await open(srv.url + '/');
  await page.waitForFunction(() => /Rare ×1\.5/.test(document.querySelector('#rows').textContent), null, { timeout: 8000 });
  await page.fill('#q', srv.ctx.roster.list.find((t) => t.wallet === cheap[30]).name);
  await page.waitForFunction(() => /100% picked/.test(document.querySelector('#rows').textContent));
  await page.fill('#q', '');
  await page.waitForFunction(() => /Rare ×1\.5/.test(document.querySelector('#rows').textContent));
  const squads = new Set();
  for (let i = 0; i < 6; i++) { await page.click('#auto'); squads.add(await page.evaluate(() => [...document.querySelectorAll('.spot .n')].map((n) => n.textContent).sort().join('|'))); }
  assert.ok(squads.size >= 3, `Auto-pick gave only ${squads.size} different squads in 6 tries`);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.spot .n').length), 5);
  assert.match(await page.locator('#costnote').textContent(), /Costs updated|^$/);
  await page.screenshot({ path: path.join(SHOTS, 'market-ownership.png') });
  assert.deepEqual(errors, []);
  await context.close();
});
