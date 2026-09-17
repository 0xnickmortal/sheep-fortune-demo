// Serves dist-share/ on 127.0.0.1:4319 for a local look at the shareable static build.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('dist-share'), port = Number(process.env.PORT || 4319);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  let path = resolve(root, '.' + decodeURIComponent(pathname));
  if (pathname.endsWith('/')) path = resolve(path, 'index.html');
  if (!path.startsWith(root + sep)) { res.writeHead(403); return res.end('Forbidden'); }
  try { const body = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Share build preview: http://127.0.0.1:${port}/`));
