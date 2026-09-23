/*
 * net.js — live connection to one solve on the server (server/rooms.mjs).
 *
 * Client -> server:
 *   {type:'join', solve?:id, puzzle?:id}    solo solves join by puzzle id
 *   {type:'cells', opId, changes:[{i, fill, marks}]}
 *   {type:'flags', used_check?, used_reveal?, autocheck?}
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
 *   error     {code, message, re}
 *
 * Edits are applied locally first and kept in `pending` until the server
 * echoes them back. While a cell has an edit in flight, other people's
 * values for it are ignored: ours reaches the server later, so it wins
 * there too, and the ack brings the final value. On reconnect the pending
 * edits are re-applied over the fresh snapshot and sent again.
 *
 * Events: 'status' ('connecting'|'live'|'offline'), 'snapshot'
 * (msg, overlayChanges), 'cells' (changes to apply), plus every other
 * server message type by name.
 */

export class LiveSolve {
  /** @param {{puzzleId: string, solveId?: string|null}} target */
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.connId = null;
    this.status = 'connecting';
    this.pending = []; // [{opId, changes}]
    this.inflight = new Map(); // cell index -> count of pending edits touching it
    this.nextOp = 1;
    this.listeners = {};
    this.retryMs = 1000;
    this.retryTimer = null;
    this.closed = false;
    this.lastCursor = null;
    this.active = false;
  }

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
      ws.send(
        JSON.stringify(
          this.target.solveId
            ? { type: 'join', solve: this.target.solveId }
            : { type: 'join', puzzle: this.target.puzzleId }
        )
      );
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

  // ---------- outgoing ----------

  /** Queue + send local cell edits. */
  sendCells(changes) {
    if (!changes.length) return;
    const op = { opId: this.nextOp++, changes };
    this.pending.push(op);
    for (const { i } of changes) this.inflight.set(i, (this.inflight.get(i) ?? 0) + 1);
    this.send({ type: 'cells', ...op });
  }

  sendFlags(flags) {
    this.pendingFlags = { ...this.pendingFlags, ...flags };
    if (this.send({ type: 'flags', ...this.pendingFlags })) this.pendingFlags = null;
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
    this.pending = [];
    this.inflight.clear();
    this.send({ type: 'reset' });
  }

  // ---------- incoming ----------

  receive(msg) {
    switch (msg.type) {
      case 'snapshot': {
        this.connId = msg.you;
        // our unacknowledged edits go on top of the server's grid, and
        // are sent again (the server never saw them, or saw them and the
        // snapshot already includes them - re-applying is harmless)
        const overlay = this.pending.flatMap((op) => op.changes);
        this.setStatus('live');
        this.emit('snapshot', msg, overlay);
        for (const op of this.pending) this.send({ type: 'cells', ...op });
        if (this.pendingFlags) this.sendFlags({});
        if (this.lastCursor) this.send({ type: 'cursor', ...this.lastCursor });
        if (this.active) this.send({ type: 'active', on: true });
        break;
      }
      case 'cells': {
        const ours = msg.conn === this.connId && this.pending[0]?.opId === msg.opId;
        if (ours) {
          this.pending.shift();
          const settled = [];
          for (const ch of msg.changes) {
            const left = (this.inflight.get(ch.i) ?? 1) - 1;
            if (left > 0) {
              this.inflight.set(ch.i, left);
            } else {
              this.inflight.delete(ch.i);
              settled.push(ch); // the server's final say (normally our own value)
            }
          }
          if (settled.length) this.emit('cells', settled);
        } else {
          const apply = msg.changes.filter((ch) => !this.inflight.has(ch.i));
          if (apply.length) this.emit('cells', apply, msg);
        }
        break;
      }
      default:
        this.emit(msg.type, msg);
    }
  }
}
