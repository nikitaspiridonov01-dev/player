/*
 * AirPlay Any Video — shared stream classification.
 *
 * Loaded in three contexts:
 *   - content scripts (plain <script> via manifest "js" array → globalThis.AirPlayAny)
 *   - background service worker (importScripts)
 *   - popup page (<script>)
 *   - Node tests (module.exports)
 *
 * AirPlay (sending a URL to an Apple TV / HomePod / AirPlay TV) only works for media the
 * receiver can fetch and decode itself: HTTP Live Streaming playlists (.m3u8) and
 * progressive MP4/MOV/M4V files. DASH, WebM, raw segments and blob: URLs are not playable.
 */
(function (root, factory) {
  const api = factory();
  root.AirPlayAny = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KIND = Object.freeze({
    HLS_MASTER: 'hls-master',
    HLS_MEDIA: 'hls-media',
    HLS: 'hls',
    MP4: 'mp4',
    DIRECT: 'direct',       // <video src> that the browser is actually playing (non-blob) — playable by definition
    DASH: 'dash',
    WEBM: 'webm',
    SEGMENT: 'segment',
    BLOB: 'blob',
    UNKNOWN: 'unknown',
  });

  // Higher = better candidate for AirPlay.
  const SCORE = Object.freeze({
    [KIND.HLS_MASTER]: 100,
    [KIND.HLS]: 90,
    [KIND.DIRECT]: 85,
    [KIND.HLS_MEDIA]: 80,
    [KIND.MP4]: 70,
    [KIND.DASH]: 10,
    [KIND.WEBM]: 5,
    [KIND.UNKNOWN]: 2,
    [KIND.SEGMENT]: 0,
    [KIND.BLOB]: 0,
  });

  const PLAYABLE = new Set([KIND.HLS_MASTER, KIND.HLS, KIND.HLS_MEDIA, KIND.MP4, KIND.DIRECT]);

  const MEDIA_EXT_RE = /\.(m3u8|m3u|mpd|mp4|m4v|mov|webm|mkv|ogv|ogg|ts|m4s|m4a|aac|mp3|flv|avi|3gp|f4m|f4v|ismv|isma)$/i;
  const SEGMENT_HINT_RE = /(^|[\/_\-.])(seg(ment)?s?|frag(ment)?s?|chunk(s)?|init|media_\d|part\d|sq\/\d|range=|bytestart=|byteend=|\/dash\/|\.m4s$|\.ts$|\.cmfv$|\.cmfa$)/i;
  const MASTER_NAME_RE = /(^|[\/_\-.])(master|index|playlist|manifest|main|stream|hls|video|live|adaptive|multi|all|abr)(\.m3u8)$/i;
  const MEDIA_NAME_RE = /(chunklist|prog_index|media[_-]?\d|_v\d|\/v\d\/|\d{3,4}p|\d{3,4}k|audio|aud_|vid_|_video_|_audio_|tracks-|rendition)/i;
  const TEXT_MANIFEST_CT_RE = /(mpegurl|dash\+xml|vnd\.apple\.mpegurl|x-mpegurl|application\/f4m)/i;

  function safeUrl(input, base) {
    if (!input || typeof input !== 'string') return null;
    try {
      const u = new URL(input, base || undefined);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'blob:' && u.protocol !== 'data:') return null;
      return u;
    } catch (e) {
      return null;
    }
  }

  function extOf(u) {
    const m = u.pathname.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : '';
  }

  /** Quick pre-filter: does this URL look like it might be media at all? */
  function looksLikeMedia(url, contentType) {
    const u = safeUrl(url);
    if (!u) return false;
    if (u.protocol === 'blob:') return true;
    if (u.protocol === 'data:') return false;
    if (contentType && /^(video|audio)\//i.test(contentType)) return true;
    if (contentType && TEXT_MANIFEST_CT_RE.test(contentType)) return true;
    if (MEDIA_EXT_RE.test(u.pathname)) return true;
    // Common CDN patterns with no extension
    if (/videoplayback|\/hls\/|\/dash\/|manifest|playlist|\.m3u8|\.mpd|mime=video/i.test(u.pathname + u.search)) return true;
    return false;
  }

  /**
   * Parse an HLS playlist body.
   * @returns {{isMaster:boolean, isMedia:boolean, variants:Array<{bandwidth:number,width:number,height:number,codecs:string}>, isLive:boolean, hasKey:boolean}}
   */
  function parseM3U8(body) {
    const out = { isMaster: false, isMedia: false, variants: [], isLive: false, hasKey: false, maxHeight: 0 };
    if (!body || typeof body !== 'string') return out;
    const lines = body.split(/\r?\n/);
    if (!/^﻿?#EXTM3U/.test(lines[0] || '')) return out;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        out.isMaster = true;
        const attrs = line.slice('#EXT-X-STREAM-INF:'.length);
        const bw = /(?:^|,)(?:AVERAGE-)?BANDWIDTH=(\d+)/.exec(attrs);
        const res = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
        const codecs = /CODECS="([^"]*)"/.exec(attrs);
        const v = {
          bandwidth: bw ? parseInt(bw[1], 10) : 0,
          width: res ? parseInt(res[1], 10) : 0,
          height: res ? parseInt(res[2], 10) : 0,
          codecs: codecs ? codecs[1] : '',
          uri: (lines[i + 1] || '').trim(),
        };
        out.variants.push(v);
        if (v.height > out.maxHeight) out.maxHeight = v.height;
      } else if (line.startsWith('#EXTINF:')) {
        out.isMedia = true;
      } else if (line.startsWith('#EXT-X-KEY:') && !/METHOD=NONE/.test(line)) {
        out.hasKey = true;
      } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
        out.hasKey = true;
      }
    }
    if (out.isMedia && !lines.some((l) => l.trim() === '#EXT-X-ENDLIST')) out.isLive = true;
    return out;
  }

  /**
   * Classify a media URL.
   * @param {string} url
   * @param {{contentType?:string, body?:string, isElementSource?:boolean, playing?:boolean}} [info]
   */
  function classify(url, info) {
    info = info || {};
    const u = safeUrl(url);
    if (!u) return { kind: KIND.UNKNOWN, playable: false, score: 0, url: String(url || '') };

    const result = { url: u.href, kind: KIND.UNKNOWN, playable: false, score: 0, detail: null };
    const ct = (info.contentType || '').toLowerCase().split(';')[0].trim();
    const ext = extOf(u);
    const pathAndQuery = u.pathname + u.search;

    if (u.protocol === 'blob:' || u.protocol === 'data:') {
      result.kind = KIND.BLOB;
    } else if (ext === 'm3u8' || ext === 'm3u' || /mpegurl/.test(ct)) {
      result.kind = KIND.HLS;
      if (info.body) {
        const parsed = parseM3U8(info.body);
        result.detail = parsed;
        if (parsed.isMaster) result.kind = KIND.HLS_MASTER;
        else if (parsed.isMedia) result.kind = KIND.HLS_MEDIA;
      } else if (MEDIA_NAME_RE.test(pathAndQuery)) {
        result.kind = KIND.HLS_MEDIA;
      } else if (MASTER_NAME_RE.test(u.pathname)) {
        result.kind = KIND.HLS_MASTER;
        result.guessed = true;
      }
    } else if (ext === 'mpd' || /dash\+xml/.test(ct)) {
      result.kind = KIND.DASH;
    } else if (ext === 'ts' || ext === 'm4s' || ext === 'cmfv' || ext === 'cmfa' || /video\/mp2t|video\/iso\.segment/.test(ct)) {
      result.kind = KIND.SEGMENT;
    } else if (ext === 'mp4' || ext === 'm4v' || ext === 'mov' || /^video\/(mp4|quicktime|x-m4v)$/.test(ct) || /videoplayback/.test(u.pathname)) {
      result.kind = SEGMENT_HINT_RE.test(pathAndQuery) || /^init\b/i.test(u.pathname.split('/').pop() || '') ? KIND.SEGMENT : KIND.MP4;
      // YouTube-like: adaptive formats come as separate video-only / audio-only ranges
      if (/videoplayback/.test(u.pathname) && (/[?&]range=/.test(u.search) || /mime=audio/.test(u.search))) result.kind = KIND.SEGMENT;
    } else if (ext === 'webm' || ext === 'mkv' || ext === 'ogv' || ext === 'ogg' || ext === 'flv' || ext === 'avi' || /^video\/(webm|x-matroska|ogg|x-flv|x-msvideo)/.test(ct)) {
      result.kind = KIND.WEBM;
    } else if (ext === 'm4a' || ext === 'aac' || ext === 'mp3' || /^audio\//.test(ct)) {
      result.kind = KIND.SEGMENT; // audio-only is not useful for video AirPlay
      result.audioOnly = true;
    } else if (info.isElementSource) {
      // The browser is playing this URL natively → the receiver can too.
      result.kind = KIND.DIRECT;
    }

    if (info.isElementSource && result.kind === KIND.UNKNOWN) result.kind = KIND.DIRECT;
    if (info.isElementSource && result.kind === KIND.WEBM) {
      // Safari may play WebM locally (macOS) but AirPlay receivers can't.
      result.note = 'webm';
    }

    result.playable = PLAYABLE.has(result.kind);
    result.score = SCORE[result.kind] || 0;
    if (result.detail && result.detail.maxHeight) result.score += Math.min(10, result.detail.maxHeight / 240);
    if (result.detail && result.detail.hasKey) { result.encrypted = true; result.score -= 15; }
    if (info.isElementSource) result.isElementSource = true;
    return result;
  }

  /** Human-ish label key for a kind (i18n message name). */
  function kindMessageKey(kind) {
    switch (kind) {
      case KIND.HLS_MASTER: return 'kindHlsMaster';
      case KIND.HLS_MEDIA: return 'kindHlsMedia';
      case KIND.HLS: return 'kindHls';
      case KIND.MP4: return 'kindMp4';
      case KIND.DIRECT: return 'sourceDirect';
      case KIND.DASH: return 'kindDash';
      case KIND.WEBM: return 'kindWebm';
      case KIND.SEGMENT: return 'kindSegment';
      case KIND.BLOB: return 'sourceDirectBlob';
      default: return 'kindUnknown';
    }
  }

  /** Normalise a URL for de-duplication (drop hash; keep query — tokens matter). */
  function dedupeKey(url) {
    const u = safeUrl(url);
    if (!u) return String(url);
    u.hash = '';
    return u.href;
  }

  /** Sort candidates: playable first, then score desc, then most recent. */
  function rank(list) {
    return list.slice().sort((a, b) => {
      if (a.playable !== b.playable) return a.playable ? -1 : 1;
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return (b.seenAt || 0) - (a.seenAt || 0);
    });
  }

  function shortName(url, max) {
    max = max || 60;
    const u = safeUrl(url);
    if (!u) return String(url).slice(0, max);
    let s = u.host + u.pathname;
    if (s.length > max) s = '…' + s.slice(s.length - max + 1);
    return s;
  }

  function formatResolution(detail) {
    if (!detail || !detail.variants || !detail.variants.length) return '';
    const best = detail.variants.reduce((m, v) => (v.height > (m ? m.height : 0) ? v : m), null);
    if (!best || !best.height) return '';
    if (best.height >= 2160) return '4K';
    return best.height + 'p';
  }

  return {
    KIND, SCORE, PLAYABLE,
    looksLikeMedia, classify, parseM3U8, kindMessageKey, dedupeKey, rank, shortName, formatResolution, safeUrl,
    isTextManifest(url, contentType) {
      const u = safeUrl(url);
      if (!u) return false;
      const ext = extOf(u);
      return ext === 'm3u8' || ext === 'm3u' || ext === 'mpd' || TEXT_MANIFEST_CT_RE.test(contentType || '');
    },
  };
});
