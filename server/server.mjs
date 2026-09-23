/*
 * server.mjs — the self-hosted crossword site: static pages, the REST API
 * (api.mjs), and live solves over WebSocket (/ws, rooms.mjs).
 *
 * Meant to run behind a reverse proxy (Caddy, see deploy/) that terminates
 * HTTPS; it listens on 127.0.0.1 by default.
 *
 *   npm start                       (or: node server/server.mjs)
 *   node server/admin.mjs add-user <name>   to create accounts
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { loadConfig, SITE_DIR } from './config.mjs';
import { Store } from './db.mjs';
import { LoginLimiter, userFromRequest } from './auth.mjs';
import { Puzzles, scheduleDaily } from './puzzles.mjs';
import { Hub } from './rooms.mjs';
import { makeApi } from './api.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.puz': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Only these are ever served; tools/, server/, secrets etc. never are.
const PUBLIC_PAGES = new Set(['/login.html']);
const PAGES = new Set(['/index.html', '/puzzle.html', '/stats.html', '/login.html']);
const PUBLIC_DIRS = ['/css/', '/js/'];
const PRIVATE_DIRS = ['/puzzles/']; // NYT content: members only

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

export function createServer(cfg, { store, puzzles, hub } = {}) {
  store ??= new Store(path.join(cfg.dataDir, 'crossword.db'));
  puzzles ??= new Puzzles(cfg, { log });
  hub ??= new Hub({ store, puzzles, log });
  const limiter = new LoginLimiter();
  const handleApi = makeApi({ cfg, store, hub, puzzles, limiter, log });

  async function serveStatic(req, res, url) {
    let pathname;
    try {
      pathname = path.posix.normalize(decodeURIComponent(url.pathname));
    } catch {
      return notFound(res);
    }
    if (pathname === '/') pathname = '/index.html';
    if (pathname.includes('\0') || pathname.includes('..')) return notFound(res);

    const isPage = PAGES.has(pathname);
    const isPublicAsset = PUBLIC_DIRS.some((d) => pathname.startsWith(d));
    const isPrivateAsset = PRIVATE_DIRS.some((d) => pathname.startsWith(d));
    if (!isPage && !isPublicAsset && !isPrivateAsset) return notFound(res);

    if ((isPage && !PUBLIC_PAGES.has(pathname)) || isPrivateAsset) {
      if (!userFromRequest(store, req)) {
        if (isPage) {
          const next = encodeURIComponent(url.pathname + url.search);
          res.writeHead(302, { Location: `/login.html?next=${next}` });
          return res.end();
        }
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        return res.end('Please log in.');
      }
    }

    const root = isPrivateAsset ? cfg.puzzlesDir : SITE_DIR;
    const rel = isPrivateAsset ? pathname.slice('/puzzles/'.length) : pathname.slice(1);
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) return notFound(res);

    let info;
    try {
      info = await stat(file);
      if (!info.isFile()) return notFound(res);
    } catch {
      return notFound(res);
    }
    const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      // revalidate every time: cheap 304s, and deploys show up at once
      'Cache-Control': 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (isPage) headers['X-Frame-Options'] = 'DENY';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (await handleApi(req, res, url)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      await serveStatic(req, res, url);
    } catch (err) {
      log.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  // ----- live solves -----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://local');
    const user = url.pathname === '/ws' ? userFromRequest(store, req) : null;
    // Browsers always send Origin on WebSocket requests; refuse other sites
    // so a page elsewhere can't ride a visitor's session cookie.
    const origin = req.headers.origin;
    let sameOrigin = false;
    try {
      sameOrigin = !!origin && new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!user || !sameOrigin) {
      socket.write(`HTTP/1.1 ${user ? 403 : 401} ${user ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, user));
  });

  function onSocket(ws, user) {
    const conn = hub.connect(user, (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    // Messages are handled strictly in order: a join has to finish before
    // the edits that follow it are applied.
    let queue = Promise.resolve();
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      queue = queue.then(() => hub.handle(conn, msg));
    });
    ws.on('close', () => {
      queue = queue.then(() => hub.disconnect(conn));
    });
  }

  // drop connections that went away without a close (sleeping laptops)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  server.on('close', () => clearInterval(heartbeat));

  return { server, store, hub, puzzles, wss };
}

/** Nightly online backup; keeps the newest `keep` files. */
export async function backup(store, cfg) {
  const dir = path.join(cfg.dataDir, 'backups');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `crossword-${stamp}.db`);
  store.backupTo(file);
  const old = (await readdir(dir)).filter((f) => f.startsWith('crossword-') && f.endsWith('.db')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - cfg.keepBackups))) {
    await unlink(path.join(dir, f)).catch(() => {});
  }
  log.info(`backup written: ${file}`);
}

async function main() {
  const cfg = loadConfig();
  const app = createServer(cfg);
  const { server, store, hub, puzzles } = app;

  scheduleDaily(cfg.dailyUpdateAt, () => puzzles.dailyUpdate(), { log });
  scheduleDaily(cfg.backupAt, () => backup(store, cfg), { log });
  setInterval(() => store.pruneSessions(), 6 * 3600_000).unref();

  const users = store.listUsers();
  if (!users.length) {
    log.info('No accounts yet — create one with:  node server/admin.mjs add-user <name> --admin');
  }

  server.listen(cfg.port, cfg.host, () => {
    log.info(`crossword server on http://${cfg.host}:${cfg.port}  (data: ${cfg.dataDir})`);
  });

  const shutdown = () => {
    log.info('shutting down');
    hub.flushAll();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
