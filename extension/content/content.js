/*
 * AirPlay Any Video — content script (isolated world, runs in every frame).
 *
 * Responsibilities
 *  1. Find every <video> on the page (including inside open shadow roots) and keep watching for new ones.
 *  2. Learn which real media URL backs each player:
 *       - the element's own src / currentSrc / <source> children,
 *       - the Resource Timing API (every URL the page fetched: .m3u8, .mp4, .mpd, …),
 *       - messages from the MAIN-world hook (fetch/XHR responses + playlist bodies),
 *       - probes answered by the background (is this .m3u8 a master playlist? max resolution?).
 *  3. Unblock AirPlay on players that disable it (disableRemotePlayback / x-webkit-airplay="deny").
 *  4. Draw a small AirPlay badge over each video; the badge opens a panel with one-tap actions.
 *     A tap on the badge is a real user gesture inside the page, which Safari (especially on iOS)
 *     requires before it will show the AirPlay device picker.
 *  5. For MSE (blob:) players, play the captured HLS/MP4 URL in our own hidden-ish <video>
 *     ("proxy player") and show the picker for it: the Apple TV then fetches the stream itself at
 *     full quality — nothing is mirrored.
 */
(() => {
  'use strict';
  if (window.__airplayAnyContent) return;
  window.__airplayAnyContent = true;

  const B = globalThis.browser || globalThis.chrome;
  const S = globalThis.AirPlayAny;
  if (!S || !B || !B.runtime) return;

  const HOOK_NS = 'airplay-any:v1';
  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();
  const UA = navigator.userAgent || '';
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const HAS_PICKER = typeof HTMLMediaElement.prototype.webkitShowPlaybackTargetPicker === 'function';
  const HAS_NATIVE_FS = typeof HTMLVideoElement.prototype.webkitEnterFullscreen === 'function';
  const MIN_BADGE_W = 120;
  const MIN_BADGE_H = 70;

  // ------------------------------------------------------------------ i18n
  const FALLBACK = {
    badgeTitle: 'AirPlay this video', panelTitle: 'AirPlay', actionAirPlay: 'AirPlay this video',
    actionAirPlayOriginal: 'AirPlay the page player (unblocked)', actionFullscreen: 'Open in native player (AirPlay button inside)',
    actionOpenTab: 'Open stream in a new tab', actionCopy: 'Copy stream URL', actionStop: 'Stop & return to page player',
    actionHide: 'Hide badge on this page', actionRescan: 'Rescan page',
    statusAvailable: 'AirPlay devices available', statusUnavailable: 'No AirPlay devices found yet',
    statusUnknown: 'Checking AirPlay availability…', statusConnected: 'Playing on AirPlay device',
    statusNoApi: 'This browser has no AirPlay API (use Safari on iPhone/iPad/Mac)',
    sourceDirect: 'Direct source of the player', sourceDirectBlob: 'Player uses MSE (blob:) — needs the real stream URL',
    kindHlsMaster: 'HLS master playlist (adaptive, best quality)', kindHlsMedia: 'HLS playlist (single quality)', kindHls: 'HLS playlist',
    kindMp4: 'MP4 / MOV file', kindDash: 'DASH manifest — not playable by AirPlay (Safari has no native DASH)',
    kindWebm: 'WebM/other — not playable by AirPlay', kindSegment: 'Media segment — not a full stream', kindUnknown: 'Unknown media URL',
    streamsHeading: 'Streams found on this page',
    noStreams: 'No AirPlay-compatible stream found yet. Press play on the video for a few seconds and reopen this panel.',
    drmHint: 'If this is a DRM-protected service (Netflix, Disney+, …), AirPlay of the stream is impossible from a browser.',
    copied: 'Copied', upTo: 'up to $1', proxyTitle: 'AirPlay remote',
    proxyHint: 'This mini player drives the AirPlay session. Close it to return to the page player.',
  };
  function t(key, sub) {
    let s = '';
    try { if (B.i18n && B.i18n.getMessage) s = B.i18n.getMessage(key, sub == null ? undefined : [String(sub)]); } catch (e) {}
    if (!s) { s = FALLBACK[key] || key; if (sub != null) s = s.replace('$1', String(sub)); }
    return s;
  }

  // -------------------------------------------------------------- settings
  const settings = { showBadges: true, autoUnblock: true, pauseOriginal: true, deepCapture: true };
  let hiddenHere = false;
  function applySettings(next) {
    if (next && typeof next === 'object') Object.assign(settings, next);
    if (settings.autoUnblock) for (const entry of entries.values()) unblock(entry);
    updateBadges();
  }
  try {
    const got = B.storage.local.get('settings');
    if (got && got.then) got.then((r) => applySettings(r && r.settings)).catch(() => {});
    B.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
    });
  } catch (e) {}

  // ------------------------------------------------------- stream capture
  /** @type {Map<string, any>} dedupeKey → candidate */
  const streams = new Map();
  const probing = new Set();
  const mseBlobs = new Set();
  let hookAlive = false;
  let airplayAvailableGlobal = null; // learned from any element's availability event

  function considerUrl(url, info, source) {
    info = info || {};
    if (!info.isElementSource && !S.looksLikeMedia(url, info.contentType)) return null;
    const cand = S.classify(url, info);
    if (cand.kind === S.KIND.BLOB || (cand.kind === S.KIND.UNKNOWN && !info.isElementSource)) return null;
    const key = S.dedupeKey(cand.url);
    const now = Date.now();
    let cur = streams.get(key);
    if (!cur) {
      cur = Object.assign(cand, { seenAt: now, firstSeen: now, sources: new Set([source]) });
      streams.set(key, cur);
    } else {
      cur.seenAt = now;
      cur.sources.add(source);
      const better = (cand.detail && !cur.detail) || (!cur.detail && cand.score > cur.score) || (cand.isElementSource && !cur.isElementSource);
      if (better) {
        for (const k of ['kind', 'playable', 'score', 'detail', 'guessed', 'encrypted', 'audioOnly', 'note']) {
          if (k in cand) cur[k] = cand[k]; else delete cur[k];
        }
        if (cand.isElementSource) cur.isElementSource = true;
      }
    }
    const isHls = cur.kind === S.KIND.HLS || cur.kind === S.KIND.HLS_MASTER || cur.kind === S.KIND.HLS_MEDIA;
    if (isHls && !cur.detail && !probing.has(key)) probe(key, cur);
    onStreamsChanged();
    return cur;
  }

  function probe(key, cand) {
    probing.add(key);
    try {
      const p = B.runtime.sendMessage({ type: 'probe', url: cand.url });
      if (!p || !p.then) return;
      p.then((res) => {
        if (!res || !res.ok) return;
        considerUrl(cand.url, { contentType: res.contentType || '', body: res.body || undefined }, 'probe');
      }).catch(() => {});
    } catch (e) {}
  }

  function drainPerf() {
    try { for (const e of performance.getEntriesByType('resource')) considerUrl(e.name, {}, 'perf'); } catch (e) {}
  }
  try { performance.setResourceTimingBufferSize(4000); } catch (e) {}
  drainPerf();
  try {
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) considerUrl(e.name, {}, 'perf'); });
    po.observe({ type: 'resource', buffered: true });
  } catch (e) {}

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__airplayAny !== HOOK_NS) return;
    switch (d.type) {
      case 'hello':
        hookAlive = true;
        scheduleReport();
        break;
      case 'resource':
        if (typeof d.url === 'string') {
          considerUrl(d.url, {
            contentType: typeof d.contentType === 'string' ? d.contentType : '',
            body: typeof d.body === 'string' ? d.body : undefined,
          }, 'hook');
        }
        break;
      case 'mse':
        if (typeof d.blobUrl === 'string') mseBlobs.add(d.blobUrl);
        for (const entry of entries.values()) refreshElementSource(entry);
        break;
    }
  });
  function postToHook(msg) { try { window.postMessage(Object.assign({ __airplayAny: HOOK_NS }, msg), '*'); } catch (e) {} }
  postToHook({ type: 'ping' });
  // Older Safari without MAIN-world registration: try a plain <script src> (page CSP may block it; harmless).
  setTimeout(() => {
    if (hookAlive || !settings.deepCapture) return;
    try {
      const s = document.createElement('script');
      s.src = B.runtime.getURL('content/page-hook.js');
      s.async = false;
      s.addEventListener('load', () => s.remove());
      s.addEventListener('error', () => s.remove());
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }, 1500);

  let streamsChangedTimer = 0;
  function onStreamsChanged() {
    if (streamsChangedTimer) return;
    streamsChangedTimer = setTimeout(() => {
      streamsChangedTimer = 0;
      if (panel) refreshPanelIf(panel.entry, true);
      updateBadges();
      scheduleReport();
    }, 300);
  }

  function rankedStreams() { return S.rank([...streams.values()]); }
  function bestStreamFor(entry) {
    const list = rankedStreams().filter((c) => c.playable && !c.isElementSource);
    // Prefer alternative <source> children of this very element (e.g. HLS next to an MSE blob).
    if (entry && entry.altUrls && entry.altUrls.length) {
      for (const u of entry.altUrls) { const c = streams.get(S.dedupeKey(u)); if (c && c.playable) return c; }
    }
    return list[0] || null;
  }

  // ------------------------------------------------------- video discovery
  /** @type {Map<HTMLVideoElement, any>} */
  const entries = new Map();
  let nextId = 1;
  function isOurs(el) { return !!(el && el.__airplayAnyProxy); }

  function collectVideos() {
    const out = new Set();
    try { document.querySelectorAll('video').forEach((v) => out.add(v)); } catch (e) {}
    try {
      let budget = 8000;
      const walk = (root) => {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          if (budget-- <= 0) return;
          const el = all[i];
          if (el.shadowRoot && !(ui && el === ui.host)) {
            el.shadowRoot.querySelectorAll('video').forEach((v) => out.add(v));
            observeShadowRoot(el.shadowRoot);
            walk(el.shadowRoot);
          }
        }
      };
      walk(document);
    } catch (e) {}
    return out;
  }

  const observedRoots = new WeakSet();
  let mo = null;
  function observeShadowRoot(root) {
    if (!mo || observedRoots.has(root)) return;
    observedRoots.add(root);
    try { mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'disableremoteplayback', 'x-webkit-airplay'] }); } catch (e) {}
  }
  let scanTimer = 0;
  let scanDue = 0;
  function scheduleScan(delay) {
    const ms = delay == null ? 350 : delay;
    const due = Date.now() + ms;
    if (scanTimer) {
      if (due >= scanDue) return;
      clearTimeout(scanTimer);
    }
    scanDue = due;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, ms);
  }
  function scan() {
    if (document.visibilityState === 'hidden' && entries.size === 0) { scheduleScan(2000); return; }
    const found = collectVideos();
    for (const v of found) register(v);
    for (const [el, entry] of entries) {
      if (!el.isConnected) unregister(entry);
    }
    updateBadges();
  }
  function register(el) {
    if (!(el instanceof HTMLVideoElement) || entries.has(el) || isOurs(el)) return;
    const entry = {
      id: nextId++, el, badge: null, visible: false, rect: null,
      availability: HAS_PICKER ? 'unknown' : 'noapi', wireless: false,
      directUrl: null, directCand: null, altUrls: [], isBlob: false, isStreamObject: false, unblocked: false,
    };
    entries.set(el, entry);
    const on = (ev, fn) => { try { el.addEventListener(ev, fn, { passive: true }); } catch (e) {} };
    on('webkitplaybacktargetavailabilitychanged', (e) => {
      entry.availability = e.availability === 'available' ? 'available' : 'unavailable';
      airplayAvailableGlobal = entry.availability === 'available';
      refreshPanelIf(entry); scheduleReport();
    });
    on('webkitcurrentplaybacktargetiswirelesschanged', () => {
      entry.wireless = !!el.webkitCurrentPlaybackTargetIsWireless;
      refreshPanelIf(entry); scheduleReport(); updateBadges();
    });
    on('loadstart', () => { if (settings.autoUnblock) unblock(entry); refreshElementSource(entry); scheduleReport(); });
    on('loadedmetadata', () => { refreshElementSource(entry); updateBadges(); scheduleReport(); });
    on('emptied', () => { refreshElementSource(entry); scheduleReport(); });
    on('play', () => { updateBadges(); scheduleReport(); });
    on('pause', () => scheduleReport());
    on('resize', () => updateBadges());
    if (settings.autoUnblock) unblock(entry);
    refreshElementSource(entry);
    observeVisibility(entry);
    scheduleReport();
  }
  function unregister(entry) {
    entries.delete(entry.el);
    if (entry.badge) { entry.badge.remove(); entry.badge = null; }
    if (io) { try { io.unobserve(entry.el); } catch (e) {} }
    if (panel && panel.entry === entry) closePanel();
    scheduleReport();
  }
  function findEntry(id) { for (const e of entries.values()) if (e.id === id) return e; return null; }

  function refreshElementSource(entry) {
    const el = entry.el;
    const cur = el.currentSrc || '';
    const attr = el.getAttribute('src') || '';
    const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (e) { return null; } };
    entry.isStreamObject = !!el.srcObject;
    entry.isBlob = /^blob:/i.test(cur) || (!cur && /^blob:/i.test(attr));
    entry.directUrl = null;
    entry.directCand = null;
    entry.altUrls = [];
    if (/^https?:/i.test(cur)) {
      entry.directUrl = cur;
      entry.directCand = considerUrl(cur, { isElementSource: true }, 'element');
    } else if (!cur && attr && !/^(blob|data|mediastream):/i.test(attr)) {
      const a = abs(attr);
      if (a && /^https?:/i.test(a)) { entry.directUrl = a; entry.directCand = considerUrl(a, { isElementSource: true }, 'element'); }
    }
    let sources = [];
    try { sources = Array.from(el.querySelectorAll('source')); } catch (e) {}
    for (const s of sources) {
      const src = s.getAttribute('src');
      if (!src || /^(blob|data|mediastream):/i.test(src)) continue;
      const a = abs(src);
      if (!a || !/^https?:/i.test(a)) continue;
      if (a === entry.directUrl) continue;
      const cand = considerUrl(a, { isElementSource: true, contentType: s.getAttribute('type') || '' }, 'element');
      if (cand && cand.playable) entry.altUrls.push(a);
    }
  }

  // --------------------------------------------------------------- unblock
  function unblock(entry) {
    const el = entry.el;
    try {
      if (el.hasAttribute('disableremoteplayback')) el.removeAttribute('disableremoteplayback');
      if ('disableRemotePlayback' in el && el.disableRemotePlayback) el.disableRemotePlayback = false;
      if (el.hasAttribute('x-webkit-wirelessvideoplaybackdisabled')) el.removeAttribute('x-webkit-wirelessvideoplaybackdisabled');
      if (el.getAttribute('x-webkit-airplay') !== 'allow') el.setAttribute('x-webkit-airplay', 'allow');
      entry.unblocked = true;
    } catch (e) {}
  }

  // ------------------------------------------------------------ visibility
  let io = null;
  function observeVisibility(entry) {
    if (!io) {
      try {
        io = new IntersectionObserver((recs) => {
          for (const r of recs) { const en = entries.get(r.target); if (en) en.visible = r.isIntersecting; }
          updateBadges();
        }, { threshold: 0 });
      } catch (e) {}
    }
    if (io) { try { io.observe(entry.el); return; } catch (e) {} }
    entry.visible = true;
  }

  // -------------------------------------------------------------------- UI
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"/><polygon points="12 15 17 21 7 21 12 15" fill="currentColor" stroke="none"/></svg>';
  const CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; }
    .apa-badge { position: fixed; left: 0; top: 0; pointer-events: auto; display: inline-flex; align-items: center; gap: 7px;
      height: 34px; padding: 0 13px 0 10px; border-radius: 17px; border: 0; margin: 0;
      background: rgba(10, 112, 240, 0.94); color: #fff; font: 600 13px/1 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 2px 10px rgba(0,0,0,.4); cursor: pointer; opacity: .94; will-change: transform;
      transition: opacity .2s; touch-action: manipulation; -webkit-tap-highlight-color: transparent; white-space: nowrap; }
    .apa-badge:hover { opacity: 1; }
    .apa-badge.compact { padding: 0 9px; }
    .apa-badge.compact span { display: none; }
    .apa-badge.connected { background: rgba(52, 199, 89, 0.95); }
    .apa-badge svg { width: 18px; height: 18px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .apa-badge.pulse { animation: apa-pulse 0.9s ease-in-out 3; }
    @keyframes apa-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.6); } }
    .apa-panel { position: fixed; left: 0; top: 0; pointer-events: auto; width: min(400px, calc(100vw - 16px));
      max-height: min(72vh, 600px); overflow: auto; -webkit-overflow-scrolling: touch; background: #1c1c1e; color: #f2f2f7;
      border-radius: 14px; box-shadow: 0 12px 44px rgba(0,0,0,.55); padding: 12px 12px 10px;
      font: 14px/1.35 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; }
    .apa-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .apa-head svg { width: 20px; height: 20px; fill: none; stroke: #4da3ff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .apa-head b { font-size: 15px; }
    .apa-status { color: #a1a1a6; font-size: 12px; margin-left: auto; text-align: right; }
    .apa-status.ok { color: #34c759; }
    .apa-x { border: 0; background: #2c2c2e; color: #fff; width: 28px; height: 28px; border-radius: 14px; cursor: pointer; flex: none; font-size: 16px; line-height: 1; }
    .apa-primary { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 44px; border: 0; border-radius: 10px;
      background: #0a84ff; color: #fff; font-weight: 600; font-size: 15px; cursor: pointer; touch-action: manipulation; }
    .apa-primary:disabled { background: #3a3a3c; color: #8e8e93; cursor: default; }
    .apa-primary svg { width: 18px; height: 18px; fill: none; stroke: #fff; stroke-width: 2; }
    .apa-sub { color: #a1a1a6; font-size: 12px; margin: 6px 2px 10px; word-break: break-word; }
    .apa-title { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #8e8e93; margin: 8px 2px 6px; }
    .apa-row { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 10px; background: #2c2c2e; margin-bottom: 6px; }
    .apa-row.dim { opacity: .55; }
    .apa-row.best { outline: 1px solid #0a84ff; }
    .apa-row-main { flex: 1; min-width: 0; }
    .apa-kind { font-size: 13px; font-weight: 600; }
    .apa-url { font-size: 11px; color: #a1a1a6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .apa-tag { display: inline-block; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: #3a3a3c; color: #d1d1d6; margin-left: 4px; vertical-align: 1px; }
    .apa-tag.res { background: #0a84ff22; color: #4da3ff; }
    .apa-tag.warn { background: #ff9f0a22; color: #ff9f0a; }
    .apa-ib { border: 0; background: #3a3a3c; color: #fff; width: 34px; height: 34px; border-radius: 8px; cursor: pointer; flex: none; display: inline-flex; align-items: center; justify-content: center; touch-action: manipulation; }
    .apa-ib.play { background: #0a84ff; }
    .apa-ib svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .apa-empty { color: #a1a1a6; font-size: 13px; padding: 4px 2px 8px; }
    .apa-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .apa-btn { border: 0; background: #2c2c2e; color: #fff; padding: 9px 11px; border-radius: 9px; cursor: pointer; font-size: 13px; touch-action: manipulation; }
    .apa-btn.danger { color: #ff453a; }
    .apa-proxy { position: fixed; right: 12px; bottom: 12px; pointer-events: auto; width: min(360px, calc(100vw - 24px)); background: #000;
      border-radius: 12px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.6); font: 13px/1.3 -apple-system, system-ui, sans-serif; color: #fff; }
    .apa-proxy-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #1c1c1e; }
    .apa-proxy-head b { font-size: 13px; }
    .apa-proxy-status { color: #a1a1a6; font-size: 12px; margin-left: auto; }
    .apa-proxy-status.ok { color: #34c759; }
    .apa-proxy video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; }
    .apa-proxy-hint { padding: 8px 10px; color: #a1a1a6; font-size: 12px; background: #1c1c1e; }
    .apa-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: rgba(28,28,30,.96); color: #fff;
      padding: 10px 14px; border-radius: 10px; font: 13px -apple-system, system-ui, sans-serif; pointer-events: none; max-width: calc(100vw - 32px); text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
    @media (prefers-reduced-motion: reduce) { .apa-badge.pulse { animation: none; } }
  `;

  let ui = null;
  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;
    if (ui) { try { (document.documentElement || document.body).appendChild(ui.host); } catch (e) {} return ui; }
    const parent = document.documentElement;
    if (!parent) return null;
    const host = document.createElement('airplay-any-host');
    const root = host.attachShadow({ mode: 'open' });
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      styled = true;
    } catch (e) {}
    if (!styled) { const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st); }
    const badges = document.createElement('div');
    const panels = document.createElement('div');
    const proxies = document.createElement('div');
    root.append(badges, panels, proxies);
    parent.appendChild(host);
    ui = { host, root, badges, panels, proxies };
    return ui;
  }
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v != null) el.setAttribute(k, v);
    }
    for (const c of children) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  // ---- badges ----
  function shouldShowBadge(entry) {
    if (!settings.showBadges || hiddenHere) return false;
    const el = entry.el;
    if (!el.isConnected || !entry.visible) return false;
    const r = el.getBoundingClientRect();
    entry.rect = r;
    if (r.width < MIN_BADGE_W || r.height < MIN_BADGE_H) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    } catch (e) {}
    return true;
  }
  function ensureBadge(entry) {
    if (entry.badge) return entry.badge;
    const u = ensureUI();
    if (!u) return null;
    const b = h('button', { class: 'apa-badge', type: 'button', title: t('badgeTitle'), 'aria-label': t('badgeTitle'), 'data-apa-id': entry.id, html: ICON });
    b.appendChild(h('span', null, 'AirPlay'));
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(entry); });
    u.badges.appendChild(b);
    entry.badge = b;
    return b;
  }
  function positionBadge(entry) {
    const r = entry.rect, b = entry.badge;
    const compact = r.width < 300;
    b.classList.toggle('compact', compact);
    b.classList.toggle('connected', !!entry.wireless);
    const bw = compact ? 38 : 100, bh = 34;
    let x = Math.min(r.right - bw - 10, innerWidth - bw - 6);
    let y = r.top + 10;
    if (y < 6) y = 6;
    if (y + bh > r.bottom - 4) y = Math.max(6, r.bottom - bh - 4);
    if (x < 6) x = 6;
    b.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  let anyBadgeVisible = false;
  function updateBadges() {
    let visible = false;
    for (const entry of entries.values()) {
      if (shouldShowBadge(entry)) {
        const b = ensureBadge(entry);
        if (!b) continue;
        b.style.display = '';
        positionBadge(entry);
        visible = true;
      } else if (entry.badge) {
        entry.badge.style.display = 'none';
      }
    }
    anyBadgeVisible = visible;
    if (panel) positionPanel();
  }
  let posRaf = 0;
  function requestReposition() {
    if (posRaf || (!anyBadgeVisible && !panel)) return;
    posRaf = requestAnimationFrame(() => { posRaf = 0; updateBadges(); });
  }
  document.addEventListener('scroll', requestReposition, { capture: true, passive: true });
  window.addEventListener('resize', requestReposition, { passive: true });
  window.addEventListener('orientationchange', requestReposition, { passive: true });
  setInterval(() => { if (anyBadgeVisible || panel) updateBadges(); }, 700);

  // ---- fullscreen: move our host inside the fullscreen element so badges stay reachable ----
  function onFsChange() {
    if (!ui) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const target = (fs && fs !== ui.host && !(fs instanceof HTMLVideoElement) && !fs.contains(ui.host)) ? fs : document.documentElement;
    if (fs && fs === ui.host.parentNode) return;
    if (!fs && ui.host.parentNode !== document.documentElement) { try { document.documentElement.appendChild(ui.host); } catch (e) {} }
    else if (fs && target !== ui.host.parentNode) { try { target.appendChild(ui.host); } catch (e) {} }
    setTimeout(updateBadges, 50);
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // ---- panel ----
  let panel = null;
  let panelSignature = '';
  function togglePanel(entry) { if (panel && panel.entry === entry) closePanel(); else openPanel(entry); }
  function openPanel(entry) {
    closePanel();
    const u = ensureUI();
    if (!u) return;
    const el = buildPanel(entry);
    u.panels.appendChild(el);
    panel = { entry, el };
    positionPanel();
    document.addEventListener('keydown', onPanelKey, true);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }
  function closePanel() {
    if (!panel) return;
    panel.el.remove();
    panel = null;
    document.removeEventListener('keydown', onPanelKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
  }
  function onPanelKey(e) { if (e.key === 'Escape') closePanel(); }
  function onOutside(e) {
    if (!panel || !ui) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(panel.el) || (panel.entry.badge && path.includes(panel.entry.badge))) return;
    closePanel();
  }
  function refreshPanelIf(entry, onlyIfChanged) {
    if (!panel || panel.entry !== entry) return;
    if (onlyIfChanged && panelSignature === signature(entry)) return;
    const fresh = buildPanel(entry);
    panel.el.replaceWith(fresh);
    panel.el = fresh;
    positionPanel();
  }
  function signature(entry) {
    return [entry.directUrl, entry.availability, entry.wireless, proxy && proxy.active ? proxy.url : '',
      ...rankedStreams().map((c) => c.url + '|' + c.kind + '|' + (c.detail ? c.detail.maxHeight : ''))].join('\n');
  }
  function positionPanel() {
    if (!panel) return;
    const p = panel.el;
    let r = panel.entry.rect;
    try { r = panel.entry.el.getBoundingClientRect(); } catch (e) {}
    if (!r) return;
    const pw = p.offsetWidth || 380, ph = p.offsetHeight || 300;
    let x = Math.min(r.right - pw - 10, innerWidth - pw - 8);
    if (x < 8) x = 8;
    let y = r.top + 50;
    if (y + ph > innerHeight - 8) y = Math.max(8, innerHeight - ph - 8);
    p.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  function statusText(entry) {
    if (!HAS_PICKER) return { text: t('statusNoApi'), ok: false };
    if (entry.wireless || (proxy && proxy.active && proxy.wireless && proxy.original === entry.el)) return { text: t('statusConnected'), ok: true };
    const a = entry.availability !== 'unknown' ? entry.availability : (airplayAvailableGlobal == null ? 'unknown' : (airplayAvailableGlobal ? 'available' : 'unavailable'));
    if (a === 'available') return { text: t('statusAvailable'), ok: true };
    if (a === 'unavailable') return { text: t('statusUnavailable'), ok: false };
    return { text: t('statusUnknown'), ok: false };
  }
  function kindLabel(c) { return t(S.kindMessageKey(c.kind)); }
  function tagsFor(c) {
    const frag = document.createDocumentFragment();
    const res = S.formatResolution(c.detail);
    if (res) frag.append(h('span', { class: 'apa-tag res' }, t('upTo', res)));
    if (c.detail && c.detail.isLive) frag.append(h('span', { class: 'apa-tag' }, 'LIVE'));
    if (c.encrypted) frag.append(h('span', { class: 'apa-tag warn' }, 'AES'));
    if (c.guessed) frag.append(h('span', { class: 'apa-tag' }, '?'));
    return frag;
  }
  function plan(entry) {
    if (entry.directCand && entry.directCand.playable) return { strategy: 'element', cand: entry.directCand, url: entry.directUrl };
    const best = bestStreamFor(entry);
    if (best) return { strategy: 'proxy', cand: best, url: best.url };
    return { strategy: 'none', cand: null, url: null };
  }
  function buildPanel(entry) {
    panelSignature = signature(entry);
    const st = statusText(entry);
    const pl = plan(entry);
    const root = h('div', { class: 'apa-panel', role: 'dialog', 'aria-label': t('panelTitle') });
    root.append(h('div', { class: 'apa-head' },
      h('span', { html: ICON }), h('b', null, t('panelTitle')),
      h('span', { class: 'apa-status' + (st.ok ? ' ok' : '') }, st.text),
      h('button', { class: 'apa-x', type: 'button', 'aria-label': 'Close', onclick: () => closePanel() }, '×')));

    const primaryLabel = pl.strategy === 'element' ? t('actionAirPlayOriginal') : t('actionAirPlay');
    const primary = h('button', { class: 'apa-primary', type: 'button', 'data-apa-primary': pl.strategy, html: ICON + '<span></span>' });
    primary.querySelector('span').textContent = primaryLabel;
    primary.addEventListener('click', (e) => { e.preventDefault(); doPrimary(entry); });
    root.append(primary);
    const sub = h('div', { class: 'apa-sub' });
    if (pl.strategy === 'element') { sub.append(kindLabel(pl.cand), ' · ', S.shortName(pl.url, 48)); }
    else if (pl.strategy === 'proxy') { sub.append(kindLabel(pl.cand), tagsFor(pl.cand), ' · ', S.shortName(pl.url, 48)); }
    else if (entry.isStreamObject) { sub.append('MediaStream (camera/WebRTC) — AirPlay cannot play it.'); }
    else { sub.append(entry.isBlob ? t('sourceDirectBlob') : t('noStreams')); }
    root.append(sub);

    const list = rankedStreams().filter((c) => !(c.isElementSource && c.url === entry.directUrl && pl.strategy === 'element'));
    root.append(h('div', { class: 'apa-title' }, t('streamsHeading')));
    if (!list.length) {
      root.append(h('div', { class: 'apa-empty' }, t('noStreams')), h('div', { class: 'apa-empty' }, t('drmHint')));
    } else {
      const box = h('div', { class: 'apa-list' });
      for (const c of list.slice(0, 12)) {
        const row = h('div', { class: 'apa-row' + (c.playable ? '' : ' dim') + (pl.cand === c ? ' best' : ''), 'data-apa-url': c.url, 'data-apa-kind': c.kind });
        const main = h('div', { class: 'apa-row-main' }, h('div', { class: 'apa-kind' }, kindLabel(c), tagsFor(c)), h('div', { class: 'apa-url', title: c.url }, S.shortName(c.url, 70)));
        row.append(main);
        if (c.playable) {
          row.append(h('button', { class: 'apa-ib play', type: 'button', title: t('actionAirPlay'), 'aria-label': t('actionAirPlay'), html: ICON,
            onclick: (e) => { e.preventDefault(); airplayViaProxy(c.url, entry); } }));
        }
        row.append(h('button', { class: 'apa-ib', type: 'button', title: t('actionOpenTab'), 'aria-label': t('actionOpenTab'),
          html: '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
          onclick: (e) => { e.preventDefault(); openInTab(c.url); } }));
        row.append(h('button', { class: 'apa-ib', type: 'button', title: t('actionCopy'), 'aria-label': t('actionCopy'),
          html: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
          onclick: (e) => { e.preventDefault(); copyText(c.url); } }));
        box.append(row);
      }
      root.append(box);
      if (!list.some((c) => c.playable)) root.append(h('div', { class: 'apa-empty' }, t('drmHint')));
    }

    const actions = h('div', { class: 'apa-actions' });
    if (HAS_NATIVE_FS && (pl.strategy !== 'none')) {
      actions.append(h('button', { class: 'apa-btn', type: 'button', 'data-apa-action': 'native', onclick: () => nativePlayer(entry) }, t('actionFullscreen')));
    }
    if (proxy && proxy.active) {
      actions.append(h('button', { class: 'apa-btn danger', type: 'button', 'data-apa-action': 'stop', onclick: () => { stopProxy(true); refreshPanelIf(entry); } }, t('actionStop')));
    }
    actions.append(h('button', { class: 'apa-btn', type: 'button', 'data-apa-action': 'rescan', onclick: () => { rescan(); toast('…'); } }, t('actionRescan')));
    actions.append(h('button', { class: 'apa-btn', type: 'button', 'data-apa-action': 'hide', onclick: () => { hiddenHere = true; closePanel(); updateBadges(); scheduleReport(); } }, t('actionHide')));
    root.append(actions);
    return root;
  }

  // ---- toast ----
  let toastTimer = 0;
  function toast(text) {
    const u = ensureUI();
    if (!u) return;
    let el = u.root.querySelector('.apa-toast');
    if (!el) { el = h('div', { class: 'apa-toast' }); u.root.appendChild(el); }
    el.textContent = text;
    el.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2200);
  }

  // --------------------------------------------------------------- actions
  function debugEvent(name, detail) {
    // Diagnostic signal for page-level tooling/tests (the page already knows its own stream URLs).
    try { document.dispatchEvent(new CustomEvent('airplay-any:' + name, { detail })); } catch (e) {}
  }
  function showPicker(video) {
    debugEvent('picker', { src: video.currentSrc || video.getAttribute('src') || '', hasApi: HAS_PICKER });
    if (!HAS_PICKER || typeof video.webkitShowPlaybackTargetPicker !== 'function') { toast(t('statusNoApi')); return false; }
    try { video.webkitShowPlaybackTargetPicker(); return true; } catch (e) { toast(String(e && e.message || e)); return false; }
  }
  function doPrimary(entry) {
    const pl = plan(entry);
    if (pl.strategy === 'element') return airplayElement(entry);
    if (pl.strategy === 'proxy') return airplayViaProxy(pl.url, entry);
    // Nothing usable captured: let Safari try the page player itself (works for some MSE players on macOS).
    if (!entry.isStreamObject) {
      unblock(entry);
      try { if (entry.el.paused) entry.el.play().catch(() => {}); } catch (e) {}
      showPicker(entry.el);
    }
    if (!panel || panel.entry !== entry) openPanel(entry);
    toast(t('noStreams'));
    return { strategy: 'none' };
  }
  function airplayElement(entry) {
    unblock(entry);
    if (proxy && proxy.active) stopProxy(false);
    try { if (entry.el.paused) { const p = entry.el.play(); if (p && p.catch) p.catch(() => {}); } } catch (e) {}
    showPicker(entry.el);
    return { strategy: 'element', url: entry.directUrl };
  }

  // ---- proxy player ----
  let proxy = null;
  function ensureProxy() {
    const u = ensureUI();
    if (!u) return null;
    if (proxy && proxy.wrap.isConnected) return proxy;
    const video = document.createElement('video');
    video.__airplayAnyProxy = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('controls', '');
    video.setAttribute('x-webkit-airplay', 'allow');
    video.preload = 'auto';
    const status = h('span', { class: 'apa-proxy-status' });
    const wrap = h('div', { class: 'apa-proxy', 'data-apa-proxy': '1' },
      h('div', { class: 'apa-proxy-head' }, h('b', null, t('proxyTitle')), status,
        h('button', { class: 'apa-x', type: 'button', 'aria-label': 'Close', onclick: () => stopProxy(true) }, '×')),
      video,
      h('div', { class: 'apa-proxy-hint' }, t('proxyHint')));
    wrap.style.display = 'none';
    u.proxies.appendChild(wrap);
    proxy = { wrap, video, status, original: null, url: null, active: false, wireless: false, pendingSeek: null };
    video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => { airplayAvailableGlobal = e.availability === 'available'; if (panel) refreshPanelIf(panel.entry); });
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      proxy.wireless = !!video.webkitCurrentPlaybackTargetIsWireless;
      status.textContent = proxy.wireless ? t('statusConnected') : '';
      status.classList.toggle('ok', proxy.wireless);
      if (proxy.wireless && proxy.original && settings.pauseOriginal) { try { proxy.original.pause(); } catch (e) {} }
      if (panel) refreshPanelIf(panel.entry);
      updateBadges(); scheduleReport();
    });
    video.addEventListener('loadedmetadata', () => {
      if (proxy.pendingSeek != null && isFinite(video.duration) && proxy.pendingSeek > 0 && proxy.pendingSeek < video.duration - 1) {
        try { video.currentTime = proxy.pendingSeek; } catch (e) {}
      }
      proxy.pendingSeek = null;
    });
    video.addEventListener('error', () => {
      const err = video.error;
      status.textContent = 'Error ' + (err ? err.code : '');
      status.classList.remove('ok');
    });
    return proxy;
  }
  function airplayViaProxy(url, entry) {
    const p = ensureProxy();
    if (!p) return { strategy: 'none' };
    const original = entry ? entry.el : null;
    p.original = original;
    p.url = url;
    p.active = true;
    p.wireless = false;
    p.status.textContent = '';
    p.status.classList.remove('ok');
    p.pendingSeek = null;
    if (original) {
      try {
        const ct = original.currentTime, d = original.duration;
        if (isFinite(ct) && isFinite(d) && d > 0 && ct > 0) p.pendingSeek = ct;
      } catch (e) {}
      if (settings.pauseOriginal) { try { original.pause(); } catch (e) {} }
    }
    p.wrap.style.display = '';
    try { p.video.src = url; } catch (e) {}
    try { const pr = p.video.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
    showPicker(p.video);
    if (panel) refreshPanelIf(panel.entry);
    scheduleReport();
    return { strategy: 'proxy', url };
  }
  function stopProxy(resumeOriginal) {
    if (!proxy || !proxy.active) return;
    const v = proxy.video;
    const pos = v.currentTime;
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('src'); v.load(); } catch (e) {}
    proxy.wrap.style.display = 'none';
    proxy.active = false;
    proxy.wireless = false;
    const original = proxy.original;
    proxy.original = null;
    if (resumeOriginal && original && original.isConnected) {
      try {
        if (isFinite(pos) && isFinite(original.duration) && pos > 0 && pos < original.duration) original.currentTime = pos;
        const pr = original.play(); if (pr && pr.catch) pr.catch(() => {});
      } catch (e) {}
    }
    updateBadges(); scheduleReport();
  }
  function nativePlayer(entry) {
    const pl = plan(entry);
    let video = null;
    if (pl.strategy === 'element') { unblock(entry); video = entry.el; }
    else if (pl.strategy === 'proxy') {
      const p = ensureProxy();
      if (!p) return;
      if (!p.active || p.url !== pl.url) {
        p.original = entry.el; p.url = pl.url; p.active = true;
        try { const ct = entry.el.currentTime, d = entry.el.duration; p.pendingSeek = (isFinite(ct) && isFinite(d) && ct > 0) ? ct : null; } catch (e) {}
        if (settings.pauseOriginal) { try { entry.el.pause(); } catch (e) {} }
        p.wrap.style.display = '';
        try { p.video.src = pl.url; } catch (e) {}
      }
      video = p.video;
    }
    if (!video) return;
    try { const pr = video.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
    debugEvent('native', { src: video.currentSrc || video.getAttribute('src') || '' });
    try {
      if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
      else if (typeof video.requestFullscreen === 'function') video.requestFullscreen();
    } catch (e) { toast(String(e && e.message || e)); }
    closePanel();
  }
  function openInTab(url) {
    try { const w = window.open(url, '_blank'); if (w) { try { w.opener = null; } catch (e) {} return; } } catch (e) {}
    try { B.runtime.sendMessage({ type: 'openStream', url }); } catch (e) {}
  }
  function copyText(text) {
    const done = () => toast(t('copied'));
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => legacyCopy(text) && done()); return; }
    } catch (e) {}
    if (legacyCopy(text)) done();
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function highlight(entry) {
    hiddenHere = false;
    try { entry.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch (e) {}
    setTimeout(() => {
      updateBadges();
      if (entry.badge) { entry.badge.classList.remove('pulse'); void entry.badge.offsetWidth; entry.badge.classList.add('pulse'); }
      openPanel(entry);
    }, 350);
  }
  function rescan() {
    scan();
    drainPerf();
    postToHook({ type: 'harvest' });
    for (const e of entries.values()) refreshElementSource(e);
    scheduleReport();
  }

  // ------------------------------------------------------------ reporting
  let reportTimer = 0;
  let firstReport = true;
  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => { reportTimer = 0; sendReport(); }, 400);
  }
  function pub(c) {
    return { url: c.url, kind: c.kind, playable: !!c.playable, score: c.score || 0, seenAt: c.seenAt || 0,
      resolution: S.formatResolution(c.detail), encrypted: !!c.encrypted, live: !!(c.detail && c.detail.isLive),
      guessed: !!c.guessed, isElementSource: !!c.isElementSource };
  }
  function buildState() {
    const videos = [];
    for (const entry of entries.values()) {
      if (!entry.el.isConnected) continue;
      let r = { width: 0, height: 0 };
      try { r = entry.el.getBoundingClientRect(); } catch (e) {}
      const pl = plan(entry);
      videos.push({
        id: entry.id, width: Math.round(r.width), height: Math.round(r.height),
        directUrl: entry.directUrl, directKind: entry.directCand ? entry.directCand.kind : null,
        directPlayable: !!(entry.directCand && entry.directCand.playable), isBlob: entry.isBlob, isStreamObject: entry.isStreamObject,
        availability: entry.availability, wireless: entry.wireless || !!(proxy && proxy.active && proxy.wireless && proxy.original === entry.el),
        paused: entry.el.paused, currentTime: entry.el.currentTime, duration: entry.el.duration,
        strategy: pl.strategy, best: pl.cand ? pub(pl.cand) : null, playableNow: pl.strategy !== 'none', unblocked: entry.unblocked,
      });
    }
    return {
      type: 'report', reset: firstReport,
      frame: { isTop: IS_TOP, url: location.href, title: IS_TOP ? document.title : '' },
      videos, streams: rankedStreams().slice(0, 40).map(pub),
      hookAlive, hasPicker: HAS_PICKER, hasNativeFullscreen: HAS_NATIVE_FS, isIOS: IS_IOS,
      proxyActive: !!(proxy && proxy.active), proxyUrl: proxy && proxy.active ? proxy.url : null,
      proxyFor: proxy && proxy.active && proxy.original && entries.get(proxy.original) ? entries.get(proxy.original).id : null, hiddenHere,
    };
  }
  function sendReport() {
    if (!B.runtime || !B.runtime.id) return;
    try {
      const p = B.runtime.sendMessage(buildState());
      if (p && p.catch) p.catch(() => {});
      firstReport = false;
    } catch (e) {}
  }

  try {
    B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'ping': sendResponse({ ok: true, frame: location.href }); return;
        case 'getState': sendResponse(buildState()); return;
        case 'rescan': rescan(); setTimeout(() => sendResponse(buildState()), 250); return true;
        case 'airplay': {
          const entry = msg.videoId != null ? findEntry(msg.videoId) : null;
          if (!entry && !msg.url) { sendResponse({ ok: false, error: 'no-video' }); return; }
          const res = msg.url ? airplayViaProxy(msg.url, entry) : doPrimary(entry);
          sendResponse(Object.assign({ ok: true }, res)); return;
        }
        case 'nativePlayer': { const entry = findEntry(msg.videoId); if (entry) nativePlayer(entry); sendResponse({ ok: !!entry }); return; }
        case 'highlight': { const entry = findEntry(msg.videoId); if (entry) highlight(entry); sendResponse({ ok: !!entry }); return; }
        case 'stop': stopProxy(true); sendResponse({ ok: true }); return;
        case 'setHidden': hiddenHere = !!msg.hidden; updateBadges(); scheduleReport(); sendResponse({ ok: true }); return;
      }
    });
  } catch (e) {}

  // ----------------------------------------------------------------- boot
  try {
    mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'VIDEO' || n.tagName === 'IFRAME' || (n.querySelector && n.querySelector('video')) || n.shadowRoot) { scheduleScan(); return; }
            if (n.tagName === 'SOURCE' && n.parentElement && n.parentElement.tagName === 'VIDEO') { const en = entries.get(n.parentElement); if (en) refreshElementSource(en); }
          }
          for (const n of m.removedNodes) { if (n.nodeType === 1 && (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video')))) { scheduleScan(); return; } }
        } else if (m.type === 'attributes' && m.target && m.target.tagName === 'VIDEO') {
          const en = entries.get(m.target);
          if (en) { refreshElementSource(en); if (settings.autoUnblock && (m.attributeName === 'disableremoteplayback' || m.attributeName === 'x-webkit-airplay')) unblock(en); }
          else scheduleScan();
        }
      }
    });
    mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'disableremoteplayback', 'x-webkit-airplay'] });
  } catch (e) {}
  for (const ev of ['loadstart', 'loadedmetadata', 'play', 'playing']) {
    document.addEventListener(ev, (e) => { const el = e.target; if (el instanceof HTMLVideoElement && !entries.has(el) && !isOurs(el)) register(el); }, true);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleScan(100); });
  setInterval(() => { if (document.visibilityState === 'visible') scheduleScan(0); }, 4000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scheduleScan(0));
  else scheduleScan(0);
  window.addEventListener('load', () => { scheduleScan(500); setTimeout(drainPerf, 1500); });
  scheduleReport();
})();
