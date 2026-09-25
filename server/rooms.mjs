/*
 * rooms.mjs — live solves. Every solve (solo or co-op) that someone has
 * open is a Room held in memory: the authoritative grid, a version counter,
 * the connected clients, their cursors, and the shared timer. Rooms flush
 * to SQLite shortly after changes and when the last client leaves.
 *
 * Sync model: server-authoritative, last-writer-wins per cell. Clients
 * apply their own edits optimistically and send {opId, changes}; the room
 * applies ops in arrival order, bumps `version`, and broadcasts the
 * resulting cell values to everyone (the sender treats it as its ack).
 * Since every client applies the same broadcasts in the same order — and
 * holds off on cells with its own edits still in flight — all converge.
 *
 * Timer: runs while at least one connected client is "active" (has the
 * puzzle open, un-paused, tab visible). Pausing in a co-op solve pauses
 * everyone.
 *
 * Wire messages are documented in js/net.js.
 */

import { SolveEngine } from '../js/engine.js';
import { newProgress, recordFitsModel } from '../js/state.js';
import { newId, nowIso } from './db.mjs';
import { publicUser } from './auth.mjs';

const MAX_FILL_LEN = 12;
const FILL_RE = /^[^\s.]*$/u;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Room {
  constructor(hub, solve, model) {
    this.hub = hub;
    this.id = solve.id;
    this.puzzleId = solve.puzzle_id;
    this.kind = solve.kind;
    this.ownerId = solve.owner_id;
    this.model = model;
    this.members = solve.members;
    this.record = recordFitsModel(solve.record, model)
      ? solve.record
      : newProgress(model, solve.puzzle_id, solve.kind === 'solo' ? solve.members[0]?.name : 'coop');
    this.checker = new SolveEngine(model, this.record, {});
    this.version = 0;
    this.conns = new Set();
    this.timerBase = this.record.elapsed || 0; // seconds banked
    this.timerSince = null; // ms timestamp while running
    this.flushTimer = null;
    this.dirty = false;
  }

  now() {
    return this.hub.now();
  }

  elapsed() {
    const live = this.timerSince == null ? 0 : (this.now() - this.timerSince) / 1000;
    return this.timerBase + live;
  }

  timerState() {
    return { elapsed: this.elapsed(), running: this.timerSince != null };
  }

  broadcast(msg, except = null) {
    for (const c of this.conns) if (c !== except) c.send(msg);
  }

  presence() {
    return [...this.conns].map((c) => ({
      conn: c.id,
      user: c.user.name,
      display_name: c.user.display_name,
      color: c.user.color,
      cursor: c.cursor,
      active: c.active,
    }));
  }

  snapshot(conn) {
    return {
      type: 'snapshot',
      you: conn.id,
      solve: {
        id: this.id,
        kind: this.kind,
        puzzle_id: this.puzzleId,
        members: this.members.map(publicUser),
      },
      record: this.record,
      version: this.version,
      presence: this.presence(),
      timer: this.timerState(),
    };
  }

  add(conn) {
    this.conns.add(conn);
    conn.room = this;
    conn.active = false;
    conn.cursor = null;
    conn.send(this.snapshot(conn));
    this.broadcast({ type: 'presence', presence: this.presence() }, conn);
  }

  remove(conn) {
    if (!this.conns.delete(conn)) return;
    conn.room = null;
    this.updateTimer();
    this.broadcast({ type: 'presence', presence: this.presence() });
    if (!this.conns.size) this.hub.closeRoom(this);
  }

  /** Start/stop the clock to match whether anyone is actively solving. */
  updateTimer() {
    const shouldRun = !this.record.completed && [...this.conns].some((c) => c.active);
    const running = this.timerSince != null;
    if (shouldRun === running) return;
    if (shouldRun) {
      this.timerSince = this.now();
    } else {
      this.timerBase = this.elapsed();
      this.timerSince = null;
      this.record.elapsed = Math.floor(this.timerBase);
      this.markDirty();
    }
    this.broadcast({ type: 'timer', ...this.timerState() });
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
    if (!this.record.completed) this.record.elapsed = Math.floor(this.elapsed());
    this.hub.store.saveRecord(this.id, this.record);
  }

  // ---------- operations ----------

  applyCells(conn, opId, changes) {
    if (!Array.isArray(changes) || changes.length > this.model.cells.length) {
      throw new RoomError('bad-op', 'changes must be an array');
    }
    const rec = this.record;
    const applied = [];
    for (const ch of changes) {
      const i = ch?.i;
      if (!Number.isInteger(i) || i < 0 || i >= this.model.cells.length || this.model.isBlack(i)) continue;
      if (rec.completed) {
        // too late: tell the sender what the cell really holds
        applied.push({ i, fill: rec.fill[i], marks: rec.marks[i] });
        continue;
      }
      let fill = typeof ch.fill === 'string' ? ch.fill.toUpperCase() : '';
      if (fill.length > MAX_FILL_LEN || !FILL_RE.test(fill)) fill = rec.fill[i];
      const marks = Number.isInteger(ch.marks) && ch.marks >= 0 && ch.marks <= 0x0f ? ch.marks : rec.marks[i];
      rec.fill[i] = fill;
      rec.marks[i] = marks;
      applied.push({ i, fill, marks });
    }
    this.version++;
    if (!rec.completed) rec.updated_at = nowIso();
    this.broadcast({
      type: 'cells',
      version: this.version,
      by: conn.user.name,
      conn: conn.id,
      opId,
      changes: applied,
    });
    this.markDirty();
    this.checkComplete();
  }

  applyFlags(conn, flags) {
    const rec = this.record;
    if (rec.completed) return;
    // assists are one-way: once used, a solve is never clean again
    if (flags?.used_check) rec.used_check = true;
    if (flags?.used_reveal) rec.used_reveal = true;
    if (typeof flags?.autocheck === 'boolean') {
      rec.autocheck = flags.autocheck;
      if (flags.autocheck) rec.used_check = true;
    }
    rec.clean = !rec.used_check && !rec.used_reveal;
    rec.updated_at = nowIso();
    this.broadcast({
      type: 'flags',
      by: conn.user.name,
      used_check: rec.used_check,
      used_reveal: rec.used_reveal,
      autocheck: rec.autocheck,
      clean: rec.clean,
    });
    this.markDirty();
  }

  checkComplete() {
    const rec = this.record;
    if (rec.completed || !this.checker.isFull()) return;
    const scrambled = this.model.puz.scrambled;
    if (!scrambled && !this.checker.allCorrect()) return;
    this.timerBase = this.elapsed();
    this.timerSince = null;
    rec.completed = true;
    rec.solved_at = nowIso();
    rec.clean = !rec.used_check && !rec.used_reveal && !scrambled;
    rec.elapsed = Math.floor(this.timerBase);
    rec.updated_at = rec.solved_at;
    this.broadcast({
      type: 'completed',
      solved_at: rec.solved_at,
      clean: rec.clean,
      elapsed: rec.elapsed,
    });
    this.dirty = true;
    this.flush();
    if (this.kind === 'solo' && this.ownerId != null) {
      this.hub.store.recordSoloSolve(this.ownerId, this.puzzleId, {
        seconds: rec.elapsed,
        completed_at: rec.solved_at,
        clean: rec.clean,
        used_check: rec.used_check,
        used_reveal: rec.used_reveal,
      });
    }
  }

  setCursor(conn, index, dir) {
    if (!Number.isInteger(index) || index < 0 || index >= this.model.cells.length) return;
    conn.cursor = { index, dir: dir === 'D' ? 'D' : 'A' };
    this.broadcast({ type: 'cursor', conn: conn.id, user: conn.user.name, ...conn.cursor }, conn);
  }

  setActive(conn, on) {
    const was = conn.active;
    conn.active = !!on;
    if (was !== conn.active) {
      this.updateTimer();
      this.broadcast({ type: 'presence', presence: this.presence() });
    }
  }

  /** Co-op pause button: stops everyone. */
  pauseAll(conn) {
    for (const c of this.conns) c.active = false;
    this.updateTimer();
    this.broadcast({ type: 'paused', by: conn.user.name, conn: conn.id });
    this.broadcast({ type: 'presence', presence: this.presence() });
  }

  /** Erase the grid and the clock ("Reset puzzle & timer"). */
  reset() {
    this.record = newProgress(this.model, this.puzzleId, this.record.user);
    this.record.updated_at = nowIso();
    this.checker = new SolveEngine(this.model, this.record, {});
    this.timerBase = 0;
    this.timerSince = null;
    this.version++;
    this.dirty = true;
    this.flush();
    for (const c of this.conns) c.active = false;
    for (const c of this.conns) c.send({ ...this.snapshot(c), reset: true });
  }

  refreshMembers() {
    this.members = this.hub.store.members(this.id);
    this.broadcast({ type: 'members', members: this.members.map(publicUser) });
  }
}

