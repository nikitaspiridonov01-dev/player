/*
 * AirPlay Any Video — page-world hook (runs in the page's own JavaScript world, "MAIN").
 *
 * Registered by background.js via scripting.registerContentScripts({ world: "MAIN" }) (Safari 16.4+).
 * It never modifies responses; it only observes URLs/content-types of fetch()/XHR responses so the
 * content script can learn which HLS/MP4 stream backs an MSE (blob:) player, and reads playlist
 * bodies to tell master playlists from media playlists.
 *
 * Everything is wrapped in try/catch: a failure here must never break the page.
 */
(function () {
  'use strict';
  if (window.__airplayAnyHook) return;
  window.__airplayAnyHook = true;

  var NS = 'airplay-any:v1';
  var MAX_BODY = 512 * 1024;
  var MANIFEST_RE = /\.(m3u8|m3u|mpd)(\?|#|$)/i;
  var MEDIA_RE = /\.(mp4|m4v|mov|webm|mkv|ts|m4s|cmfv)(\?|#|$)|\/videoplayback(\?|$)/i;

  function post(msg) {
    try {
      msg.__airplayAny = NS;
      window.postMessage(msg, '*');
    } catch (e) {}
  }

  function absolutize(u) {
    try { return new URL(String(u), document.baseURI).href; } catch (e) { return null; }
  }

  function isManifestCT(ct) { return /mpegurl|dash\+xml/i.test(ct || ''); }
  function isMediaCT(ct) { return /^(video|audio)\//i.test(ct || ''); }

  function report(url, ct, body) {
    post({ type: 'resource', url: url, contentType: ct || '', body: body || null });
  }

  function inspectResponse(requestUrl, res) {
    if (!res || typeof res !== 'object') return;
    var ct = '';
    try { ct = (res.headers && res.headers.get && res.headers.get('content-type')) || ''; } catch (e) {}
    var abs = absolutize(res.url || requestUrl);
    if (!abs || !/^https?:/.test(abs)) return;
    if (MANIFEST_RE.test(abs) || isManifestCT(ct)) {
      if (res.ok === false) return;
      var clone;
      try { clone = res.clone(); } catch (e) { report(abs, ct); return; }
      clone.text().then(function (txt) {
        report(abs, ct, txt && txt.length > MAX_BODY ? txt.slice(0, MAX_BODY) : txt);
      }, function () { report(abs, ct); });
    } else if (MEDIA_RE.test(abs) || isMediaCT(ct)) {
      report(abs, ct);
    }
  }

  // ---- fetch() ----
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      var hookedFetch = function fetch(input, init) {
        var p = origFetch.apply(this, arguments);
        try {
          var url = typeof input === 'string' ? input : (input && typeof input === 'object' && 'url' in input ? input.url : String(input));
          if (p && typeof p.then === 'function') {
            p.then(function (res) { try { inspectResponse(url, res); } catch (e) {} }, function () {});
          }
        } catch (e) {}
        return p;
      };
      try { hookedFetch.toString = function () { return origFetch.toString(); }; } catch (e) {}
      window.fetch = hookedFetch;
    }
  } catch (e) {}

  // ---- XMLHttpRequest ----
  try {
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__apaUrl = absolutize(url); } catch (e) {}
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var ct = xhr.getResponseHeader('content-type') || '';
            var abs = absolutize(xhr.responseURL || xhr.__apaUrl);
            if (!abs || !/^https?:/.test(abs)) return;
            if (MANIFEST_RE.test(abs) || isManifestCT(ct)) {
              var body = null;
              if (xhr.responseType === '' || xhr.responseType === 'text') body = xhr.responseText;
              else if (xhr.responseType === 'arraybuffer' && xhr.response && typeof TextDecoder !== 'undefined') {
                body = new TextDecoder().decode(new Uint8Array(xhr.response, 0, Math.min(xhr.response.byteLength, MAX_BODY)));
              }
              report(abs, ct, body ? body.slice(0, MAX_BODY) : null);
            } else if (MEDIA_RE.test(abs) || isMediaCT(ct)) {
              report(abs, ct);
            }
          } catch (e) {}
        });
      } catch (e) {}
      return XS.apply(this, arguments);
    };
  } catch (e) {}

  // ---- blob: URLs that are MediaSource / ManagedMediaSource (so we know a blob is MSE, not a file) ----
  try {
    var origCreate = URL.createObjectURL;
    if (typeof origCreate === 'function') {
      URL.createObjectURL = function (obj) {
        var u = origCreate.apply(this, arguments);
        try {
          var MS = window.MediaSource, MMS = window.ManagedMediaSource;
          var isMMS = !!(MMS && obj instanceof MMS);
          if (isMMS || (MS && obj instanceof MS)) post({ type: 'mse', blobUrl: u, managed: isMMS });
        } catch (e) {}
        return u;
      };
    }
  } catch (e) {}

  // ---- Common player globals (best effort, read-only) ----
  function harvestGlobals() {
    try {
      // YouTube: progressive muxed formats + HLS manifest for live streams
      var yt = window.ytInitialPlayerResponse;
      var sd = yt && yt.streamingData;
      if (sd) {
        if (sd.hlsManifestUrl) report(sd.hlsManifestUrl, 'application/vnd.apple.mpegurl');
        (sd.formats || []).forEach(function (f) { if (f && f.url && /video\/mp4/.test(f.mimeType || '')) report(f.url, 'video/mp4'); });
      }
    } catch (e) {}
    try {
      // Vimeo player config
      var vc = window.vimeo && window.vimeo.clip_page_config;
      if (vc && vc.player && vc.player.config_url) { /* config is JSON; the content script will see the HLS URL via fetch hook */ }
    } catch (e) {}
    try {
      // JW Player / video.js style: scan <video><source> of players that keep HLS in data attributes
      var tagged = document.querySelectorAll('[data-hls],[data-m3u8],[data-src$=".m3u8"],[data-stream]');
      for (var i = 0; i < tagged.length && i < 20; i++) {
        var el = tagged[i];
        var v = el.getAttribute('data-hls') || el.getAttribute('data-m3u8') || el.getAttribute('data-src') || el.getAttribute('data-stream');
        if (v && /^https?:|^\/\//.test(v)) report(absolutize(v), '');
      }
    } catch (e) {}
  }

  post({ type: 'hello' });
  if (document.readyState === 'complete') setTimeout(harvestGlobals, 0);
  else window.addEventListener('load', function () { setTimeout(harvestGlobals, 500); });
  window.addEventListener('message', function (e) {
    try {
      if (e.source !== window || !e.data || e.data.__airplayAny !== NS) return;
      if (e.data.type === 'ping') post({ type: 'hello' });
      else if (e.data.type === 'harvest') harvestGlobals();
    } catch (err) {}
  });
})();
