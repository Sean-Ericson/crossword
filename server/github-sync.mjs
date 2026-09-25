/*
 * github-sync.mjs — two-way sync with the old GitHub data repo
 * (crossword-data) while the GitHub Pages site and this server run side by
 * side. Remove the `githubSync` config once everyone has moved over.
 *
 * Every `intervalSec` it:
 *   1. lists the data repo (one API call) and pulls every progress file /
 *      stats.json whose blob changed since the last cycle, merging it into
 *      the user's solo solve with the same mergeProgress / earliest-solve
 *      rules both sites already use;
 *   2. pushes every solo solve that changed on the server since it was last
 *      synced, and stats.json when the server knows solves GitHub doesn't.
 *
 * Only solo solves of users that exist on both sides (same name) take
 * part; co-op solves are server-only. A solve someone has open right now
 * is left alone until they close it (its grid lives in memory), so remote
 * changes to it land a cycle or two later. The old site picks up server
 * changes the next time a puzzle is opened there.
 *
 * Config (server/config.json):
 *   "githubSync": { "repo": "Sean-Ericson/crossword-data", "branch": "main",
 *                   "token": "github_pat_...", "intervalSec": 120 }
 * The token needs Contents read/write on the data repo (the same token the
 * old site uses works). Without "token" it tries XWORD_GITHUB_TOKEN, then
 * `gh auth token`.
 */

import { execFileSync } from 'node:child_process';
import { mergeProgress, mergeStats, recordFitsModel } from '../js/state.js';
import { parsePuzzleId } from '../js/util.js';

const PROGRESS_RE = /^users\/([a-z0-9-]+)\/progress\/[^/]+\/([A-Za-z0-9_-]+)\.json$/;
const STATS_RE = /^users\/([a-z0-9-]+)\/stats\.json$/;

export class ConflictError extends Error {}

export function progressPath(user, puzzleId) {
  const { date } = parsePuzzleId(puzzleId);
  return `users/${user}/progress/${date ? date.slice(0, 4) : 'special'}/${puzzleId}.json`;
}

export function statsPath(user) {
  return `users/${user}/stats.json`;
}

/** Minimal GitHub REST client for one repo + branch. */
export class GitHubRepo {
  constructor({ repo, branch = 'main', token }) {
    this.repo = repo;
    this.branch = branch;
    this.token = token;
  }

  async request(method, apiPath, body) {
    const resp = await fetch(`https://api.github.com/repos/${this.repo}/${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'crossword-server',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 409 || resp.status === 422) throw new ConflictError(`${method} ${apiPath}: ${resp.status}`);
    if (!resp.ok) throw new Error(`GitHub ${method} ${apiPath}: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return resp.json();
  }

  /** @returns {Promise<Map<string,string>>} path -> blob sha */
  async tree() {
    const data = await this.request('GET', `git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    if (data.truncated) throw new Error('data repo listing truncated');
    return new Map(data.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  }

  async readJson(sha) {
    const blob = await this.request('GET', `git/blobs/${sha}`);
    return JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
  }

  /** Create/replace a file; `sha` is what we believe is there now (null = new). -> new blob sha */
  async putJson(path, obj, sha, message) {
    const data = await this.request('PUT', `contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      message,
      content: Buffer.from(JSON.stringify(obj, null, 1), 'utf8').toString('base64'),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    });
    return data.content.sha;
  }
}

