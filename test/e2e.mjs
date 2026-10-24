/*
 * End-to-end check of the extension in Chromium (Playwright).
 * Chromium has no AirPlay API; the content script still has to detect videos, capture streams,
 * unblock players, draw badges, build the panel, start the proxy player and *attempt* the picker
 * (observable through the `airplay-any:picker` DOM event). The Safari-only part — the actual
 * device picker — is exercised on a real device (see README).
 */
import { createRequire } from 'node:module';
// Resolve playwright with CommonJS rules so a globally installed copy (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const results = [];
function step(name, fn) { return (async () => { try { await fn(); results.push(['ok', name]); console.log('  ✓', name); } catch (e) { results.push(['fail', name, e]); console.log('  ✗', name, '\n    ', String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); } })(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 8000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + label);
    await sleep(interval);
  }
}

const { server, origin } = await startServer(0);
const userDir = await mkdtemp(path.join(os.tmpdir(), 'apa-'));
const context = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1100, height: 900 },
});
let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id', extId);

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
await page.goto(origin + '/index.html');
await page.waitForFunction(() => window.__ready === true);

const host = page.locator('airplay-any-host');
// Badges only exist for videos that are on screen (IntersectionObserver), so scroll the video into view first.
const badgeFor = async (id) => {
  await page.evaluate((id) => { const v = document.getElementById(id); if (v) v.scrollIntoView({ block: 'center' }); }, id);
  await sleep(250);
  return page.evaluate((id) => {
  const v = document.getElementById(id);
  const host = document.querySelector('airplay-any-host');
  if (!v || !host) return null;
  const r = v.getBoundingClientRect();
  const badges = [...host.shadowRoot.querySelectorAll('.apa-badge')].filter((b) => b.style.display !== 'none');
  for (const b of badges) {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(b.style.transform || '');
    if (!m) continue;
    const x = +m[1], y = +m[2];
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b.getAttribute('data-apa-id');
  }
  return null;
  }, id);
};

await step('overlay host + badges appear for the three big videos and the late one', async () => {
  await waitFor(() => host.count(), { label: 'host' });
  await waitFor(async () => (await badgeFor('native')) && (await badgeFor('mse')) && (await badgeFor('dash')), { label: 'badges' });
  await waitFor(() => badgeFor('late'), { label: 'late badge' });
  assert.equal(await badgeFor('tiny'), null, 'tiny video must not get a badge');
});

await step('auto-unblock removed the AirPlay restrictions on the native player', async () => {
  await waitFor(() => page.evaluate(() => { const v = document.getElementById('native'); return !v.hasAttribute('disableremoteplayback') && v.getAttribute('x-webkit-airplay') === 'allow' && v.disableRemotePlayback === false; }), { label: 'unblock' });
});

await step('MAIN-world hook is alive and HLS master was captured and probed (1080p)', async () => {
  // Ask the content script directly for its state (same path the popup uses, minus the popup).
  const tabId = await sw.evaluate(async () => { const tabs = await chrome.tabs.query({}); const t = tabs.find((x) => x.url && x.url.includes('/index.html')); return t ? t.id : null; });
  assert.ok(tabId != null, 'tab id');
  globalThis.__tabId = tabId;
  const rep = await waitFor(async () => {
    const r = await sw.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: 'getState' }, { frameId: 0 }), tabId);
    if (!r || !r.hookAlive) return null;
    const master = r.streams.find((s) => s.url.endsWith('/hls/master.m3u8'));
    if (!master || master.kind !== 'hls-master' || master.resolution !== '1080p') return null;
    return r;
  }, { label: 'report with probed master', timeout: 10000 });
  assert.equal(rep.streams[0].url, origin + '/hls/master.m3u8', 'master ranks first');
  const kinds = Object.fromEntries(rep.streams.map((s) => [s.url.replace(origin, ''), s.kind]));
  assert.equal(kinds['/hls/1080p/index.m3u8'], 'hls-media');
  assert.equal(kinds['/dash/manifest.mpd'], 'dash');
  assert.equal(kinds['/hls/1080p/seg0.ts'], 'segment');
  assert.equal(kinds['/media/clip.mp4'], 'mp4', 'element source with a known extension keeps its kind');
  const mse = rep.videos.find((v) => v.isBlob && v.strategy === 'proxy');
  assert.ok(mse, 'blob video plans to use the proxy');
  assert.equal(mse.best.url, origin + '/hls/master.m3u8');
  const native = rep.videos.find((v) => v.directUrl === origin + '/media/clip.mp4');
  assert.equal(native.strategy, 'element');
  assert.equal(native.unblocked, true);
});

