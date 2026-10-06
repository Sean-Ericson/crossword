/*
 * puzzles.mjs — server-side puzzle access: parse .puz files with the same
 * parser/model the browser uses (for solution checks), download missing
 * puzzles on demand, and run the daily archive update. Downloading is done
 * by the existing Python tools (tools/fetch_one.py, update_puzzles.py).
 *
 * Custom puzzles (custom-… ids) come from the database instead: the copy
 * their authors last published (js/custom-puzzle.js docToPuz). Drafts
 * have no model; nothing is ever read from disk for them.
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { docToPuz, isCustomId } from '../js/custom-puzzle.js';
import { SITE_DIR } from './config.mjs';

export const PUZZLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class Puzzles {
  /** @param {{log?: Console, store?: import('./db.mjs').Store}} [opts] store: for custom puzzles */
  constructor(cfg, { log = console, store = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.store = store;
    this.cache = new Map(); // id -> PuzzleModel (small LRU)
    this.inflight = new Map(); // id -> Promise of a fetch
  }

  file(id) {
    return path.join(this.cfg.puzzlesDir, `${id}.puz`);
  }

  /** @returns {Promise<PuzzleModel|null>} */
  async model(id) {
    if (!PUZZLE_ID_RE.test(id)) return null;
    if (this.cache.has(id)) {
      const m = this.cache.get(id);
      this.cache.delete(id);
      this.cache.set(id, m);
      return m;
    }
    const model = isCustomId(id) ? this.customModel(id) : await this.fileModel(id);
    if (!model) return null;
    this.cache.set(id, model);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return model;
  }

  async fileModel(id) {
    let bytes;
    try {
      bytes = await readFile(this.file(id));
    } catch {
      return null;
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new PuzzleModel(parsePuz(buf));
  }

  customModel(id) {
    const doc = this.store?.customPublished(id);
    return doc ? new PuzzleModel(docToPuz(doc)) : null;
  }

  /** Drop a cached model (a custom puzzle was published again). */
  forget(id) {
    this.cache.delete(id);
  }

  runPython(args, { timeoutMs = 5 * 60_000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn(this.cfg.python, args, { cwd: SITE_DIR, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * Download one puzzle from NYT. Concurrent requests for the same id share
   * one download.
   * @returns {Promise<{status:'done'|'missing'|'error', message?:string, id?:string}>}
   */
  fetch(id) {
    if (!PUZZLE_ID_RE.test(id)) return Promise.resolve({ status: 'error', message: 'Bad puzzle id.' });
    if (isCustomId(id)) return Promise.resolve({ status: 'missing', message: 'Puzzles made here aren’t downloaded.' });
    if (this.inflight.has(id)) return this.inflight.get(id);
    const job = (async () => {
      const { code, stdout, stderr } = await this.runPython([
        path.join('tools', 'fetch_one.py'),
        id,
        '--browser', this.cfg.nytBrowser,
        '--nytxw', this.cfg.nytxwPath,
      ]);
      const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        result = { status: 'error', message: (stderr || `fetcher exited with code ${code}`).trim().slice(-300) };
      }
      this.log.info?.(`fetch ${id}: ${result.status}${result.message ? ` (${result.message})` : ''}`);
      return result;
    })().finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }

  /** The daily archive update (what daily_update.bat used to do). */
  async dailyUpdate() {
    this.log.info?.('daily puzzle update: starting');
    const { code, stdout, stderr } = await this.runPython(
      [
        path.join('tools', 'update_puzzles.py'),
        this.cfg.nytBrowser,
        '--no-git',
        '--nytxw', this.cfg.nytxwPath,
      ],
      { timeoutMs: 30 * 60_000 }
    );
    const tail = (stdout + stderr).trim().split('\n').slice(-3).join(' | ');
    this.log.info?.(`daily puzzle update: exit ${code} — ${tail}`);
    return code === 0;
  }
}

/**
 * Run `fn` every day at local "HH:MM". Returns a cancel function.
 * Re-arms after each run, so DST shifts and sleeps are handled.
 */
export function scheduleDaily(hhmm, fn, { log = console } = {}) {
  if (!hhmm) return () => {};
  const [h, m] = hhmm.split(':').map(Number);
  let timer = null;
  const arm = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    timer = setTimeout(async () => {
      try {
        await fn();
      } catch (err) {
        log.error?.(`scheduled job failed: ${err.stack || err}`);
      }
      arm();
    }, next - now);
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}
