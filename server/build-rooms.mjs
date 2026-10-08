/*
 * build-rooms.mjs — a custom puzzle's working copy, edited live by its
 * authors (the builder, js/builder-page.js). Works like a solve's Room in
 * rooms.mjs: while anyone has the puzzle open its doc lives here, every
 * change goes through the room in arrival order (last writer wins per key:
 * a square, a circle, a clue, the title...), everyone gets the result, and
 * the doc is written to the database ~2 s after a change and when the last
 * person leaves. A lone author is just a room with one connection.
 *
 * Once a puzzle is published its shape is locked: a change that would turn
 * a square black or white comes back with the square's real value, so every
 * solve of the puzzle keeps fitting it. Solvers get the working copy only
 * when an author publishes it again (POST /api/custom-puzzles/:id/publish).
 *
 * The authors can message each other here too (ChatLog in chat.mjs).
 *
 * Wire messages are documented in js/net.js; the change keys in
 * js/custom-puzzle.js (applyChange).
 */

import { applyChange, publishedCopy } from '../js/custom-puzzle.js';
import { distinctColors } from '../js/people.js';
import { publicUser } from './auth.mjs';
import { ChatLog } from './chat.mjs';
import { nowIso } from './db.mjs';
import { RoomError } from './room-error.mjs';

const MAX_CHANGES = 2000; // a whole 25×25 grid, its circles and every clue
const CLUE_RE = /^[AD]\d{1,4}$/;

const oldestFirst = (people) => [...people].sort((a, b) => a.id - b.id);

export class BuildRoom {
  /** @param {object} puzzle  Store.customPuzzle() */
  constructor(hub, puzzle) {
    this.hub = hub;
    this.id = puzzle.id;
    this.doc = puzzle.doc;
    this.status = puzzle.status;
    this.visibility = puzzle.visibility;
    this.createdBy = puzzle.created_by;
    this.published = puzzle.published;
    this.authors = puzzle.authors;
    // authors who share an account color get distinct ones here, as in a co-op
    this.colors = distinctColors(oldestFirst(this.authors));
    this.version = 0;
    this.conns = new Set();
    this.flushTimer = null;
    this.dirty = false;
    this.updatedAt = puzzle.updated_at;
    this.changed = this.differsFromPublished();
    this.chat = new ChatLog(this, { puzzleId: this.id });
  }

  get shapeLocked() {
    return this.status !== 'draft';
  }

  /** Has the working copy moved on from what solvers have? */
  differsFromPublished() {
    if (!this.published) return false;
    try {
      return JSON.stringify(publishedCopy(this.doc)) !== JSON.stringify(this.published);
    } catch {
      return true;
    }
  }

  colorOf(user) {
    return this.colors.get(user.name) ?? user.color;
  }

  authorList() {
    return this.authors.map((a) => ({ ...publicUser(a), color: this.colorOf(a) }));
  }

  info() {
    return {
      id: this.id,
      status: this.status,
      visibility: this.visibility,
      shape_locked: this.shapeLocked,
      changed: this.changed,
      created_by: this.authors.find((a) => a.id === this.createdBy)?.name ?? null,
      authors: this.authorList(),
    };
  }

  presence() {
    return [...this.conns].map((c) => ({
      conn: c.id,
      user: c.user.name,
      display_name: c.user.display_name,
      color: this.colorOf(c.user),
      cursor: c.cursor,
    }));
  }

  snapshot(conn) {
    return {
      type: 'snapshot',
      you: conn.id,
      puzzle: this.info(),
      doc: this.doc,
      version: this.version,
      presence: this.presence(),
      chat: this.chat.recent(),
    };
  }

  broadcast(msg, except = null) {
    for (const c of this.conns) if (c !== except) c.send(msg);
  }

  add(conn) {
    this.conns.add(conn);
    conn.room = this;
    conn.cursor = null;
    conn.send(this.snapshot(conn));
    this.broadcast({ type: 'presence', presence: this.presence() }, conn);
  }