await step('badge opens the panel for the MSE video; master playlist row is first and marked best', async () => {
  const id = await badgeFor('mse');
  await host.locator(`.apa-badge[data-apa-id="${id}"]`).click();
  const panel = host.locator('.apa-panel');
  await panel.waitFor({ timeout: 5000 });
  assert.equal(await panel.locator('.apa-primary').getAttribute('data-apa-primary'), 'proxy');
  const rows = panel.locator('.apa-row');
  assert.equal(await rows.first().getAttribute('data-apa-kind'), 'hls-master');
  assert.ok((await rows.first().getAttribute('class')).includes('best'));
  assert.ok((await rows.first().locator('.apa-tag.res').textContent()).includes('1080p'));
  const dashRow = panel.locator('.apa-row[data-apa-kind="dash"]');
  assert.equal(await dashRow.count(), 1);
  assert.ok((await dashRow.getAttribute('class')).includes('dim'));
});

await step('primary action starts the proxy player with the master playlist, pauses the page player and asks for the picker', async () => {
  await page.evaluate(() => { const v = document.getElementById('mse'); v.play().catch(() => {}); });
  await host.locator('.apa-panel .apa-primary').click();
  const proxy = host.locator('.apa-proxy');
  await waitFor(() => proxy.evaluate((el) => el.style.display !== 'none'), { label: 'proxy visible' });
  const src = await proxy.locator('video').evaluate((v) => v.getAttribute('src'));
  assert.equal(src, origin + '/hls/master.m3u8');
  const calls = await page.evaluate(() => window.__pickerCalls || []);
  assert.ok(calls.some((c) => c.src === origin + '/hls/master.m3u8'), 'picker attempted for proxy video: ' + JSON.stringify(calls));
  assert.equal(await page.evaluate(() => document.getElementById('mse').paused), true, 'page player paused');
  assert.equal(await host.locator('.apa-panel [data-apa-action="stop"]').count(), 1, 'stop button appears');
});

await step('stop returns to the page player and hides the proxy', async () => {
  await host.locator('.apa-panel [data-apa-action="stop"]').click();
  await waitFor(() => host.locator('.apa-proxy').evaluate((el) => el.style.display === 'none'), { label: 'proxy hidden' });
  await waitFor(() => page.evaluate(() => !document.getElementById('mse').paused), { label: 'page player resumed' });
  await page.keyboard.press('Escape');
  await waitFor(async () => (await host.locator('.apa-panel').count()) === 0, { label: 'panel closed' });
});

await step('native player: primary action AirPlays the element itself (strategy element)', async () => {
  const id = await badgeFor('native');
  await host.locator(`.apa-badge[data-apa-id="${id}"]`).click();
  const panel = host.locator('.apa-panel');
  await panel.waitFor();
  assert.equal(await panel.locator('.apa-primary').getAttribute('data-apa-primary'), 'element');
  await panel.locator('.apa-primary').click();
  const calls = await page.evaluate(() => window.__pickerCalls || []);
  assert.ok(calls.some((c) => c.src === origin + '/media/clip.mp4'), 'picker attempted for the page element: ' + JSON.stringify(calls));
  await page.keyboard.press('Escape');
});

