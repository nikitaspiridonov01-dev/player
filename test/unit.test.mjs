import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../extension/common/streams.js');

test('HLS master / media / unknown classification', () => {
  assert.equal(S.classify('https://c/v/master.m3u8').kind, S.KIND.HLS_MASTER);
  assert.equal(S.classify('https://c/v/chunklist_w1.m3u8').kind, S.KIND.HLS_MEDIA);
  assert.equal(S.classify('https://c/v/720p/index.m3u8').kind, S.KIND.HLS_MEDIA);
  assert.equal(S.classify('https://c/v/abc.m3u8?token=1').kind, S.KIND.HLS);
  const master = S.classify('https://c/v/abc.m3u8', { body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\na.m3u8\n' });
  assert.equal(master.kind, S.KIND.HLS_MASTER);
  assert.equal(S.formatResolution(master.detail), '1080p');
  const media = S.classify('https://c/v/abc.m3u8', { body: '#EXTM3U\n#EXTINF:6.0,\nseg.ts\n' });
  assert.equal(media.kind, S.KIND.HLS_MEDIA);
  assert.equal(media.detail.isLive, true);
  const enc = S.classify('https://c/v/abc.m3u8', { body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6.0,\nseg.ts\n#EXT-X-ENDLIST\n' });
  assert.equal(enc.encrypted, true);
  assert.equal(enc.detail.isLive, false);
  assert.equal(S.classify('https://c/x', { contentType: 'application/vnd.apple.mpegurl' }).kind, S.KIND.HLS);
});

test('progressive files vs segments', () => {
  assert.equal(S.classify('https://c/v/clip.mp4').kind, S.KIND.MP4);
  assert.equal(S.classify('https://c/v/clip.mov').kind, S.KIND.MP4);
  assert.equal(S.classify('https://c/v/seg-12.m4s').kind, S.KIND.SEGMENT);
  assert.equal(S.classify('https://c/v/init.mp4').kind, S.KIND.SEGMENT);
  assert.equal(S.classify('https://c/v/segment_1.ts').kind, S.KIND.SEGMENT);
  assert.equal(S.classify('https://r.googlevideo.com/videoplayback?itag=137&range=0-9&mime=video%2Fmp4').kind, S.KIND.SEGMENT);
  assert.equal(S.classify('https://r.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4').kind, S.KIND.MP4);
  assert.equal(S.classify('https://c/v/x', { contentType: 'video/mp4' }).kind, S.KIND.MP4);
});

test('unplayable kinds', () => {
  assert.equal(S.classify('https://c/v/manifest.mpd').playable, false);
  assert.equal(S.classify('https://c/v/manifest.mpd').kind, S.KIND.DASH);
  assert.equal(S.classify('https://c/v/a.webm').kind, S.KIND.WEBM);
  assert.equal(S.classify('blob:https://site/uuid').kind, S.KIND.BLOB);
  assert.equal(S.classify('https://c/v/audio.m4a').playable, false);
  assert.equal(S.classify('javascript:alert(1)').kind, S.KIND.UNKNOWN);
});

test('element sources', () => {
  const d = S.classify('https://c/stream?token=abc', { isElementSource: true });
  assert.equal(d.kind, S.KIND.DIRECT);
  assert.equal(d.playable, true);
  const w = S.classify('https://c/a.webm', { isElementSource: true });
  assert.equal(w.playable, false);
});

test('ranking prefers playable and higher score, then recency', () => {
  const list = [
    { url: 'a', kind: S.KIND.SEGMENT, playable: false, score: 0, seenAt: 5 },
    { url: 'b', kind: S.KIND.MP4, playable: true, score: 70, seenAt: 1 },
    { url: 'c', kind: S.KIND.HLS_MASTER, playable: true, score: 100, seenAt: 0 },
    { url: 'd', kind: S.KIND.MP4, playable: true, score: 70, seenAt: 9 },
  ];
  assert.deepEqual(S.rank(list).map((x) => x.url), ['c', 'd', 'b', 'a']);
});

test('looksLikeMedia pre-filter and helpers', () => {
  assert.equal(S.looksLikeMedia('https://c/app.js'), false);
  assert.equal(S.looksLikeMedia('https://c/v.m3u8?x=1'), true);
  assert.equal(S.looksLikeMedia('https://c/api', 'video/mp4'), true);
  assert.equal(S.dedupeKey('https://c/v.m3u8?x=1#frag'), 'https://c/v.m3u8?x=1');
  assert.equal(S.isTextManifest('https://c/v.m3u8'), true);
  assert.equal(S.isTextManifest('https://c/v', 'application/dash+xml'), true);
  assert.equal(S.isTextManifest('https://c/v.mp4'), false);
});
