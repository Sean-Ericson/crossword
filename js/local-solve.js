/*
 * local-solve.js — a stand-in for LiveSolve (net.js) when an author test
 * solves their own puzzle (puzzle.html?id=…&test=1). Same interface and
 * events, no server: the grid starts blank, the clock runs here, and
 * nothing is saved or sent anywhere. The engine decides when it's solved
 * (deferCompletion stays off).
 */

import { newProgress } from './state.js';

export class LocalSolve {
  /** @param {{puzzleId: string, model: import('./model.js').PuzzleModel, user: {name, display_name, color}}} opts */
  constructor({ puzzleId, model, user }) {
    this.puzzleId = puzzleId;
    this.model = model;
    this.user = user;
    this.connId = 'local';
    this.status = 'connecting';
    this.pending = [];
    this.listeners = {};
    this.base = 0; // seconds banked
    this.since = null; // ms while the clock runs
  }

  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  emit(event, ...args) {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }

  get live() {
    return true;
  }

  elapsed() {
    return this.base + (this.since == null ? 0 : (Date.now() - this.since) / 1000);
  }

  snapshot(extra = {}) {
    const me = { name: this.user.name, display_name: this.user.display_name, color: this.user.color };
    this.emit(
      'snapshot',
      {
        type: 'snapshot',
        you: this.connId,
        solve: { id: null, kind: 'solo', puzzle_id: this.puzzleId, members: [me] },
        record: newProgress(this.model, this.puzzleId, this.user.name),
        version: 0,
        presence: [],
        timer: { elapsed: 0, running: false },
        ...extra,
      },
      []
    );
  }

  connect() {
    this.status = 'live';
    this.emit('status', 'live');
    this.snapshot();
  }

  setActive(on) {
    if (!!on === (this.since != null)) return;
    if (on) {
      this.since = Date.now();
    } else {
      this.base = this.elapsed();
      this.since = null;
    }
    this.emit('timer', { elapsed: this.elapsed(), running: this.since != null });
  }

  pauseAll() {
    this.setActive(false);
  }

  reset() {
    this.base = 0;
    this.since = null;
    this.snapshot({ reset: true });
  }

  // nothing goes anywhere
  sendCells() {}
  sendFlags() {}
  sendAssist() {}
  sendCursor() {}
  nudge() {}
  close() {}
}
