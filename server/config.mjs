/*
 * config.mjs — server settings. Defaults below, overridden by
 * server/config.json (gitignored; see config.example.json), overridden by
 * XWORD_* environment variables for the few things worth setting that way.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = path.dirname(SERVER_DIR);

const DEFAULTS = {
  // Loopback by default (local testing). When the site is published
  // through Cloudflare, set "0.0.0.0" so the tunnel/proxy on the LAN can
  // reach it; see DEPLOY.md.
  host: '127.0.0.1',
  port: 8080,
  // The address people use, e.g. "https://crossword.ho.house". When set:
  // cookies are marked Secure if it's https, and WebSocket connections
  // from pages served there are accepted even if the proxy rewrites Host.
  publicUrl: null,
  dataDir: path.join(SERVER_DIR, 'data'),
  puzzlesDir: path.join(SITE_DIR, 'puzzles'),
  // Python + nytxw_puz do the NYT downloading (tools/*.py).
  python: '',
  nytxwPath: path.join(path.dirname(SITE_DIR), 'nytxw_puz'),
  // Where NYT cookies come from: a browser name nytxw_puz knows
  // ("Firefox", "Chrome", ...) or "Cached Cookies" to read the JSON file
  // nytxw_puz caches - the option for a headless Linux box.
  nytBrowser: 'Firefox',
  // Local "HH:MM" for the daily download and the nightly backup; null = off.
  dailyUpdateAt: '23:30',
  backupAt: '04:00',
  keepBackups: 14,
  sessionDays: 30,
  // Trust forwarding headers from the proxy in front of us: the real
  // client address comes from `clientIpHeader` (Cloudflare sets
  // CF-Connecting-IP), else X-Forwarded-For; https from X-Forwarded-Proto.
  trustProxy: true,
  clientIpHeader: 'cf-connecting-ip',
  // 'auto' = Secure cookies when publicUrl is https, or the request came in
  // over https.
  secureCookies: 'auto',
};

function detectPython() {
  const candidates = [
    process.env.XWORD_PYTHON,
    path.join(os.homedir(), 'miniconda3', process.platform === 'win32' ? 'python.exe' : 'bin/python'),
    path.join(os.homedir(), 'anaconda3', process.platform === 'win32' ? 'python.exe' : 'bin/python'),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function loadConfig(overrides = {}) {
  let fromFile = {};
  const file = process.env.XWORD_CONFIG || path.join(SERVER_DIR, 'config.json');
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8'));
  }
  const cfg = { ...DEFAULTS, ...fromFile, ...overrides };
  if (process.env.XWORD_PORT) cfg.port = Number(process.env.XWORD_PORT);
  if (process.env.XWORD_HOST) cfg.host = process.env.XWORD_HOST;
  if (process.env.XWORD_DATA_DIR) cfg.dataDir = process.env.XWORD_DATA_DIR;
  if (process.env.XWORD_PUBLIC_URL) cfg.publicUrl = process.env.XWORD_PUBLIC_URL;
  if (cfg.publicUrl) cfg.publicUrl = new URL(cfg.publicUrl).origin; // validate + normalize
  if (!cfg.python) cfg.python = detectPython();
  // relative paths in config.json are relative to the site folder
  for (const key of ['dataDir', 'puzzlesDir', 'nytxwPath']) {
    cfg[key] = path.resolve(SITE_DIR, cfg[key]);
  }
  return cfg;
}
