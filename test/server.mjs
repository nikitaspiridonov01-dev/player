import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml', '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.css': 'text/css',
};

export function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      if (p.endsWith(path.sep) || (await stat(p)).isDirectory()) p = path.join(p, 'index.html');
      const data = await readFile(p);
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(data);
    } catch (e) {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer(Number(process.env.PORT) || 8099);
  console.log('serving test fixtures at', origin);
}
