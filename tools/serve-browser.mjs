import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../output/browser/', import.meta.url));
const port = Number(process.env.BROWSER_PORT || 4318);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.json': 'application/json', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end('Static preview only'); return; }
    const pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    if (relative.includes('\\') || relative.includes('\0')) throw new Error('Invalid path');
    const target = path.resolve(root, relative);
    const inside = path.relative(root, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Invalid path');
    const file = await stat(target);
    if (!file.isFile()) throw new Error('Not a file');
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Content-Length': file.size,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': relative.includes('pandoc.wasm') ? 'public, max-age=86400' : 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : await readFile(target));
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`浏览器版预览：http://127.0.0.1:${port}/\n这里仅提供静态文件，Word 转换在浏览器中完成。`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