export function resolveToken(opts) {
  if (opts.token) return opts.token;
  if (process.env.XWORD_GITHUB_TOKEN) return process.env.XWORD_GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class GitHubSync {
  /**
   * @param {{store, hub, puzzles, gh: GitHubRepo, log?}} deps
   */
  constructor({ store, hub, puzzles, gh, log = console }) {
    this.store = store;
    this.hub = hub;
    this.puzzles = puzzles;
    this.gh = gh;
    this.log = log;
    this.running = false;
    this.unfetchable = new Set(); // puzzle ids the server couldn't download
    this.blobCache = new Map(); // sha -> parsed JSON (blobs never change)
  }

  async readCached(sha) {
    if (!this.blobCache.has(sha)) {
      if (this.blobCache.size > 200) this.blobCache.clear();
      this.blobCache.set(sha, await this.gh.readJson(sha));
    }
    return this.blobCache.get(sha);
  }

  /** Run cycles forever; returns a stop function. */
  start(intervalSec = 120) {
    const tick = () => this.cycle().catch((err) => this.log.error?.(`github sync: ${err.message}`));
    const first = setTimeout(tick, 10_000);
    const timer = setInterval(tick, intervalSec * 1000);
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  async modelFor(puzzleId) {
    let model = await this.puzzles.model(puzzleId);
    if (model || this.unfetchable.has(puzzleId) || !this.puzzles.fetch) return model;
    const result = await this.puzzles.fetch(puzzleId);
    model = result.status === 'done' ? await this.puzzles.model(puzzleId) : null;
    if (!model) this.unfetchable.add(puzzleId);
    return model;
  }

  /** One pull + push pass. @returns counts, for logs and tests */
  async cycle() {
    if (this.running) return null;
    this.running = true;
    const counts = { pulled: 0, pushed: 0, stats: 0, skipped: 0 };
    try {
      const tree = await this.gh.tree();
      const users = new Map(this.store.listUsers().map((u) => [u.name, u]));

      // ----- pull -----
      for (const [path, sha] of tree) {
        const p = PROGRESS_RE.exec(path);
        const s = p ? null : STATS_RE.exec(path);
        const user = users.get((p || s)?.[1]);
        if (!user) continue;
        const row = this.store.ghSyncRow(path);
        if (row?.sha === sha) continue;
        const remote = await this.gh.readJson(sha);
        if (s) {
          for (const [id, entry] of Object.entries(remote?.solves ?? {})) {
            if (entry?.completed_at) this.store.recordSoloSolve(user.id, id, entry);
          }
          this.store.setGhSyncRow(path, sha, null);
          continue;
        }
        if (await this.pullProgress(user, p[2], remote)) {
          this.store.setGhSyncRow(path, sha, this.pendingLocal);
          counts.pulled++;
        } else {
          counts.skipped++;
        }
      }

      // ----- push -----
      for (const user of users.values()) {
        const remoteUserHere = [...tree.keys()].some((k) => k.startsWith(`users/${user.name}/`));
        if (!remoteUserHere) continue; // only people who exist on both sites
        for (const solve of this.store.soloSolvesOf(user.id)) {
          if (this.hub.isBusy(solve.id) && !this.hub.liveRecord(solve.id)) continue;
          const record = this.hub.liveRecord(solve.id) ?? solve.record;
          if (!record?.updated_at) continue; // pristine: nothing to share
          const path = progressPath(user.name, solve.puzzle_id);
          const row = this.store.ghSyncRow(path);
          if (row && row.local_updated_at === record.updated_at) continue;
          if (tree.has(path) && tree.get(path) !== row?.sha) continue; // changed remotely: pull first
          try {
            const newSha = await this.gh.putJson(
              path,
              { ...record, user: user.name },
              tree.get(path) ?? null,
              `server: ${user.name} ${solve.puzzle_id} ${record.completed ? `solved in ${record.elapsed}s` : `progress (${record.elapsed}s)`}`
            );
            this.store.setGhSyncRow(path, newSha, record.updated_at);
            counts.pushed++;
          } catch (err) {
            if (!(err instanceof ConflictError)) throw err; // conflicts: next cycle pulls, merges, retries
          }
        }

        const sp = statsPath(user.name);
        const local = this.store.statsDoc(user);
        if (!Object.keys(local.solves).length) continue;
        const remoteDoc = tree.has(sp) ? await this.readCached(tree.get(sp)) : null;
        const merged = mergeStats(remoteDoc, local);
        const changed = Object.entries(merged.solves).some(
          ([id, e]) => remoteDoc?.solves?.[id]?.completed_at !== e.completed_at
        );
        if (!changed) continue;
        try {
          const newSha = await this.gh.putJson(sp, { ...merged, user: user.name }, tree.get(sp) ?? null,
            `server: ${user.name} stats (${Object.keys(merged.solves).length} solves)`);
          this.store.setGhSyncRow(sp, newSha, null);
          counts.stats++;
        } catch (err) {
          if (!(err instanceof ConflictError)) throw err;
        }
      }
      if (counts.pulled || counts.pushed || counts.stats) {
        this.log.info?.(`github sync: pulled ${counts.pulled}, pushed ${counts.pushed}, stats ${counts.stats}`);
      }
      return counts;
    } finally {
      this.running = false;
    }
  }

  /**
   * Merge one remote progress record into the user's solo solve.
   * Sets this.pendingLocal to the server updated_at that now matches GitHub
   * (null when the merge added something GitHub lacks, so it gets pushed).
   * @returns {Promise<boolean>} false = try again next cycle
   */
  async pullProgress(user, puzzleId, remote) {
    const model = await this.modelFor(puzzleId);
    if (!model || !recordFitsModel(remote, model)) {
      // puzzle unobtainable or record unusable: mark it seen, nothing to merge
      this.pendingLocal = null;
      return true;
    }
    const incoming = { ...remote, user: user.name, puzzle_id: puzzleId };
    const existing = this.store.soloSolve(user.id, puzzleId);
    if (existing && this.hub.isBusy(existing.id)) return false; // open right now
    if (!existing) {
      this.store.createSolve({
        puzzleId, kind: 'solo', ownerId: user.id, createdBy: user.id, memberIds: [user.id], record: incoming,
      });
      this.pendingLocal = incoming.updated_at;
      return true;
    }
    const current = recordFitsModel(existing.record, model) ? existing.record : null;
    const winner = current ? mergeProgress(current, incoming) : incoming;
    if (winner !== current) this.store.saveRecord(existing.id, winner);
    this.pendingLocal = sameJson(winner, incoming) ? winner.updated_at : null;
    return true;
  }
}
