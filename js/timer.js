/*
 * timer.js — drift-free accumulator timer. Elapsed time only advances
 * between start() and pause(); the interval tick is display-only.
 */

export class Timer {
  /** @param {number} initialElapsed seconds already on the clock */
  constructor(initialElapsed = 0) {
    this.accumulated = initialElapsed;
    this.resumedAt = null; // ms timestamp while running, else null
    this.interval = null;
    this.tickCbs = [];
  }

  get running() {
    return this.resumedAt !== null;
  }

  /** Current elapsed seconds (fractional truncated). */
  get seconds() {
    const live = this.resumedAt === null ? 0 : (Date.now() - this.resumedAt) / 1000;
    return Math.floor(this.accumulated + live);
  }

  start() {
    if (this.running) return;
    this.resumedAt = Date.now();
    this.interval = setInterval(() => this.notify(), 500);
    this.notify();
  }

  pause() {
    if (!this.running) return;
    this.accumulated += (Date.now() - this.resumedAt) / 1000;
    this.resumedAt = null;
    clearInterval(this.interval);
    this.interval = null;
    this.notify();
  }

  /** Overwrite elapsed time (remote merge applied a different value). */
  setElapsed(seconds) {
    this.accumulated = seconds;
    if (this.running) this.resumedAt = Date.now();
    this.notify();
  }

  stop() {
    this.pause();
  }

  onTick(cb) {
    this.tickCbs.push(cb);
    return this;
  }

  notify() {
    for (const cb of this.tickCbs) cb(this.seconds, this.running);
  }
}
