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
 * Event log: every change the room applies is also logged (Room.log ->
 * solve_events), stamped with the solve's own clock, for the stats pages:
 * replays, time per entry, errors, who filled what. The kinds are listed
 * in js/solve-analysis.js. When a solve completes its log is summarized
 * into solve_summaries.
 *
 * Wire messages are documented in js/net.js.
 */

import { SolveEngine } from '../js/engine.js';
import { newProgress, recordFitsModel } from '../js/state.js';
import { distinctColors } from '../js/people.js';
import { replayGrid, summarize, ANALYSIS_VERSION } from '../js/solve-analysis.js';
import { newId, nowIso } from './db.mjs';
import { publicUser } from './auth.mjs';

const MAX_FILL_LEN = 12;
const FILL_RE = /^[^\s.]*$/u;
const ASSIST_RE = /^(?:(?:check|reveal):(?:letter|word|puzzle)|autocheck:(?:on|off))$/;
const dirOrNull = (d) => (d === 'A' || d === 'D' ? d : null);

const oldestFirst = (members) => [...members].sort((a, b) => a.id - b.id);

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
    // Account colors repeat once there are more people than palette
    // colors, so each solve gives its members colors they don't share.
    // The older account keeps a shared color, so the same person gives
    // way in every solve; refreshMembers keeps colors while the room is open.
    this.colors = distinctColors(oldestFirst(this.members));
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
    this.seq = hub.store.maxEventSeq(this.id);
    this.eventBuf = []; // logged, not yet written
    this.noteBaseline();
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

  /**
   * Log one event (see js/solve-analysis.js for the kinds). Written to the
   * DB with the next flush.
   */
  log(kind, user, { cell = null, value = null, marks = null, dir = null } = {}) {
    this.eventBuf.push({
      seq: ++this.seq,
      t: Math.round(this.elapsed() * 1000),
      at: this.now(),
      userId: user?.id ?? null,
      kind,
      cell,
      value,
      marks,
      dir,
    });
    this.markDirty();
  }

  /**
   * The log has to add up to the grid. If the grid changed where the log
   * can't see (progress from before logging began, or from the old site's
   * sync), log where it stands now so analysis knows what it missed.
   */
  noteBaseline() {
    if (this.record.completed) return;
    const logged = replayGrid(this.model, this.seq ? this.hub.store.events(this.id) : []);
    const same = logged.fill.every((v, i) => v === this.record.fill[i]) && logged.marks.every((m, i) => m === this.record.marks[i]);
    if (!same) this.log('b', null, { value: JSON.stringify({ fill: this.record.fill, marks: this.record.marks }) });
  }

  /** Log the entry someone is on, when it changes, while they're solving. */
  noteFocus(conn) {
    if (!conn.active || !conn.cursor || this.record.completed) return;
    const { index, dir } = conn.cursor;
    const word = this.model.wordAt(index, dir) ?? this.model.wordAt(index, dir === 'A' ? 'D' : 'A');
    const id = word?.id ?? null;
    if (id === conn.focus) return;
    conn.focus = id;
    this.log('w', conn.user, { cell: index, value: id, dir });
  }

  /** Log someone starting or stopping (the entry they're on restarts too). */
  noteActive(conn) {
    conn.focus = null;
    if (this.record.completed) return;
    this.log('p', conn.user, { value: conn.active ? '1' : '0' });
    this.noteFocus(conn);
  }

  broadcast(msg, except = null) {
    for (const c of this.conns) if (c !== except) c.send(msg);
  }

  /** A person's color in this solve. */
  colorOf(user) {
    return this.colors.get(user.name) ?? user.color;
  }

  memberList() {
    return this.members.map((m) => ({ ...publicUser(m), color: this.colorOf(m) }));
  }

  presence() {
    return [...this.conns].map((c) => ({
      conn: c.id,
      user: c.user.name,
      display_name: c.user.display_name,
      color: this.colorOf(c.user),
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
        members: this.memberList(),
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
    if (!this.conns.has(conn)) return;
    if (conn.active) {
      conn.active = false;
      this.noteActive(conn);
    }
    this.conns.delete(conn);
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
    this.log('s', null, { value: shouldRun ? 'start' : 'stop' });
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
    this.hub.store.appendEvents(this.id, this.eventBuf.splice(0));
  }

  // ---------- operations ----------

  /** `dir` is the direction the sender was typing in, for the log. */
  applyCells(conn, opId, changes, dir = null) {
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
      if (fill !== rec.fill[i] || marks !== rec.marks[i]) {
        this.log('c', conn.user, { cell: i, value: fill, marks, dir: dirOrNull(dir) });
      }
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
    this.checkComplete(conn);
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

  /** An assist (check, reveal, autocheck) only goes in the log. */
  logAssist(conn, { kind, scope, index, dir }) {
    if (this.record.completed) return;
    const value = `${kind}:${scope}`;
    if (!ASSIST_RE.test(value)) throw new RoomError('bad-op', 'unknown assist');
    const cell = Number.isInteger(index) && index >= 0 && index < this.model.cells.length ? index : null;
    this.log('a', conn.user, { cell, value, dir: dirOrNull(dir) });
  }

  checkComplete(conn) {
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
    this.log('d', conn?.user ?? null);
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
    this.hub.saveSummary(this.id, this.model);
  }

  setCursor(conn, index, dir) {
    if (!Number.isInteger(index) || index < 0 || index >= this.model.cells.length) return;
    conn.cursor = { index, dir: dir === 'D' ? 'D' : 'A' };
    this.broadcast({ type: 'cursor', conn: conn.id, user: conn.user.name, ...conn.cursor }, conn);
    this.noteFocus(conn);
  }

  setActive(conn, on) {
    const was = conn.active;
    conn.active = !!on;
    if (was !== conn.active) {
      this.noteActive(conn);
      this.updateTimer();
      this.broadcast({ type: 'presence', presence: this.presence() });
    }
  }

  /** Co-op pause button: stops everyone. */
  pauseAll(conn) {
    for (const c of this.conns) {
      if (!c.active) continue;
      c.active = false;
      this.noteActive(c);
    }
    this.updateTimer();
    this.broadcast({ type: 'paused', by: conn.user.name, conn: conn.id });
    this.broadcast({ type: 'presence', presence: this.presence() });
  }

  /**
   * Erase the grid and the clock ("Reset puzzle & timer"). The log keeps
   * the earlier attempt; 'r' starts the next one.
   */
  reset(conn = null) {
    this.record = newProgress(this.model, this.puzzleId, this.record.user);
    this.record.updated_at = nowIso();
    this.checker = new SolveEngine(this.model, this.record, {});
    this.timerBase = 0;
    this.timerSince = null;
    this.version++;
    this.log('r', conn?.user ?? null);
    this.dirty = true;
    this.flush();
    for (const c of this.conns) {
      c.active = false;
      c.focus = null;
    }
    for (const c of this.conns) c.send({ ...this.snapshot(c), reset: true });
  }

  refreshMembers() {
    this.members = this.hub.store.members(this.id);
    // people already here keep their colors; newcomers get free ones
    this.colors = distinctColors(oldestFirst(this.members), { keep: this.colors });
    this.broadcast({ type: 'members', members: this.memberList() });
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
    this.conns = new Set(); // every connected client
    this.nextConnId = 1;
  }

  /**
   * Wrap a transport: `send(obj)` delivers one message to this client and
   * `close()` (optional) hangs up on it.
   */
  connect(user, send, close) {
    const conn = { id: `c${this.nextConnId++}`, user, send, close, room: null, active: false, cursor: null };
    this.conns.add(conn);
    return conn;
  }

  disconnect(conn) {
    this.conns.delete(conn);
    conn.room?.remove(conn);
  }

  /**
   * An account is being deleted: close its live connections, run `remove`
   * (the DB delete) once its open solves are flushed, then tell co-op
   * partners the member list changed.
   */
  dropUser(userId, remove) {
    for (const conn of [...this.conns]) {
      if (conn.user.id !== userId) continue;
      this.disconnect(conn);
      conn.close?.();
    }
    const shared = [...this.rooms.values()].filter((room) => room.members.some((m) => m.id === userId));
    // their logged events reference the account, so they go in before it goes
    for (const room of shared) room.flush();
    remove();
    for (const room of shared) room.refreshMembers();
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

  /**
   * Summarize a completed solve's log into solve_summaries. The first
   * completion's summary stands unless `replace` (a newer ANALYSIS_VERSION).
   */
  saveSummary(solveId, model, { replace = false } = {}) {
    try {
      this.store.saveSummary(solveId, summarize(model, this.store.events(solveId)), { replace });
    } catch (err) {
      this.log.error?.(`summary for solve ${solveId}: ${err.stack || err}`);
    }
  }

  /** Recompute summaries missing or made by an older analysis (at startup). */
  async refreshSummaries() {
    let count = 0;
    for (const { id, puzzle_id } of this.store.solvesNeedingSummary(ANALYSIS_VERSION)) {
      const model = await this.puzzles.model(puzzle_id);
      if (!model) continue;
      this.saveSummary(id, model, { replace: true });
      count++;
    }
    if (count) this.log.info?.(`summarized ${count} solve log${count === 1 ? '' : 's'}`);
    return count;
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
          room.applyCells(conn, msg.opId ?? null, msg.changes, msg.dir);
          break;
        case 'assist':
          room.logAssist(conn, msg);
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
          room.reset(conn);
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
