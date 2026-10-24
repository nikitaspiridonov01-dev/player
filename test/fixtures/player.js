(async () => {
  document.addEventListener('airplay-any:picker', (e) => { (window.__pickerCalls = window.__pickerCalls || []).push(e.detail); });
  document.addEventListener('airplay-any:native', (e) => { (window.__nativeCalls = window.__nativeCalls || []).push(e.detail); });

  // --- MSE player simulation (what hls.js does) ---
  const mse = document.getElementById('mse');
  const ms = new MediaSource();
  mse.src = URL.createObjectURL(ms);
  await fetch('/hls/master.m3u8').then((r) => r.text());
  await fetch('/hls/1080p/index.m3u8').then((r) => r.text());
  await fetch('/hls/1080p/seg0.ts').then((r) => r.arrayBuffer());

  // --- DASH player simulation via XHR (dash.js style) ---
  const dash = document.getElementById('dash');
  const ms2 = new MediaSource();
  dash.src = URL.createObjectURL(ms2);
  await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open('GET', '/dash/manifest.mpd'); x.onloadend = resolve; x.send(); });

  // --- a video added later by the page ---
  setTimeout(() => {
    const v = document.createElement('video');
    v.id = 'late';
    v.src = '/media/late.mp4';
    v.setAttribute('controls', '');
    document.body.appendChild(v);
  }, 600);
  // --- a video inside an open shadow root, attached and filled later (web-component players) ---
  setTimeout(() => {
    const hostEl = document.createElement('x-player');
    hostEl.id = 'shadow-host';
    hostEl.style.cssText = 'display:block;width:640px;height:360px;margin:16px 0';
    document.body.appendChild(hostEl);
    setTimeout(() => {
      const root = hostEl.attachShadow({ mode: 'open' });
      const v = document.createElement('video');
      v.id = 'sv';
      v.src = '/media/shadow.mp4';
      v.style.cssText = 'width:640px;height:360px;background:#444;display:block';
      root.appendChild(v);
    }, 400);
  }, 800);
  window.__ready = true;
})();
