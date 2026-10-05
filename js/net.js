/*
 * net.js — live connections to the server: a solve (server/rooms.mjs) or a
 * puzzle being built (server/build-rooms.mjs). Both use the /ws socket.
 *
 * ----- Solves (LiveSolve) -----
 *
 * Client -> server:
 *   {type:'join', solve?:id, puzzle?:id}    solo solves join by puzzle id
 *   {type:'cells', opId, changes:[{i, fill, marks}], dir?}
 *                                           dir: the direction being typed in
 *   {type:'flags', used_check?, used_reveal?, autocheck?}
 *   {type:'assist', kind, scope, index, dir}
 *                                           check/reveal letter|word|puzzle,
 *                                           or autocheck on|off; only logged
 *                                           (sent just before its cells)
 *   {type:'cursor', index, dir}
 *   {type:'active', on}                     this tab is solving (timer runs)
 *   {type:'pause'}                          pause everyone
 *   {type:'reset'}                          erase grid + timer
 *
 * Server -> client:
 *   snapshot  {you, solve:{id, kind, puzzle_id, members}, record, version, presence, timer}
 *   cells     {version, by, conn, opId, changes}   (conn === you => ack of opId)
 *   flags     {used_check, used_reveal, autocheck, clean, by}
 *   cursor    {conn, user, index, dir}
 *   presence  {presence:[{conn, user, display_name, color, cursor, active}]}
 *   timer     {elapsed, running}
 *   paused    {by, conn}
 *   completed {solved_at, clean, elapsed}
 *   members   {members}
 *   puzzle-updated {}                       the constructors updated this custom
 *                                           puzzle; reloading gets the new copy
 *   error     {code, message, re}
 *
 * A member's or presence entry's `color` is their color in this solve: their
 * account color, unless an older account in the solve has the same one
 * (see distinctColors in people.js and Room in server/rooms.mjs).
 *
 * ----- Builds (LiveBuild) -----
 *
 * The authors of a custom puzzle edit its working copy together. Changes
 * are {k, v} (the keys are listed in js/custom-puzzle.js; applyChange
 * checks and applies them on both ends).
 *
 * Client -> server:
 *   {type:'build', puzzle:id}               authors only
 *   {type:'edit', opId, changes:[{k, v}]}
 *   {type:'cursor', index, dir}             on the grid
 *   {type:'cursor', clue:'A0'}              typing that clue
 *   {type:'cursor'}                         neither
 *
 * Server -> client:
 *   snapshot  {you, puzzle:{id, status, visibility, shape_locked, changed,
 *              created_by, authors}, doc, version, presence}
 *   edit      {version, by, conn, opId, changes}   (conn === you => ack of opId)
 *   cursor    {conn, user, index?, dir?, clue?}
 *   presence  {presence:[{conn, user, display_name, color, cursor}]}
 *   authors   {authors}
 *   status    {status, visibility, shape_locked, changed, by}
 *                                           published, updated, withdrawn, or
 *                                           sharing changed
 *   deleted   {by}                          the puzzle is gone
 *   error     {code, message, re}
 *
 * ----- Both -----
 *
 * Edits are applied locally first and kept in `pending` until the server
 * echoes them back. While a cell (or, in a build, a key) has an edit in
 * flight, other people's values for it are ignored: ours reaches the server
 * later, so it wins there too, and the ack brings the final value. On
 * reconnect the pending edits are re-applied over the fresh snapshot and
 * sent again.
 *
 * Events: 'status' ('connecting'|'live'|'offline'), 'snapshot'
 * (msg, overlayChanges), 'cells' / 'edit' (changes to apply), plus every
 * other server message type by name.
 */

/** The socket, retries and optimistic-edit bookkeeping both kinds share. */
class LiveChannel {
  /**
   * @param {{opType: string, keyOf: (change: object) => any}} kind
   *   opType: the message that carries edits; keyOf: what a change touches
   */
  constructor({ opType, keyOf }) {
    this.opType = opType;
    this.keyOf = keyOf;
    this.ws = null;
    this.connId = null;
    this.status = 'connecting';
    this.pending = []; // [{opId, changes}]
    this.inflight = new Map(); // key -> count of pending edits touching it
    this.nextOp = 1;
    this.listeners = {};
    this.retryMs = 1000;
    this.retryTimer = null;
    this.closed = false;
    this.lastCursor = null;
  }

  /** The message that joins the room, sent on every (re)connect. */
  joinMessage() {
    throw new Error('not implemented');
  }