  remove(conn) {
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    conn.room = null;
    this.broadcast({ type: 'presence', presence: this.presence() });
    if (!this.conns.size) this.hub.closeBuild(this);
  }

  /** One client message (anything but the join). */
  handle(conn, msg) {
    switch (msg.type) {
      case 'edit':
        this.applyEdit(conn, msg.opId ?? null, msg.changes);
        break;
      case 'cursor':
        this.setCursor(conn, msg);
        break;
      case 'chat':
        this.chat.post(conn, msg);
        break;
      case 'ping':
        conn.send({ type: 'pong', t: msg.t });
        break;
      default:
        throw new RoomError('bad-type', `unknown message type ${msg.type}`);
    }
  }

  applyEdit(conn, opId, changes) {
    if (!Array.isArray(changes) || changes.length > MAX_CHANGES) {
      throw new RoomError('bad-op', 'changes must be an array');
    }
    const applied = [];
    for (const ch of changes) {
      const done = applyChange(this.doc, ch, { shapeLocked: this.shapeLocked });
      if (done) applied.push(done);
    }
    this.version++;
    this.broadcast({ type: 'edit', version: this.version, by: conn.user.name, conn: conn.id, opId, changes: applied });
    if (!applied.length) return;
    this.updatedAt = nowIso();
    this.markDirty();
    if (this.published) {
      const changed = this.differsFromPublished();
      if (changed !== this.changed) {
        this.changed = changed;
        this.broadcast({ type: 'puzzle-state', ...this.statusInfo() });
      }
    }
  }

  setCursor(conn, msg) {
    let cursor = null;
    if (Number.isInteger(msg.index) && msg.index >= 0 && msg.index < this.doc.grid.length) {
      cursor = { index: msg.index, dir: msg.dir === 'D' ? 'D' : 'A' };
    } else if (typeof msg.clue === 'string' && CLUE_RE.test(msg.clue)) {
      cursor = { clue: msg.clue };
    }
    conn.cursor = cursor;
    this.broadcast({ type: 'cursor', conn: conn.id, user: conn.user.name, ...(cursor ?? {}) }, conn);
  }

  markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.hub.flushMs);
    this.flushTimer.unref?.();
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.hub.store.saveCustomDoc(this.id, this.doc, this.updatedAt);
  }

  statusInfo(by = null) {
    return {
      status: this.status,
      visibility: this.visibility,
      shape_locked: this.shapeLocked,
      changed: this.changed,
      ...(by ? { by } : {}),
    };
  }

  /** Published, updated, withdrawn or re-shared over REST: tell everyone here. */
  setState({ status, visibility, published }, by = null) {
    if (status) this.status = status;
    if (visibility) this.visibility = visibility;
    if (published !== undefined) this.published = published;
    this.changed = this.differsFromPublished();
    this.broadcast({ type: 'puzzle-state', ...this.statusInfo(by) });
  }

  /** Authors were added or removed: people who aren't one any more leave. */
  refreshAuthors() {
    const puzzle = this.hub.store.customPuzzle(this.id);
    if (!puzzle) return this.deleted();
    this.authors = puzzle.authors;
    this.createdBy = puzzle.created_by;
    this.colors = distinctColors(oldestFirst(this.authors), { keep: this.colors });
    for (const conn of [...this.conns]) {
      if (this.authors.some((a) => a.id === conn.user.id)) continue;
      conn.send({ type: 'error', code: 'not-author', message: 'You’re not one of this puzzle’s authors any more.', re: 'build' });
      this.remove(conn);
    }
    this.broadcast({ type: 'authors', authors: this.authorList(), created_by: this.info().created_by });
  }

  /** The puzzle was deleted: everyone here goes, nothing more is written. */
  deleted(by = null) {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.dirty = false;
    this.broadcast({ type: 'deleted', by });
    for (const conn of this.conns) conn.room = null;
    this.conns.clear();
    this.hub.closeBuild(this);
  }
}
