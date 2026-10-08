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
 *
 * custom_puzzles are puzzles made on the site (js/custom-puzzle.js docs):
 * the working copy its authors edit live (server/build-rooms.mjs) and the
 * copy solvers get, which changes only when an author publishes. Solves
 * of one use its id as their puzzle_id, like any other puzzle.
 *
 * chat_messages hold what a co-op solve's members, or a custom puzzle's
 * authors, said to each other (server/chat.mjs).
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { USER_PALETTE } from '../js/people.js';
import { CUSTOM_ID_RE } from '../js/util.js';

const SCHEMA_VERSION = 5;

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
      -- every change to a live solve, in order (see Room.log in rooms.mjs):
      -- t is the solve's own clock in ms, at the wall clock in ms
      CREATE TABLE IF NOT EXISTS solve_events (
        solve_id TEXT NOT NULL REFERENCES solves(id) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        t        INTEGER NOT NULL,
        at       INTEGER NOT NULL,
        user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind     TEXT NOT NULL,
        cell     INTEGER,
        value    TEXT,
        marks    INTEGER,
        dir      TEXT,
        PRIMARY KEY (solve_id, seq)
      ) WITHOUT ROWID;
      -- js/solve-analysis.js summarize() of a completed solve's log
      CREATE TABLE IF NOT EXISTS solve_summaries (
        solve_id TEXT PRIMARY KEY REFERENCES solves(id) ON DELETE CASCADE,
        v        INTEGER NOT NULL,
        scalars  TEXT NOT NULL,
        detail   TEXT NOT NULL
      );
      -- puzzles made on the site: doc is the working copy the authors edit,
      -- published the copy solvers get (null while a draft), features the
      -- grid numbers of the published copy (js/custom-puzzle.js)
      CREATE TABLE IF NOT EXISTS custom_puzzles (
        id           TEXT PRIMARY KEY,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
        visibility   TEXT NOT NULL DEFAULT 'everyone' CHECK (visibility IN ('everyone', 'people')),
        doc          TEXT NOT NULL,
        published    TEXT,
        features     TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        published_at TEXT,
        revised_at   TEXT
      );
      CREATE TABLE IF NOT EXISTS custom_puzzle_authors (
        puzzle_id TEXT NOT NULL REFERENCES custom_puzzles(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        added_at  TEXT NOT NULL,
        PRIMARY KEY (puzzle_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS custom_authors_user ON custom_puzzle_authors(user_id);
      -- who can see a puzzle published with visibility 'people'
      CREATE TABLE IF NOT EXISTS custom_puzzle_shares (
        puzzle_id TEXT NOT NULL REFERENCES custom_puzzles(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (puzzle_id, user_id)
      );
      -- solvers' ratings and notes for a custom puzzle's authors
      CREATE TABLE IF NOT EXISTS puzzle_feedback (
        puzzle_id  TEXT NOT NULL REFERENCES custom_puzzles(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stars      INTEGER CHECK (stars BETWEEN 1 AND 5),
        comment    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (puzzle_id, user_id)
      );
      -- what the people in a co-op solve, or a custom puzzle's authors, say
      -- to each other (server/chat.mjs): exactly one of solve_id and
      -- puzzle_id is set. cid is the sender's own id for the message, so a
      -- resend after a dropped connection isn't stored twice; at is in ms
      CREATE TABLE IF NOT EXISTS chat_messages (
        id        INTEGER PRIMARY KEY,
        solve_id  TEXT REFERENCES solves(id) ON DELETE CASCADE,
        puzzle_id TEXT REFERENCES custom_puzzles(id) ON DELETE CASCADE,
        user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        cid       TEXT,
        at        INTEGER NOT NULL,
        text      TEXT NOT NULL,
        CHECK ((solve_id IS NULL) <> (puzzle_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS chat_solve ON chat_messages(solve_id, id) WHERE solve_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS chat_puzzle ON chat_messages(puzzle_id, id) WHERE puzzle_id IS NOT NULL;
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
    // the least-used palette color, so colors stay spread out as accounts
    // come and go (people sharing one are told apart by distinctColors)
    const uses = new Map(USER_PALETTE.map((c) => [c, 0]));
    for (const { color: c } of this.db.prepare('SELECT color FROM users').all()) {
      if (uses.has(c)) uses.set(c, uses.get(c) + 1);
    }
    const fewest = Math.min(...uses.values());
    const color = USER_PALETTE.find((c) => uses.get(c) === fewest);
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

  /**
   * The last time `userId` shared a co-op solve with each other person
   * (the solve's latest activity), for putting them first in pickers.
   * @returns {Map<number, string>} user id -> ISO time
   */
  coopPartners(userId) {
    const rows = this.db
      .prepare(
        `SELECT other.user_id AS id, MAX(solves.updated_at) AS last
         FROM solve_members AS mine
         JOIN solves ON solves.id = mine.solve_id AND solves.kind = 'coop'
         JOIN solve_members AS other ON other.solve_id = mine.solve_id AND other.user_id != mine.user_id
         WHERE mine.user_id = ?
         GROUP BY other.user_id`
      )
      .all(userId);
    return new Map(rows.map((r) => [r.id, r.last]));
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
    // drafts nobody can edit any more go with them; published puzzles stay
    this.db
      .prepare(
        `DELETE FROM custom_puzzles WHERE status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM custom_puzzle_authors AS a WHERE a.puzzle_id = custom_puzzles.id)`
      )
      .run();
    this.db
      .prepare(
        `UPDATE custom_puzzles SET created_by = (
           SELECT user_id FROM custom_puzzle_authors AS a WHERE a.puzzle_id = custom_puzzles.id ORDER BY added_at, rowid LIMIT 1)
         WHERE created_by IS NULL`
      )
      .run();
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

  // ---------- everyone's stats (the stats page) ----------

  /**
   * Every account's solo solves, unfinished solo puzzles, completed co-op
   * solves and summary scalars, in one compact payload (GET /api/stats-all).
   * Solo rows are tuples to keep it small:
   *   [puzzle_id, seconds, completed_at, flags, solve_id, opened_at]
   *   flags: 1 clean, 2 used check, 4 used reveal
   * Unfinished: [puzzle_id, pct, elapsed, updated_at]
   * With `viewerId`, custom puzzles that person can't see are left out.
   */
  statsAll(viewerId = null) {
    const shown = this.puzzleFilter(viewerId);
    const users = {};
    const entry = (name) => (users[name] ??= { solo: [], unfinished: [] });
    for (const u of this.db.prepare('SELECT name FROM users').all()) entry(u.name);
    const solo = this.db
      .prepare(
        `SELECT users.name, s.puzzle_id, s.seconds, s.completed_at, s.clean, s.used_check, s.used_reveal,
                sv.id AS solve_id, sv.created_at AS opened_at
         FROM solo_solves AS s
         JOIN users ON users.id = s.user_id
         LEFT JOIN solves AS sv ON sv.kind = 'solo' AND sv.owner_id = s.user_id AND sv.puzzle_id = s.puzzle_id`
      )
      .all();
    for (const r of solo) {
      if (!shown(r.puzzle_id)) continue;
      const flags = (r.clean ? 1 : 0) | (r.used_check ? 2 : 0) | (r.used_reveal ? 4 : 0);
      entry(r.name).solo.push([r.puzzle_id, r.seconds, r.completed_at, flags, r.solve_id ?? null, r.opened_at ?? null]);
    }
    const unfinished = this.db
      .prepare(
        `SELECT users.name, sv.puzzle_id, sv.pct, json_extract(sv.record, '$.elapsed') AS elapsed, sv.updated_at
         FROM solves AS sv JOIN users ON users.id = sv.owner_id
         WHERE sv.kind = 'solo' AND sv.completed = 0 AND (sv.pct > 0 OR json_extract(sv.record, '$.elapsed') > 0)
           AND NOT EXISTS (SELECT 1 FROM solo_solves AS s WHERE s.user_id = sv.owner_id AND s.puzzle_id = sv.puzzle_id)`
      )
      .all();
    for (const r of unfinished) {
      if (shown(r.puzzle_id)) entry(r.name).unfinished.push([r.puzzle_id, r.pct, r.elapsed ?? 0, r.updated_at]);
    }

    const coop = this.db
      .prepare(
        `SELECT id, puzzle_id, created_at,
                json_extract(record, '$.elapsed') AS seconds,
                json_extract(record, '$.solved_at') AS completed_at,
                json_extract(record, '$.clean') AS clean,
                json_extract(record, '$.used_check') AS used_check,
                json_extract(record, '$.used_reveal') AS used_reveal
         FROM solves WHERE kind = 'coop' AND completed = 1`
      )
      .all()
      .filter((r) => shown(r.puzzle_id))
      .map((r) => ({
        id: r.id,
        puzzle_id: r.puzzle_id,
        members: this.members(r.id).map((m) => m.name),
        seconds: r.seconds ?? 0,
        completed_at: r.completed_at,
        opened_at: r.created_at,
        flags: (r.clean ? 1 : 0) | (r.used_check ? 2 : 0) | (r.used_reveal ? 4 : 0),
      }));

    const summaries = {};
    const rows = this.db
      .prepare('SELECT s.solve_id, s.scalars, solves.puzzle_id FROM solve_summaries AS s JOIN solves ON solves.id = s.solve_id')
      .all();
    for (const r of rows) {
      if (shown(r.puzzle_id)) summaries[r.solve_id] = JSON.parse(r.scalars);
    }
    return { users, coop, summaries };
  }

  /**
   * Summary details of the solves a user took part in (solo and co-op):
   * {solve_id: {puzzle_id, kind, detail}}. With `viewerId`, custom puzzles
   * that person can't see are left out.
   */
  summaryDetails(userId, viewerId = null) {
    const shown = this.puzzleFilter(viewerId);
    const out = {};
    const rows = this.db
      .prepare(
        `SELECT s.solve_id, s.detail, solves.puzzle_id, solves.kind FROM solve_summaries AS s
         JOIN solves ON solves.id = s.solve_id
         JOIN solve_members AS m ON m.solve_id = s.solve_id
         WHERE m.user_id = ?`
      )
      .all(userId);
    for (const r of rows) {
      if (shown(r.puzzle_id)) out[r.solve_id] = { puzzle_id: r.puzzle_id, kind: r.kind, detail: JSON.parse(r.detail) };
    }
    return out;
  }

  /** Every finished solve of one puzzle, solo and co-op, with summaries. */
  puzzleResults(puzzleId) {
    const solo = this.db
      .prepare(
        `SELECT users.name, s.seconds, s.completed_at, s.clean, s.used_check, s.used_reveal, sv.id AS solve_id
         FROM solo_solves AS s
         JOIN users ON users.id = s.user_id
         LEFT JOIN solves AS sv ON sv.kind = 'solo' AND sv.owner_id = s.user_id AND sv.puzzle_id = s.puzzle_id
         WHERE s.puzzle_id = ?`
      )
      .all(puzzleId)
      .map((r) => ({
        kind: 'solo',
        solve_id: r.solve_id ?? null,
        members: [r.name],
        seconds: r.seconds,
        completed_at: r.completed_at,
        flags: (r.clean ? 1 : 0) | (r.used_check ? 2 : 0) | (r.used_reveal ? 4 : 0),
      }));
    const coop = this.db
      .prepare(
        `SELECT id, json_extract(record, '$.elapsed') AS seconds, json_extract(record, '$.solved_at') AS completed_at,
                json_extract(record, '$.clean') AS clean, json_extract(record, '$.used_check') AS used_check,
                json_extract(record, '$.used_reveal') AS used_reveal
         FROM solves WHERE kind = 'coop' AND completed = 1 AND puzzle_id = ?`
      )
      .all(puzzleId)
      .map((r) => ({
        kind: 'coop',
        solve_id: r.id,
        members: this.members(r.id).map((m) => m.name),
        seconds: r.seconds ?? 0,
        completed_at: r.completed_at,
        flags: (r.clean ? 1 : 0) | (r.used_check ? 2 : 0) | (r.used_reveal ? 4 : 0),
      }));
    const results = [...solo, ...coop];
    for (const r of results) {
      const s = r.solve_id ? this.summary(r.solve_id) : null;
      r.summary = s?.scalars ?? null;
      r.logged = !!(r.solve_id && this.maxEventSeq(r.solve_id));
    }
    return results;
  }

  // ---------- solve event log ----------

  /** Highest event number logged for a solve (0 when there are none). */
  maxEventSeq(solveId) {
    return this.db.prepare('SELECT MAX(seq) AS seq FROM solve_events WHERE solve_id = ?').get(solveId).seq ?? 0;
  }

  /** @param {Array<{seq,t,at,userId,kind,cell,value,marks,dir}>} events */
  appendEvents(solveId, events) {
    if (!events.length) return;
    const add = this.db.prepare(
      `INSERT OR IGNORE INTO solve_events (solve_id, seq, t, at, user_id, kind, cell, value, marks, dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        add.run(solveId, e.seq, e.t, e.at, e.userId ?? null, e.kind, e.cell ?? null, e.value ?? null, e.marks ?? null, e.dir ?? null);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * A solve's log in order, with user names (null for deleted accounts):
   * the shape js/solve-analysis.js reads.
   */
  events(solveId) {
    return this.db
      .prepare(
        `SELECT seq, t, at, users.name AS user, kind, cell, value, marks, dir
         FROM solve_events LEFT JOIN users ON users.id = solve_events.user_id
         WHERE solve_id = ? ORDER BY seq`
      )
      .all(solveId);
  }

  // ---------- solve summaries ----------

  /** First completion wins (`replace` is for recomputing a stale one). */
  saveSummary(solveId, { v, scalars, detail }, { replace = false } = {}) {
    this.db
      .prepare(
        `INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO solve_summaries (solve_id, v, scalars, detail) VALUES (?, ?, ?, ?)`
      )
      .run(solveId, v, JSON.stringify(scalars), JSON.stringify(detail));
  }

  summary(solveId) {
    const row = this.db.prepare('SELECT * FROM solve_summaries WHERE solve_id = ?').get(solveId);
    return row ? { v: row.v, scalars: JSON.parse(row.scalars), detail: JSON.parse(row.detail) } : null;
  }

  /**
   * Completed solves that have a log but no summary at version `v`.
   * @returns {Array<{id:string, puzzle_id:string}>}
   */
  solvesNeedingSummary(v) {
    return this.db
      .prepare(
        `SELECT solves.id, solves.puzzle_id FROM solves
         LEFT JOIN solve_summaries AS s ON s.solve_id = solves.id
         WHERE solves.completed = 1 AND (s.v IS NULL OR s.v != ?)
           AND EXISTS (SELECT 1 FROM solve_events AS e WHERE e.solve_id = solves.id)`
      )
      .all(v);
  }

  // ---------- chat ----------

  /**
   * Store one message in a co-op solve's ({solveId}) or a custom puzzle's
   * ({puzzleId}) conversation. Returns its id.
   */
  addChatMessage({ solveId = null, puzzleId = null }, { userId, cid = null, at, text }) {
    const info = this.db
      .prepare('INSERT INTO chat_messages (solve_id, puzzle_id, user_id, cid, at, text) VALUES (?, ?, ?, ?, ?, ?)')
      .run(solveId, puzzleId, userId, cid, at, text);
    return Number(info.lastInsertRowid);
  }

  /**
   * The newest `limit` messages of a conversation, oldest first, with user
   * names (null for deleted accounts).
   * @returns {Array<{id:number, user:string|null, cid:string|null, at:number, text:string}>}
   */
  chatMessages({ solveId = null, puzzleId = null }, limit = 200) {
    const [col, key] = solveId != null ? ['solve_id', solveId] : ['puzzle_id', puzzleId];
    return this.db
      .prepare(
        `SELECT m.id, users.name AS user, m.cid, m.at, m.text
         FROM chat_messages AS m LEFT JOIN users ON users.id = m.user_id
         WHERE m.${col} = ? ORDER BY m.id DESC LIMIT ?`
      )
      .all(key, limit)
      .reverse();
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

  // ---------- custom puzzles ----------

  /** A new draft, with its creator as the first author. */
  createCustomPuzzle({ id, createdBy, doc }) {
    const now = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO custom_puzzles (id, created_by, status, visibility, doc, created_at, updated_at)
           VALUES (?, ?, 'draft', 'everyone', ?, ?, ?)`
        )
        .run(id, createdBy, JSON.stringify(doc), now, now);
      this.db
        .prepare('INSERT INTO custom_puzzle_authors (puzzle_id, user_id, added_at) VALUES (?, ?, ?)')
        .run(id, createdBy, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.customPuzzle(id);
  }

  /**
   * -> {id, created_by, status, visibility, doc, published, features,
   *     created_at, updated_at, published_at, revised_at,
   *     authors: [user rows], shares: [user ids]} or null
   */
  customPuzzle(id) {
    const row = this.db.prepare('SELECT * FROM custom_puzzles WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      created_by: row.created_by,
      status: row.status,
      visibility: row.visibility,
      doc: JSON.parse(row.doc),
      published: row.published ? JSON.parse(row.published) : null,
      features: row.features ? JSON.parse(row.features) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
      revised_at: row.revised_at,
      authors: this.customAuthors(id),
      shares: this.db.prepare('SELECT user_id FROM custom_puzzle_shares WHERE puzzle_id = ?').all(id).map((r) => r.user_id),
    };
  }

  /** The copy solvers get, or null (a draft, or no such puzzle). */
  customPublished(id) {
    const row = this.db.prepare('SELECT published FROM custom_puzzles WHERE id = ?').get(id);
    return row?.published ? JSON.parse(row.published) : null;
  }

  /**
   * The published copies of puzzles out for everyone, for the builder's
   * word list (a restricted puzzle's answers stay out of it).
   */
  publishedDocs() {
    return this.db
      .prepare("SELECT published FROM custom_puzzles WHERE status = 'published' AND visibility = 'everyone'")
      .all()
      .map((r) => JSON.parse(r.published));
  }

  /** {status, visibility} without the docs, or null. */
  customState(id) {
    return this.db.prepare('SELECT status, visibility FROM custom_puzzles WHERE id = ?').get(id) ?? null;
  }

  customAuthors(id) {
    return this.db
      .prepare(
        `SELECT users.id, users.name, users.display_name, users.color FROM custom_puzzle_authors
         JOIN users ON users.id = custom_puzzle_authors.user_id
         WHERE puzzle_id = ? ORDER BY custom_puzzle_authors.added_at, custom_puzzle_authors.rowid`
      )
      .all(id);
  }

  isCustomAuthor(puzzleId, userId) {
    return !!this.db
      .prepare('SELECT 1 FROM custom_puzzle_authors WHERE puzzle_id = ? AND user_id = ?')
      .get(puzzleId, userId);
  }

  /** How many drafts a person has open (the API caps them). */
  draftCount(userId) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM custom_puzzles AS p JOIN custom_puzzle_authors AS a ON a.puzzle_id = p.id
         WHERE a.user_id = ? AND p.status = 'draft'`
      )
      .get(userId).n;
  }

  /** The build room writes its working copy here. */
  saveCustomDoc(id, doc, updatedAt = nowIso()) {
    this.db.prepare('UPDATE custom_puzzles SET doc = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(doc), updatedAt, id);
  }

  /** Publish (or update) what solvers get. */
  publishCustomPuzzle(id, { published, features }) {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE custom_puzzles SET status = 'published', published = ?, features = ?,
                published_at = COALESCE(published_at, ?), revised_at = ?
         WHERE id = ?`
      )
      .run(JSON.stringify(published), JSON.stringify(features), now, now, id);
  }

  /** visibility 'everyone', or 'people' (the authors plus `userIds`). */
  setCustomSharing(id, visibility, userIds = []) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE custom_puzzles SET visibility = ? WHERE id = ?').run(visibility, id);
      this.db.prepare('DELETE FROM custom_puzzle_shares WHERE puzzle_id = ?').run(id);
      if (visibility === 'people') {
        const add = this.db.prepare('INSERT OR IGNORE INTO custom_puzzle_shares (puzzle_id, user_id) VALUES (?, ?)');
        for (const uid of userIds) add.run(id, uid);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  addCustomAuthors(id, userIds) {
    const add = this.db.prepare('INSERT OR IGNORE INTO custom_puzzle_authors (puzzle_id, user_id, added_at) VALUES (?, ?, ?)');
    const now = nowIso();
    for (const uid of userIds) add.run(id, uid, now);
    return this.customAuthors(id);
  }

  /** If the creator leaves, the longest-standing author takes over. */
  removeCustomAuthor(id, userId) {
    this.db.prepare('DELETE FROM custom_puzzle_authors WHERE puzzle_id = ? AND user_id = ?').run(id, userId);
    this.db
      .prepare(
        `UPDATE custom_puzzles SET created_by = (
           SELECT user_id FROM custom_puzzle_authors WHERE puzzle_id = ? ORDER BY added_at, rowid LIMIT 1)
         WHERE id = ? AND created_by = ?`
      )
      .run(id, id, userId);
    return this.customAuthors(id);
  }

  withdrawCustomPuzzle(id) {
    this.db.prepare("UPDATE custom_puzzles SET status = 'withdrawn' WHERE id = ?").run(id);
  }

  deleteCustomPuzzle(id) {
    this.db.prepare('DELETE FROM custom_puzzles WHERE id = ?').run(id);
  }

  /** Has anyone opened a solve of this puzzle (then it's withdrawn, never deleted)? */
  hasSolves(puzzleId, userId = null) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM solves ${userId == null ? '' : 'JOIN solve_members AS m ON m.solve_id = solves.id AND m.user_id = ?'}
         WHERE solves.puzzle_id = ? LIMIT 1`
      )
      .get(...(userId == null ? [puzzleId] : [userId, puzzleId]));
  }

  /** Did this person finish the puzzle, alone or in a co-op? */
  finishedPuzzle(puzzleId, userId) {
    return !!(
      this.db.prepare('SELECT 1 FROM solo_solves WHERE user_id = ? AND puzzle_id = ?').get(userId, puzzleId) ||
      this.db
        .prepare(
          `SELECT 1 FROM solves JOIN solve_members AS m ON m.solve_id = solves.id
           WHERE solves.puzzle_id = ? AND solves.completed = 1 AND m.user_id = ? LIMIT 1`
        )
        .get(puzzleId, userId)
    );
  }

  /**
   * The custom puzzles a person can see: their own (any status), ones they
   * have a solve of (sharing changed or the puzzle was withdrawn later:
   * nobody loses a solve), and published ones for everyone or shared with
   * them. `onlyId` checks one puzzle.
   * @returns {Set<string>}
   */
  visibleCustomIds(userId, onlyId = null) {
    const rows = this.db
      .prepare(
        `SELECT p.id FROM custom_puzzles AS p
         WHERE ${onlyId == null ? '' : 'p.id = ? AND'} (
           EXISTS (SELECT 1 FROM custom_puzzle_authors AS a WHERE a.puzzle_id = p.id AND a.user_id = ?)
           OR EXISTS (SELECT 1 FROM solves JOIN solve_members AS m ON m.solve_id = solves.id
                      WHERE solves.puzzle_id = p.id AND m.user_id = ?)
           OR (p.status = 'published' AND (p.visibility = 'everyone'
               OR EXISTS (SELECT 1 FROM custom_puzzle_shares AS sh WHERE sh.puzzle_id = p.id AND sh.user_id = ?))))`
      )
      .all(...(onlyId == null ? [] : [onlyId]), userId, userId, userId);
    return new Set(rows.map((r) => r.id));
  }

  /** Every puzzle id is visible except custom puzzles this person can't see. */
  canSeePuzzle(userId, puzzleId) {
    return !CUSTOM_ID_RE.test(puzzleId) || this.visibleCustomIds(userId, puzzleId).has(puzzleId);
  }

  /** A filter for puzzle ids a viewer may see (everything when viewerId is null). */
  puzzleFilter(viewerId) {
    if (viewerId == null) return () => true;
    const visible = this.visibleCustomIds(viewerId);
    return (puzzleId) => !CUSTOM_ID_RE.test(puzzleId) || visible.has(puzzleId);
  }

  /**
   * Who has finished and who is working on each custom puzzle, and its
   * stars: {puzzleId: {solved, solving, stars: {avg, n} | null, notes}}.
   */
  customCounts() {
    const out = {};
    const at = (id) => (out[id] ??= { solved: 0, solving: 0, stars: null, notes: 0 });
    const solved = this.db
      .prepare(
        `SELECT puzzle_id, COUNT(DISTINCT user_id) AS n FROM (
           SELECT user_id, puzzle_id FROM solo_solves WHERE puzzle_id LIKE 'custom-%'
           UNION SELECT m.user_id, solves.puzzle_id FROM solves JOIN solve_members AS m ON m.solve_id = solves.id
                 WHERE solves.kind = 'coop' AND solves.completed = 1 AND solves.puzzle_id LIKE 'custom-%')
         GROUP BY puzzle_id`
      )
      .all();
    for (const r of solved) at(r.puzzle_id).solved = r.n;
    const solving = this.db
      .prepare(
        `SELECT solves.puzzle_id, COUNT(DISTINCT m.user_id) AS n FROM solves
         JOIN solve_members AS m ON m.solve_id = solves.id
         WHERE solves.puzzle_id LIKE 'custom-%' AND solves.completed = 0
           AND (solves.pct > 0 OR json_extract(solves.record, '$.elapsed') > 0)
         GROUP BY solves.puzzle_id`
      )
      .all();
    for (const r of solving) at(r.puzzle_id).solving = r.n;
    const stars = this.db
      .prepare(
        `SELECT puzzle_id, AVG(stars) AS avg, COUNT(stars) AS n, SUM(comment != '') AS notes
         FROM puzzle_feedback GROUP BY puzzle_id`
      )
      .all();
    for (const r of stars) {
      at(r.puzzle_id).stars = r.n ? { avg: Math.round(r.avg * 10) / 10, n: r.n } : null;
      at(r.puzzle_id).notes = r.notes ?? 0;
    }
    return out;
  }

  // ---------- feedback on custom puzzles ----------

  saveFeedback(puzzleId, userId, { stars, comment }) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO puzzle_feedback (puzzle_id, user_id, stars, comment, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (puzzle_id, user_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment,
           updated_at = excluded.updated_at`
      )
      .run(puzzleId, userId, stars ?? null, comment ?? '', now, now);
  }

  /** [{user, display_name, stars, comment, created_at, updated_at}], newest first. */
  feedbackFor(puzzleId) {
    return this.db
      .prepare(
        `SELECT users.name AS user, users.display_name, f.stars, f.comment, f.created_at, f.updated_at
         FROM puzzle_feedback AS f JOIN users ON users.id = f.user_id
         WHERE f.puzzle_id = ? ORDER BY f.updated_at DESC`
      )
      .all(puzzleId);
  }

  /** Online backup to a single file (safe while the server is running). */
  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}
