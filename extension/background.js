/*
 * AirPlay Any Video — background service worker.
 *
 *  - registers the MAIN-world page hook (scripting.registerContentScripts, Safari 16.4+),
 *  - keeps the latest report from every frame of every tab (for the popup + toolbar badge),
 *  - probes HLS playlists on behalf of content scripts (host permissions bypass CORS here),
 *  - relays popup commands to the frame that owns a video.
 */
importScripts('common/streams.js');

const B = globalThis.browser || globalThis.chrome;
const S = globalThis.AirPlayAny;
const HOOK_ID = 'airplay-any-page-hook';
const DEFAULT_SETTINGS = { showBadges: true, autoUnblock: true, pauseOriginal: true, deepCapture: true };

/** @type {Map<number, {frames: Map<number, any>, updatedAt: number}>} */
const tabState = new Map();

async function getSettings() {
  try {
    const r = await B.storage.local.get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, (r && r.settings) || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

let hookPromise = null;
function ensureHook() {
  if (hookPromise) return hookPromise;
  hookPromise = (async () => {
    const settings = await getSettings();
    const want = settings.deepCapture !== false;
    let existing = [];
    try { existing = await B.scripting.getRegisteredContentScripts({ ids: [HOOK_ID] }); } catch (e) { existing = []; }
    try {
      if (!want) {
        if (existing && existing.length) await B.scripting.unregisterContentScripts({ ids: [HOOK_ID] });
        await B.storage.local.set({ hookMode: 'off', hookError: '' });
        return 'off';
      }
      if (existing && existing.length) {
        await B.storage.local.set({ hookMode: 'main', hookError: '' });
        return 'main';
      }
      await B.scripting.registerContentScripts([{
        id: HOOK_ID,
        js: ['content/page-hook.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN',
        persistAcrossSessions: true,
      }]);
      await B.storage.local.set({ hookMode: 'main', hookError: '' });
      return 'main';
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/duplicate|already/i.test(msg)) {
        await B.storage.local.set({ hookMode: 'main', hookError: '' });
        return 'main';
      }
      // Safari without MAIN-world support: content.js falls back to a <script> tag; basic capture still works.
      await B.storage.local.set({ hookMode: 'unavailable', hookError: msg });
      return 'unavailable';
    }
  })().finally(() => { hookPromise = null; });
  return hookPromise;
}

try { B.runtime.onInstalled.addListener(() => { ensureHook(); }); } catch (e) {}
try { B.runtime.onStartup.addListener(() => { ensureHook(); }); } catch (e) {}
ensureHook();

// ---------------------------------------------------------------- state
function handleReport(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return;
  const tabId = tab.id;
  const frameId = sender.frameId == null ? 0 : sender.frameId;
  const now = Date.now();
  let st = tabState.get(tabId);
  if (st && msg.frame && msg.frame.isTop && msg.reset) {
    // A fresh top document: drop reports from the previous page (keep very recent child frames).
    for (const [fid, rep] of st.frames) if (fid !== frameId && now - rep.updatedAt > 1500) st.frames.delete(fid);
  }
  if (!st) { st = { frames: new Map(), updatedAt: 0 }; tabState.set(tabId, st); }
  st.frames.set(frameId, Object.assign({}, msg, { frameId, updatedAt: now }));
  st.updatedAt = now;
  updateBadge(tabId, st);
}

function updateBadge(tabId, st) {
  let count = 0;
  for (const rep of st.frames.values()) for (const v of rep.videos || []) if (v.playableNow) count++;
  try {
    const p = B.action.setBadgeText({ tabId, text: count ? String(count) : '' });
    if (p && p.catch) p.catch(() => {});
    if (count && B.action.setBadgeBackgroundColor) {
      const q = B.action.setBadgeBackgroundColor({ tabId, color: '#0a84ff' });
      if (q && q.catch) q.catch(() => {});
    }
  } catch (e) {}
}

try { B.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId)); } catch (e) {}
try {
  B.tabs.onUpdated.addListener((tabId, info) => {
    if (info && info.status === 'loading') {
      tabState.delete(tabId);
      try { const p = B.action.setBadgeText({ tabId, text: '' }); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
  });
} catch (e) {}

async function getTabState(tabId) {
  const st = tabState.get(tabId);
  const settings = await getSettings();
  let hookMode = 'unknown', hookError = '';
  try { const r = await B.storage.local.get(['hookMode', 'hookError']); hookMode = (r && r.hookMode) || 'unknown'; hookError = (r && r.hookError) || ''; } catch (e) {}
  const frames = st ? [...st.frames.values()].sort((a, b) => a.frameId - b.frameId) : [];
  return { tabId, frames, hookMode, hookError, settings };
}

// ---------------------------------------------------------------- probe
const probeCache = new Map();
async function probe(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return { ok: false, error: 'bad-url' };
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'include', redirect: 'follow' });
    const contentType = r.headers.get('content-type') || '';
    let body = null;
    if (r.ok && S.isTextManifest(r.url || url, contentType)) {
      const text = await r.text();
      body = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text;
    }
    res = { ok: r.ok, status: r.status, contentType, body, finalUrl: r.url || url };
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
  probeCache.set(url, { at: Date.now(), res });
  if (probeCache.size > 300) { const first = probeCache.keys().next().value; probeCache.delete(first); }
  return res;
}

// ---------------------------------------------------------------- relay
function relay(msg) {
  const opts = msg.frameId != null ? { frameId: msg.frameId } : undefined;
  return opts ? B.tabs.sendMessage(msg.tabId, msg.payload, opts) : B.tabs.sendMessage(msg.tabId, msg.payload);
}

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'report':
      handleReport(msg, sender);
      sendResponse({ ok: true });
      return;
    case 'probe':
      probe(msg.url).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'getTabState':
      getTabState(msg.tabId).then(sendResponse, (e) => sendResponse({ tabId: msg.tabId, frames: [], error: String(e) }));
      return true;
    case 'command':
      Promise.resolve().then(() => relay(msg)).then(
        (r) => sendResponse(r == null ? { ok: true } : r),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    case 'settingsChanged':
      ensureHook().then((mode) => sendResponse({ ok: true, hookMode: mode }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'openStream': {
      const index = sender && sender.tab && sender.tab.index != null ? sender.tab.index + 1 : undefined;
      Promise.resolve().then(() => B.tabs.create(index == null ? { url: msg.url } : { url: msg.url, index })).then(
        () => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    default:
      return;
  }
});