await step('a stream row can be sent to the proxy explicitly', async () => {
  const id = await badgeFor('dash');
  await host.locator(`.apa-badge[data-apa-id="${id}"]`).click();
  const panel = host.locator('.apa-panel');
  await panel.waitFor();
  await panel.locator(`.apa-row[data-apa-url="${origin}/hls/1080p/index.m3u8"] .apa-ib.play`).click();
  const src = await host.locator('.apa-proxy video').evaluate((v) => v.getAttribute('src'));
  assert.equal(src, origin + '/hls/1080p/index.m3u8');
  await host.locator('.apa-panel [data-apa-action="stop"]').click();
  await page.keyboard.press('Escape');
});

await step('video inside a shadow root attached after load gets a badge', async () => {
  await page.evaluate(() => document.getElementById('shadow-host').scrollIntoView({ block: 'center' }));
  await waitFor(() => page.evaluate(() => {
    const hostEl = document.getElementById('shadow-host');
    const v = hostEl && hostEl.shadowRoot && hostEl.shadowRoot.getElementById('sv');
    const h = document.querySelector('airplay-any-host');
    if (!v || !h) return false;
    const r = v.getBoundingClientRect();
    return [...h.shadowRoot.querySelectorAll('.apa-badge')].some((b) => {
      if (b.style.display === 'none') return false;
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(b.style.transform || '');
      return m && +m[1] >= r.left && +m[1] <= r.right && +m[2] >= r.top && +m[2] <= r.bottom;
    });
  }), { label: 'shadow video badge', timeout: 10000 });
});

await step('video inside an iframe gets its own badge', async () => {
  const frame = page.frames().find((f) => f.url().endsWith('/frame.html'));
  assert.ok(frame, 'frame found');
  await page.evaluate(() => document.getElementById('frame').scrollIntoView({ block: 'center' }));
  await waitFor(() => frame.evaluate(() => { const h = document.querySelector('airplay-any-host'); return h && [...h.shadowRoot.querySelectorAll('.apa-badge')].some((b) => b.style.display !== 'none'); }), { label: 'frame badge' });
});

await step('popup lists videos (incl. the frame) and streams, and its AirPlay button reaches the page', async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${globalThis.__tabId}`);
  await waitFor(async () => (await popup.locator('.card').count()) >= 5, { label: 'popup cards (4 top + 1 frame)' });
  assert.ok(await popup.locator('#hook').textContent(), 'hook status shown');
  const frameCards = await popup.locator('.card[data-frame-id]:not([data-frame-id="0"])').count();
  assert.equal(frameCards, 1, 'one card from the iframe');
  const first = popup.locator('.stream').first();
  assert.ok((await first.locator('.kind').textContent()).length > 0);
  assert.ok((await first.locator('.url').getAttribute('title')).endsWith('/hls/master.m3u8'), 'master playlist first in popup');
  const before = (await page.evaluate(() => (window.__pickerCalls || []).length));
  const mseCard = popup.locator('.card').filter({ hasText: 'master.m3u8' }).first();
  await mseCard.locator('button.primary').click();
  await waitFor(() => page.evaluate((n) => (window.__pickerCalls || []).length > n, before), { label: 'picker via popup' });
  await popup.locator('#s-showBadges').uncheck();
  await waitFor(() => page.evaluate(() => { const h = document.querySelector('airplay-any-host'); return [...h.shadowRoot.querySelectorAll('.apa-badge')].every((b) => b.style.display === 'none'); }), { label: 'badges hidden by setting' });
  await popup.locator('#s-showBadges').check();
  await waitFor(() => badgeFor('mse'), { label: 'badges back' });
  await popup.close();
});

await step('no uncaught errors from the extension on the page', async () => {
  const ours = consoleErrors.filter((e) => /airplay|apa-|content\.js|page-hook/i.test(e));
  assert.deepEqual(ours, []);
});

await context.close();
await rm(userDir, { recursive: true, force: true });
server.close();
const failed = results.filter((r) => r[0] === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
