import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { openDatabase } from './local-d1.mjs';
import worker from '../server/worker.js';
import { serverSkinPage } from './frontend-entry.mjs';
await mkdir('.data', { recursive: true });
const db = openDatabase('.data/game.sqlite'), port = Number(process.env.PORT || 4318), root = resolve('public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const env = { ...process.env, TRUST_PLATFORM_IDENTITY: 'true', DB: db, ASSETS: { async fetch(req) { const url = new URL(req.url); let path = resolve(root, '.' + decodeURIComponent(['/','/index.html'].includes(url.pathname) ? '/red/index.html' : url.pathname)); if (url.pathname !== '/' && url.pathname.endsWith('/')) path = resolve(path, 'index.html'); if (!path.startsWith(root + sep)) return new Response('Forbidden', { status: 403 }); try { const content=await readFile(path); return new Response(extname(path)==='.html'?serverSkinPage(content.toString('utf8')):content, { headers: { 'Content-Type': types[extname(path)] || 'application/octet-stream' } }); } catch { return new Response('Not found', { status: 404 }); } } } };
const server = http.createServer(async (req, res) => {
  try {
    const headers = new Headers(req.headers); headers.set('oai-authenticated-user-id', 'local-preview');
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req, duplex: 'half' } : {}) });
    const result = await worker.fetch(request, env); res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500); res.end('Server error'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Game API and mobile preview: http://127.0.0.1:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(); }));