export class Hub {
  /**
   * @param {{store: import('./db.mjs').Store, puzzles: {model(id):Promise<any>},
   *          now?: () => number, flushMs?: number, log?: Console}} opts
   */
  constructor({ store, puzzles, now = Date.now, flushMs = 2000, log = console }) {
    this.store = store;
    this.puzzles = puzzles;
    this.now = now;
    this.flushMs = flushMs;
    this.log = log;
    this.rooms = new Map(); // solveId -> Room
    this.opening = new Map(); // solveId -> Promise<Room>
    this.nextConnId = 1;
  }

  /** Wrap a transport: `send(obj)` delivers one message to this client. */
  connect(user, send) {
    return { id: `c${this.nextConnId++}`, user, send, room: null, active: false, cursor: null };
  }

  disconnect(conn) {
    conn.room?.remove(conn);
  }

  /** Find or create the user's solo solve for a puzzle. */
  async soloSolveFor(user, puzzleId) {
    const existing = this.store.soloSolve(user.id, puzzleId);
    if (existing) return existing;
    const model = await this.puzzles.model(puzzleId);
    if (!model) throw new RoomError('no-puzzle', 'That puzzle is not in the archive.');
    try {
      return this.store.createSolve({
        puzzleId,
        kind: 'solo',
        ownerId: user.id,
        createdBy: user.id,
        memberIds: [user.id],
        record: newProgress(model, puzzleId, user.name),
      });
    } catch {
      // another device created it at the same moment
      return this.store.soloSolve(user.id, puzzleId);
    }
  }