  /** Called after a snapshot's pending edits went out again. */
  resume() {}

  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  emit(event, ...args) {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  connect() {
    this.closed = false;
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.retryMs = 1000;
      ws.send(JSON.stringify(this.joinMessage()));
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connId = null;
      this.setStatus('offline');
      if (!this.closed) this.scheduleRetry();
    };
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.emit('retrying', this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  /** Reconnect now (e.g. the tab came back or the network returned). */
  nudge() {
    if (!this.ws && !this.closed) this.connect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  get live() {
    return this.status === 'live';
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN && this.connId) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Queue + send local edits; `extra` fields ride along with the op. */
  sendOp(changes, extra = {}) {
    if (!changes.length) return;
    const op = { opId: this.nextOp++, changes, ...extra };
    this.pending.push(op);
    for (const ch of changes) {
      const key = this.keyOf(ch);
      this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    }
    this.send({ type: this.opType, ...op });
  }

  /** Forget unsent edits (the room is starting over). */
  dropPending() {
    this.pending = [];
    this.inflight.clear();
  }

  receive(msg) {
    if (msg.type === 'snapshot') {
      this.connId = msg.you;
      // our unacknowledged edits go on top of the server's copy, and are
      // sent again (the server never saw them, or saw them and the
      // snapshot already includes them - re-applying is harmless)
      const overlay = this.pending.flatMap((op) => op.changes);
      this.setStatus('live');
      this.emit('snapshot', msg, overlay);
      for (const op of this.pending) this.send({ type: this.opType, ...op });
      this.resume();
      return;
    }
    if (msg.type === this.opType) {
      const ours = msg.conn === this.connId && this.pending[0]?.opId === msg.opId;
      if (ours) {
        const op = this.pending.shift();
        // what we sent is no longer in flight, even keys the server dropped
        for (const ch of op.changes) {
          const key = this.keyOf(ch);
          const left = (this.inflight.get(key) ?? 1) - 1;
          if (left > 0) this.inflight.set(key, left);
          else this.inflight.delete(key);
        }
        // the server's final say (normally our own values), except where a
        // later edit of ours is still on its way
        const settled = msg.changes.filter((ch) => !this.inflight.has(this.keyOf(ch)));
        if (settled.length) this.emit(this.opType, settled);
      } else {
        const apply = msg.changes.filter((ch) => !this.inflight.has(this.keyOf(ch)));
        if (apply.length) this.emit(this.opType, apply, msg);
      }
      return;
    }
    this.emit(msg.type, msg);
  }
}

export class LiveSolve extends LiveChannel {
  /** @param {{puzzleId: string, solveId?: string|null}} target */
  constructor(target) {
    super({ opType: 'cells', keyOf: (ch) => ch.i });
    this.target = target;
    this.active = false;
  }

  joinMessage() {
    return this.target.solveId
      ? { type: 'join', solve: this.target.solveId }
      : { type: 'join', puzzle: this.target.puzzleId };
  }

  resume() {
    if (this.pendingFlags) this.sendFlags({});
    if (this.lastCursor) this.send({ type: 'cursor', ...this.lastCursor });
    if (this.active) this.send({ type: 'active', on: true });
  }

  // ---------- outgoing ----------

  /** Queue + send local cell edits. */
  /** @param {{dir?: 'A'|'D'}} [meta] the typist's direction, for the solve log */
  sendCells(changes, { dir } = {}) {
    this.sendOp(changes, dir ? { dir } : {});
  }

  sendFlags(flags) {
    this.pendingFlags = { ...this.pendingFlags, ...flags };
    if (this.send({ type: 'flags', ...this.pendingFlags })) this.pendingFlags = null;
  }

  /** A check, reveal or autocheck toggle, for the solve log. Not queued. */
  sendAssist(kind, scope, index, dir) {
    this.send({ type: 'assist', kind, scope, index, dir });
  }

  sendCursor(index, dir) {
    this.lastCursor = { index, dir };
    this.send({ type: 'cursor', index, dir });
  }

  setActive(on) {
    this.active = !!on;
    this.send({ type: 'active', on: this.active });
  }

  pauseAll() {
    this.active = false;
    this.send({ type: 'pause' });
  }

  reset() {
    this.dropPending();
    // the fresh snapshot must not re-announce this tab as solving: the
    // clock waits for Begin
    this.active = false;
    this.send({ type: 'reset' });
  }
}

/** The puzzle builder's connection to a custom puzzle's working copy. */
export class LiveBuild extends LiveChannel {
  /** @param {{puzzleId: string}} target */
  constructor({ puzzleId }) {
    super({ opType: 'edit', keyOf: (ch) => ch.k });
    this.puzzleId = puzzleId;
  }

  joinMessage() {
    return { type: 'build', puzzle: this.puzzleId };
  }

  resume() {
    if (this.lastCursor) this.send({ type: 'cursor', ...this.lastCursor });
  }

  /** @param {Array<{k:string, v:any}>} changes */
  sendEdit(changes) {
    this.sendOp(changes);
  }

  /** @param {{index:number, dir:'A'|'D'}|{clue:string}|null} cursor */
  sendCursor(cursor) {
    this.lastCursor = cursor ?? {};
    this.send({ type: 'cursor', ...this.lastCursor });
  }
}
