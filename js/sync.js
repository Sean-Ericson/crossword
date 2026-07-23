/*
 * sync.js — orchestrates GitHub persistence on top of github.js.
 *
 * Data repo layout:
 *   users/<name>/profile.json
 *   users/<name>/progress/<yyyy>/<puzzle-id>.json   (yyyy = 'special' for
 *                                                    non-dated ids)
 *   users/<name>/stats.json
 *
 * Without a configured token every method is a cheap no-op and status is
 * 'local-only' — the app must work fully offline.
 */

import { GitHubClient, ConflictError, AuthError } from './github.js';
import { SITE_CONFIG } from './config.js';
import { mergeProgress, mergeStats, newStatsDoc } from './state.js';
import { isoNow, dateFromId } from './util.js';

const GH_KEY = 'xw:site:gh';

export function loadGhConfig() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(GH_KEY) || 'null');
  } catch {
    stored = null;
  }
  return {
    owner: stored?.owner ?? SITE_CONFIG.data.owner,
    repo: stored?.repo ?? SITE_CONFIG.data.repo,
    branch: stored?.branch ?? SITE_CONFIG.data.branch,
    token: stored?.token ?? '',
  };
}

export function saveGhConfig(cfg) {
  localStorage.setItem(GH_KEY, JSON.stringify(cfg));
}

export function clearGhToken() {
  const cfg = loadGhConfig();
  cfg.token = '';
  saveGhConfig(cfg);
}

export function progressPath(user, puzzleId) {
  const year = dateFromId(puzzleId) ? puzzleId.slice(0, 4) : 'special';
  return `users/${user}/progress/${year}/${puzzleId}.json`;
}

export function statsPath(user) {
  return `users/${user}/stats.json`;
}

export class Sync {
  constructor(user) {
    this.user = user;
    this.status = 'local-only';
    this.statusCbs = [];
    this.lastError = '';
    const cfg = loadGhConfig();
    this.client =
      cfg.token && cfg.owner && cfg.repo ? new GitHubClient(cfg) : null;
    if (this.client) this.status = 'idle';
  }

  get active() {
    return !!this.client;
  }

  onStatus(cb) {
    this.statusCbs.push(cb);
    cb(this.status, this.lastError);
    return this;
  }

  setStatus(status, error = '') {
    this.status = status;
    this.lastError = error;
    for (const cb of this.statusCbs) cb(status, error);
  }

  fail(err) {
    if (err instanceof AuthError) {
      this.setStatus('auth-error', err.message);
    } else {
      this.setStatus('error', err.message);
    }
  }

  /** @returns {Promise<object|null>} the remote record, or null */
  async pullProgress(puzzleId) {
    if (!this.client) return null;
    try {
      const file = await this.client.getFile(progressPath(this.user, puzzleId));
      return file?.json ?? null;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /**
   * Push a progress record; on a sha conflict, refetch + merge + retry.
   * @returns {Promise<object>} the record that ended up remote (may be a
   *   merge winner different from the argument)
   */
  async pushProgress(record, { keepalive = false } = {}) {
    if (!this.client) return record;
    const path = progressPath(this.user, record.puzzle_id);
    const message = `${this.user}: ${record.puzzle_id} ${
      record.completed ? `solved in ${record.elapsed}s` : `progress (${record.elapsed}s)`
    }`;
    this.setStatus('syncing');
    let toWrite = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.putFile(path, toWrite, { message, keepalive });
        this.setStatus('idle');
        return toWrite;
      } catch (err) {
        if (err instanceof ConflictError) {
          try {
            const fresh = await this.client.getFile(path); // refreshes sha
            toWrite = mergeProgress(toWrite, fresh?.json ?? null);
          } catch (err2) {
            this.fail(err2);
            return record;
          }
        } else {
          this.fail(err);
          return record;
        }
      }
    }
    this.setStatus('error', 'sync conflict retries exhausted');
    return record;
  }

  /** Merge a local stats doc into the remote stats.json. Returns merged. */
  async pushStats(localDoc) {
    if (!this.client) return localDoc;
    const path = statsPath(this.user);
    this.setStatus('syncing');
    let merged = localDoc;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const remote = await this.client.getFile(path);
        merged = mergeStats(localDoc, remote?.json ?? newStatsDoc(this.user));
        merged.updated_at = isoNow();
        await this.client.putFile(path, merged, {
          message: `${this.user}: stats (${Object.keys(merged.solves).length} solves)`,
          sha: remote?.sha ?? null,
        });
        this.setStatus('idle');
        return merged;
      } catch (err) {
        if (!(err instanceof ConflictError)) {
          this.fail(err);
          return merged;
        }
      }
    }
    this.setStatus('error', 'stats sync conflict retries exhausted');
    return merged;
  }

  /** Ensure users/<name>/profile.json exists (first sync from a profile). */
  async ensureProfile() {
    if (!this.client) return;
    const path = `users/${this.user}/profile.json`;
    try {
      const existing = await this.client.getFile(path);
      if (!existing) {
        await this.client.putFile(
          path,
          {
            schema: 1,
            name: this.user,
            display_name: this.user,
            created_at: isoNow(),
          },
          { message: `${this.user}: create profile`, sha: null }
        );
      }
    } catch (err) {
      // non-fatal; profile.json is informational
      if (err instanceof AuthError) this.fail(err);
    }
  }

  /** @returns {Promise<object|null>} another user's stats doc */
  async pullStats(user = this.user) {
    if (!this.client) return null;
    try {
      const file = await this.client.getFile(statsPath(user));
      return file?.json ?? null;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /** @returns {Promise<string[]>} user folder names in the data repo */
  async listUsers() {
    if (!this.client) return [];
    try {
      const entries = await this.client.listDir('users');
      return entries.filter((e) => e.type === 'dir').map((e) => e.name).sort();
    } catch (err) {
      this.fail(err);
      return [];
    }
  }

  async test() {
    if (!this.client) return { ok: false, error: 'No token configured.' };
    return this.client.testAuth();
  }
}
