// Standalone server for a built site: static files from dist/ plus the API proxy.
// Run with `npm run build && npm start` (keys come from .env via --env-file).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';

const PORT = Number(process.env.PORT || 3000);
const DIST = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const api = createApi(process.env);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(res, urlPath) {
  let filePath = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  let full = join(DIST, filePath);
  if (!full.startsWith(DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const info = await stat(full).catch(() => null);
    // Single-page app: unknown paths fall back to index.html.
    if (!info?.isFile()) full = join(DIST, 'index.html');
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Run `npm run build` first.');
  }
}

createServer(async (req, res) => {
  if (await api(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  await serveStatic(res, new URL(req.url, 'http://localhost').pathname);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`play-with-ai listening on http://127.0.0.1:${PORT}`);
});