  async room(solveId) {
    if (this.rooms.has(solveId)) return this.rooms.get(solveId);
    if (this.opening.has(solveId)) return this.opening.get(solveId);
    const p = (async () => {
      const solve = this.store.solveById(solveId);
      if (!solve) throw new RoomError('no-solve', 'That solve does not exist.');
      const model = await this.puzzles.model(solve.puzzle_id);
      if (!model) throw new RoomError('no-puzzle', 'That puzzle is not in the archive.');
      const room = new Room(this, solve, model);
      this.rooms.set(solveId, room);
      return room;
    })().finally(() => this.opening.delete(solveId));
    this.opening.set(solveId, p);
    return p;
  }

  closeRoom(room) {
    room.flush();
    if (this.rooms.get(room.id) === room) this.rooms.delete(room.id);
  }

  flushAll() {
    for (const room of this.rooms.values()) room.flush();
  }

  async join(conn, { solve, puzzle }) {
    let solveId = solve;
    if (!solveId) {
      if (!puzzle) throw new RoomError('bad-join', 'join needs a solve or a puzzle');
      solveId = (await this.soloSolveFor(conn.user, puzzle)).id;
    } else if (!this.store.isMember(solveId, conn.user.id)) {
      throw new RoomError('not-member', "You're not part of that solve.");
    }
    const room = await this.room(solveId);
    if (conn.room && conn.room !== room) conn.room.remove(conn);
    if (conn.room !== room) room.add(conn);
    return room;
  }

  /** Dispatch one client message. Errors go back to that client only. */
  async handle(conn, msg) {
    try {
      if (msg?.type === 'join') {
        await this.join(conn, msg);
        return;
      }
      const room = conn.room;
      if (!room) throw new RoomError('not-joined', 'join a solve first');
      switch (msg.type) {
        case 'cells':
          room.applyCells(conn, msg.opId ?? null, msg.changes);
          break;
        case 'flags':
          room.applyFlags(conn, msg);
          break;
        case 'cursor':
          room.setCursor(conn, msg.index, msg.dir);
          break;
        case 'active':
          room.setActive(conn, msg.on);
          break;
        case 'pause':
          room.pauseAll(conn);
          break;
        case 'reset':
          room.reset();
          break;
        case 'ping':
          conn.send({ type: 'pong', t: msg.t });
          break;
        default:
          throw new RoomError('bad-type', `unknown message type ${msg.type}`);
      }
    } catch (err) {
      if (!(err instanceof RoomError)) this.log.error?.(err);
      conn.send({ type: 'error', code: err.code || 'internal', message: err.message, re: msg?.type });
    }
  }

  /** Members were added over REST; tell anyone looking at the solve. */
  membersChanged(solveId) {
    this.rooms.get(solveId)?.refreshMembers();
  }

  /** Open (or being opened) right now: its grid lives in memory, not the DB. */
  isBusy(solveId) {
    return this.rooms.has(solveId) || this.opening.has(solveId);
  }

  liveRecord(solveId) {
    return this.rooms.get(solveId)?.record ?? null;
  }

  isLive(solveId) {
    return this.rooms.has(solveId);
  }
}

export { newId };
