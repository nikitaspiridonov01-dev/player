/* AirPlay Any Video — toolbar popup */
(() => {
  'use strict';
  const B = globalThis.browser || globalThis.chrome;
  const S = globalThis.AirPlayAny;
  const UA = navigator.userAgent || '';
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const $ = (sel) => document.querySelector(sel);

  function t(key, sub) {
    let s = '';
    try { s = B.i18n.getMessage(key, sub == null ? undefined : [String(sub)]); } catch (e) {}
    return s || key;
  }
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v != null) el.setAttribute(k, v);
    }
    for (const c of children) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        const p = B.runtime.sendMessage(msg, (r) => {
          const err = B.runtime.lastError;
          if (err) reject(new Error(err.message)); else resolve(r);
        });
        if (p && p.then) p.then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }

  document.querySelectorAll('[data-i18n]').forEach((el) => { const m = t(el.getAttribute('data-i18n')); if (m && m !== el.getAttribute('data-i18n')) el.textContent = m; });
  try { $('#version').textContent = 'v' + B.runtime.getManifest().version; } catch (e) {}
  if (IS_IOS) $('#ios-hint').hidden = false;

  let currentTabId = null;
  async function activeTabId() {
    const q = new URLSearchParams(location.search).get('tabId');
    if (q) return Number(q);
    const tabs = await B.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0].id : null;
  }

  // ---- settings ----
  const SETTING_KEYS = ['showBadges', 'autoUnblock', 'pauseOriginal', 'deepCapture'];
  let settings = { showBadges: true, autoUnblock: true, pauseOriginal: true, deepCapture: true };
  function renderSettings() { for (const k of SETTING_KEYS) { const el = $('#s-' + k); if (el) el.checked = settings[k] !== false; } }
  for (const k of SETTING_KEYS) {
    const el = $('#s-' + k);
    if (!el) continue;
    el.addEventListener('change', async () => {
      settings[k] = el.checked;
      try { await B.storage.local.set({ settings }); } catch (e) {}
      if (k === 'deepCapture') { try { await send({ type: 'settingsChanged' }); } catch (e) {} setTimeout(() => load(false), 300); }
    });
  }

  // ---- render ----
  function tags(c) {
    const f = document.createDocumentFragment();
    if (c.resolution) f.append(' ', h('span', { class: 'tag res' }, t('upTo', c.resolution)));
    if (c.live) f.append(' ', h('span', { class: 'tag' }, 'LIVE'));
    if (c.encrypted) f.append(' ', h('span', { class: 'tag warn' }, 'AES'));
    return f;
  }
  function kindLabel(kind) { return t(S.kindMessageKey(kind)); }
  function statusLine(v, rep) {
    if (!rep.hasPicker) return { text: t('statusNoApi'), ok: false };
    if (v.wireless) return { text: t('statusConnected'), ok: true };
    if (v.availability === 'available') return { text: t('statusAvailable'), ok: true };
    if (v.availability === 'unavailable') return { text: t('statusUnavailable'), ok: false };
    return { text: t('statusUnknown'), ok: false };
  }

  function render(state, tabId) {
    const videosBox = $('#videos'), streamsBox = $('#streams');
    videosBox.textContent = ''; streamsBox.textContent = '';
    if (state && state.settings) { settings = Object.assign(settings, state.settings); renderSettings(); }
    const hook = $('#hook');
    if (!state) { hook.textContent = ''; videosBox.append(h('div', { class: 'empty' }, t('popupNoTab'))); return; }
    hook.textContent = state.hookMode === 'main' ? t('popupHookOn') : (state.hookMode === 'off' ? '' : t('popupHookOff'));

    const frames = state.frames || [];
    let n = 0;
    for (const rep of frames) {
      for (const v of rep.videos || []) {
        n++;
        const st = statusLine(v, rep);
        const card = h('div', { class: 'card', 'data-video-id': v.id, 'data-frame-id': rep.frameId });
        const title = h('div', { class: 'title' }, t('popupVideo') + ' ' + n, ' ', h('span', { class: 'tag' }, v.width + '×' + v.height));
        if (!rep.frame.isTop) title.append(' ', h('span', { class: 'tag' }, t('popupFrame')));
        if (v.wireless) title.append(' ', h('span', { class: 'tag res' }, 'AirPlay'));
        card.append(title);
        if (v.strategy === 'element') card.append(h('div', { class: 'line' }, t('sourceDirect') + ' · ' + kindLabel(v.directKind) + ' · ' + S.shortName(v.directUrl, 44)));
        else if (v.strategy === 'proxy' && v.best) card.append(h('div', { class: 'line' }, kindLabel(v.best.kind), tags(v.best), ' · ' + S.shortName(v.best.url, 44)));
        else card.append(h('div', { class: 'line' }, v.isBlob ? t('sourceDirectBlob') : t('noStreams')));
        card.append(h('div', { class: 'line' + (st.ok ? ' ok' : '') }, st.text));

        const btns = h('div', { class: 'row-btns' });
        const cmd = (payload) => send({ type: 'command', tabId, frameId: rep.frameId, payload });
        if (IS_IOS) {
          btns.append(h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await cmd({ type: 'highlight', videoId: v.id }); } catch (e) {} window.close(); } }, t('popupHighlight')));
        } else {
          btns.append(h('button', { class: 'btn primary', type: 'button', disabled: v.playableNow || !v.isStreamObject ? null : '', onclick: async () => {
            try { await cmd({ type: 'airplay', videoId: v.id }); } catch (e) {}
            setTimeout(() => load(false), 600);
          } }, t('popupAirPlay')));
          btns.append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await cmd({ type: 'highlight', videoId: v.id }); } catch (e) {} } }, t('popupHighlight')));
        }
        const url = v.strategy === 'element' ? v.directUrl : (v.best ? v.best.url : null);
        if (url) {
          btns.append(h('button', { class: 'btn', type: 'button', onclick: () => B.tabs.create({ url }) }, t('popupOpen')));
          btns.append(h('button', { class: 'btn', type: 'button', onclick: (e) => copy(url, e.currentTarget) }, t('popupCopy')));
        }
        if (rep.proxyActive && rep.proxyFor === v.id) btns.append(h('button', { class: 'btn', type: 'button', onclick: async () => { try { await cmd({ type: 'stop' }); } catch (e) {} setTimeout(() => load(false), 300); } }, t('actionStop')));
        card.append(btns);
        videosBox.append(card);
      }
    }
    if (!n) videosBox.append(h('div', { class: 'empty' }, t('popupNoVideos')));

    const seen = new Set();
    const merged = [];
    for (const rep of frames) for (const c of rep.streams || []) { const k = S.dedupeKey(c.url); if (seen.has(k)) continue; seen.add(k); merged.push(Object.assign({ frameId: rep.frameId }, c)); }
    const ranked = S.rank(merged).slice(0, 10);
    if (!ranked.length) streamsBox.append(h('div', { class: 'empty' }, t('noStreams')));
    for (const c of ranked) {
      const row = h('div', { class: 'stream' + (c.playable ? '' : ' dim'), 'data-url': c.url },
        h('div', { class: 'main' }, h('div', { class: 'kind' }, kindLabel(c.kind), tags(c)), h('div', { class: 'url', title: c.url }, S.shortName(c.url, 60))));
      if (c.playable && !IS_IOS) row.append(h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await send({ type: 'command', tabId, frameId: c.frameId, payload: { type: 'airplay', url: c.url } }); } catch (e) {} setTimeout(() => load(false), 600); } }, t('popupAirPlay')));
      row.append(h('button', { class: 'btn', type: 'button', onclick: () => B.tabs.create({ url: c.url }) }, t('popupOpen')));
      row.append(h('button', { class: 'btn', type: 'button', onclick: (e) => copy(c.url, e.currentTarget) }, t('popupCopy')));
      streamsBox.append(row);
    }
  }

  function copy(text, btn) {
    const done = () => { if (btn) { const old = btn.textContent; btn.textContent = t('copied'); setTimeout(() => { btn.textContent = old; }, 1200); } };
    try { navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done()); } catch (e) { if (fallbackCopy(text)) done(); }
  }
  function fallbackCopy(text) {
    try { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
  }

  async function load(rescan) {
    try {
      if (currentTabId == null) currentTabId = await activeTabId();
      const tabId = currentTabId;
      if (tabId == null) { render(null); return; }
      if (rescan) { try { await send({ type: 'command', tabId, payload: { type: 'rescan' } }); } catch (e) {} }
      const state = await send({ type: 'getTabState', tabId });
      render(state, tabId);
    } catch (e) {
      render(null);
    }
  }
  $('#rescan').addEventListener('click', () => load(true));
  load(true);
  setTimeout(() => load(false), 1200);
})();
