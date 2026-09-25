/*
 * db.mjs — SQLite persistence (node:sqlite, built into Node; no native
 * build step on Windows or Linux).
 *
 * A "solve" is one shared grid for one puzzle: a solo solve belongs to a
 * single user (at most one per user per puzzle); a co-op solve has any set
 * of members, and any number of co-op solves can exist per puzzle. The grid
 * itself is stored as the same progress-record JSON the browser uses
 * (js/state.js), so fill/marks semantics carry over unchanged.
 *
 * solo_solves is the canonical solo solve log (what stats.json used to
 * be): one row per user per puzzle, written on first completion.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA_VERSION = 2;

// Okabe-Ito-ish palette: distinct under common color-vision deficiencies,
// dark enough to read as a cursor border on white.
export const USER_PALETTE = [
  '#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#7B61FF', '#8C564B',
];

export const USER_NAME_RE = /^[a-z0-9-]{1,24}$/;

export function newId(bytes = 8) {
  return randomBytes(bytes).toString('base64url');
}

export function nowIso() {
  return new Date().toISOString();
}

export function fillPercent(record) {
  let total = 0;
  let filled = 0;
  for (const v of record.fill) {
    if (v === '.') continue;
    total++;
    if (v !== '') filled++;
  }
  return total ? Math.floor((filled * 100) / total) : 0;
}

export class Store {
  /** @param {string} file  path to the .db file, or ':memory:' */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        color        TEXT NOT NULL,
        pw_hash      TEXT NOT NULL,
        is_admin     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS solves (
        id         TEXT PRIMARY KEY,
        puzzle_id  TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('solo', 'coop')),
        owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record     TEXT NOT NULL,
        completed  INTEGER NOT NULL DEFAULT 0,
        pct        INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS solves_solo_unique
        ON solves(owner_id, puzzle_id) WHERE kind = 'solo';
      CREATE INDEX IF NOT EXISTS solves_puzzle ON solves(puzzle_id);
      CREATE TABLE IF NOT EXISTS solve_members (
        solve_id  TEXT NOT NULL REFERENCES solves(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (solve_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS members_user ON solve_members(user_id);
      CREATE TABLE IF NOT EXISTS solo_solves (
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        puzzle_id    TEXT NOT NULL,
        seconds      INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        clean        INTEGER NOT NULL,
        used_check   INTEGER NOT NULL,
        used_reveal  INTEGER NOT NULL,
        PRIMARY KEY (user_id, puzzle_id)
      );
      -- github-sync.mjs: what each file in the old GitHub data repo held when
      -- last synced (blob sha), and the server record's updated_at then
      CREATE TABLE IF NOT EXISTS gh_sync (
        path             TEXT PRIMARY KEY,
        sha              TEXT,
        local_updated_at TEXT
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  close() {
    this.db.close();
  }

  // ---------- users ----------

  createUser({ name, displayName = name, pwHash, isAdmin = false }) {
    if (!USER_NAME_RE.test(name)) {
      throw new Error('Names must be 1-24 chars: lowercase letters, digits, hyphens.');
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const color = USER_PALETTE[count % USER_PALETTE.length];
    const info = this.db
      .prepare(
        'INSERT INTO users (name, display_name, color, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name, displayName, color, pwHash, isAdmin ? 1 : 0, nowIso());
    return this.userById(Number(info.lastInsertRowid));
  }

  userByName(name) {
    return this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) ?? null;
  }

  userById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
  }

  listUsers() {
    return this.db.prepare('SELECT id, name, display_name, color, is_admin, created_at FROM users ORDER BY name').all();
  }

  setPassword(userId, pwHash) {
    this.db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, userId);
    // a password change signs out every other device
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  updateUser(userId, { displayName, color, isAdmin }) {
    const u = this.userById(userId);
    this.db
      .prepare('UPDATE users SET display_name = ?, color = ?, is_admin = ? WHERE id = ?')
      .run(displayName ?? u.display_name, color ?? u.color, isAdmin == null ? u.is_admin : isAdmin ? 1 : 0, userId);
  }

  deleteUser(userId) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  // ---------- sessions ----------

  createSession(tokenHash, userId, expiresAt) {
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, nowIso(), expiresAt);
  }

  sessionUser(tokenHash, now = Date.now()) {
    return (
      this.db
        .prepare(
          `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
           WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
        )
        .get(tokenHash, now) ?? null
    );
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  pruneSessions(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  // ---------- solves ----------

  /** Row -> {id, puzzle_id, kind, owner_id, created_by, record, members:[user rows]} */
  hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      puzzle_id: row.puzzle_id,
      kind: row.kind,
      owner_id: row.owner_id,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      record: JSON.parse(row.record),
      members: this.members(row.id),
    };
  }

  members(solveId) {
    return this.db
      .prepare(
        `SELECT users.id, users.name, users.display_name, users.color FROM solve_members
         JOIN users ON users.id = solve_members.user_id
         WHERE solve_id = ? ORDER BY solve_members.joined_at, users.name`
      )
      .all(solveId);
  }

  solveById(id) {
    return this.hydrate(this.db.prepare('SELECT * FROM solves WHERE id = ?').get(id));
  }

  soloSolve(userId, puzzleId) {
    return this.hydrate(
      this.db
        .prepare("SELECT * FROM solves WHERE kind = 'solo' AND owner_id = ? AND puzzle_id = ?")
        .get(userId, puzzleId)
    );
  }

  /** A user's solo solves with their full records. */
  soloSolvesOf(userId) {
    return this.db
      .prepare("SELECT * FROM solves WHERE kind = 'solo' AND owner_id = ?")
      .all(userId)
      .map((row) => this.hydrate(row));
  }

  isMember(solveId, userId) {
    return !!this.db
      .prepare('SELECT 1 FROM solve_members WHERE solve_id = ? AND user_id = ?')
      .get(solveId, userId);
  }

  /**
   * Insert a solve. For solo solves `memberIds` is just the owner.
   * `record` may be null for a solve whose grid is created lazily by the
   * first person to open it (the server needs the puzzle to size it).
   */
  createSolve({ id = newId(), puzzleId, kind, ownerId = null, createdBy, memberIds, record }) {
    const now = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO solves (id, puzzle_id, kind, owner_id, created_by, created_at, updated_at, record, completed, pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id, puzzleId, kind, ownerId, createdBy, now, record?.updated_at || now,
          JSON.stringify(record ?? null),
          record?.completed ? 1 : 0,
          record ? fillPercent(record) : 0
        );
      const add = this.db.prepare('INSERT OR IGNORE INTO solve_members (solve_id, user_id, joined_at) VALUES (?, ?, ?)');
      for (const uid of memberIds) add.run(id, uid, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.solveById(id);
  }

  addMembers(solveId, userIds) {
    const add = this.db.prepare('INSERT OR IGNORE INTO solve_members (solve_id, user_id, joined_at) VALUES (?, ?, ?)');
    const now = nowIso();
    for (const uid of userIds) add.run(solveId, uid, now);
    return this.members(solveId);
  }

  saveRecord(solveId, record) {
    this.db
      .prepare('UPDATE solves SET record = ?, completed = ?, pct = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(record), record.completed ? 1 : 0, fillPercent(record), record.updated_at || nowIso(), solveId);
  }

  /** Solves a user belongs to; optionally for one puzzle. Light rows (no grid). */
  solvesForUser(userId, puzzleId = null) {
    const rows = this.db
      .prepare(
        `SELECT solves.id, solves.puzzle_id, solves.kind, solves.created_by, solves.created_at,
                solves.updated_at, solves.completed, solves.pct,
                json_extract(solves.record, '$.elapsed') AS elapsed,
                json_extract(solves.record, '$.clean') AS clean,
                json_extract(solves.record, '$.solved_at') AS solved_at
         FROM solves JOIN solve_members ON solve_members.solve_id = solves.id
         WHERE solve_members.user_id = ? ${puzzleId ? 'AND solves.puzzle_id = ?' : ''}
         ORDER BY solves.updated_at DESC`
      )
      .all(...(puzzleId ? [userId, puzzleId] : [userId]));
    return rows.map((r) => ({
      id: r.id,
      puzzle_id: r.puzzle_id,
      kind: r.kind,
      created_at: r.created_at,
      updated_at: r.updated_at,
      completed: !!r.completed,
      pct: r.pct,
      elapsed: r.elapsed ?? 0,
      clean: !!r.clean,
      solved_at: r.solved_at ?? null,
      members: this.members(r.id).map((m) => m.name),
    }));
  }

  // ---------- solo solve log (stats) ----------

  /** First completion wins, like mergeStats' earliest-completed_at rule. */
  recordSoloSolve(userId, puzzleId, entry) {
    const existing = this.db
      .prepare('SELECT completed_at FROM solo_solves WHERE user_id = ? AND puzzle_id = ?')
      .get(userId, puzzleId);
    if (existing && existing.completed_at <= entry.completed_at) return false;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO solo_solves (user_id, puzzle_id, seconds, completed_at, clean, used_check, used_reveal)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId, puzzleId, Math.round(entry.seconds || 0), entry.completed_at,
        entry.clean ? 1 : 0, entry.used_check ? 1 : 0, entry.used_reveal ? 1 : 0
      );
    return true;
  }

  /** The stats.json-shaped doc js/stats.js consumes. */
  statsDoc(user) {
    const rows = this.db.prepare('SELECT * FROM solo_solves WHERE user_id = ?').all(user.id);
    const solves = {};
    for (const r of rows) {
      solves[r.puzzle_id] = {
        seconds: r.seconds,
        completed_at: r.completed_at,
        clean: !!r.clean,
        used_check: !!r.used_check,
        used_reveal: !!r.used_reveal,
      };
    }
    return { schema: 1, user: user.name, updated_at: nowIso(), solves };
  }

  /** Completed co-op solves a user took part in. */
  coopStats(userId) {
    return this.solvesForUser(userId)
      .filter((s) => s.kind === 'coop' && s.completed)
      .map((s) => ({
        solve_id: s.id,
        puzzle_id: s.puzzle_id,
        members: s.members,
        seconds: s.elapsed,
        completed_at: s.solved_at,
        clean: s.clean,
      }));
  }

  // ---------- GitHub data repo sync state ----------

  ghSyncRow(path) {
    return this.db.prepare('SELECT * FROM gh_sync WHERE path = ?').get(path) ?? null;
  }

  setGhSyncRow(path, sha, localUpdatedAt) {
    this.db
      .prepare('INSERT OR REPLACE INTO gh_sync (path, sha, local_updated_at) VALUES (?, ?, ?)')
      .run(path, sha, localUpdatedAt);
  }

  /** Online backup to a single file (safe while the server is running). */
  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}
