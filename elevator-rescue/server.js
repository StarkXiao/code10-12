// 入口：HTTP 服务（API + 静态页面）+ 升级扫描
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDb, saveDb } from './src/store.js';
import { createSseHub } from './src/sse.js';
import { createRouter } from './src/routes.js';
import { startEscalation } from './src/escalation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);

const db = loadDb();
const hub = createSseHub();
const ctx = {
  db,
  hub,
  save: () => saveDb(db),
  broadcast: (type, data) => hub.broadcast(type, data),
};
const router = createRouter(ctx);
startEscalation(ctx);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  if (pathname.startsWith('/api/')) {
    const t0 = Date.now();
    res.on('finish', () => console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - t0}ms)`));
    return router(req, res, pathname, u.searchParams);
  }

  // 静态页面
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`电梯困人救援调度系统已启动 → http://localhost:${PORT}`);
  console.log(`到场 SLA：${process.env.ARRIVE_SLA_MIN || 30} 分钟；数据目录：${process.env.DATA_DIR || 'data/'}`);
});
