/*
 * engine.js — pure crossword solve logic, no DOM. Mirrors NYT Games
 * behavior: cursor movement, typing/advancement, pencil, check/reveal/
 * autocheck, rebus entries, and completion detection.
 *
 * Emits:
 *   'cells'      number[]                 cell indexes whose render changed
 *   'selection'  {index, dir, word}       cursor or active word changed
 *   'dirty'      record                   progress record mutated
 *   'full'       {solved, clean}          grid became/stayed full after a
 *                                         fill mutation (page shows congrats
 *                                         or "not quite")
 */

import { isoNow } from './util.js';

export const MARK_PENCIL = 0x01;
export const MARK_WRONG = 0x02;
export const MARK_REVEALED = 0x04;
export const MARK_CONFIRMED = 0x08;

export class SolveEngine {
  /**
   * @param {import('./model.js').PuzzleModel} model
   * @param {object} record   progress record (mutated in place; see state.js)
   * @param {object} settings live-updated {skipFilled, jumpBack}
   */
  constructor(model, record, settings) {
    this.model = model;
    this.record = record;
    this.settings = settings;
    this.pencil = false;
    this.listeners = {};

    // start at the first across word's first cell (NYT starts at 1-Across)
    const first = model.clueOrder[0];
    this.sel = { index: first ? first.cells[0] : 0, dir: first ? first.dir : 'A' };
    this.fixDirection();
  }

  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
    return this;
  }

  emit(event, data) {
    for (const cb of this.listeners[event] ?? []) cb(data);
  }

  // ---------- selection ----------

  currentWord() {
    return this.model.wordAt(this.sel.index, this.sel.dir);
  }

  crossWord() {
    return this.model.wordAt(this.sel.index, this.sel.dir === 'A' ? 'D' : 'A');
  }

  /** Ensure the current direction has a word at the cursor; flip if not. */
  fixDirection() {
    if (!this.currentWord() && this.crossWord()) {
      this.sel.dir = this.sel.dir === 'A' ? 'D' : 'A';
    }
  }

  select(index, dir = this.sel.dir, emit = true) {
    this.sel.index = index;
    this.sel.dir = dir;
    this.fixDirection();
    if (emit) this.emitSelection();
  }

  emitSelection() {
    this.emit('selection', {
      index: this.sel.index,
      dir: this.sel.dir,
      word: this.currentWord(),
    });
  }

  toggleDirection() {
    if (this.crossWord()) {
      this.sel.dir = this.sel.dir === 'A' ? 'D' : 'A';
      this.emitSelection();
    }
  }

  /** Click on a cell: select; second click on the same cell toggles. */
  clickCell(index) {
    if (this.model.isBlack(index)) return;
    if (index === this.sel.index) {
      this.toggleDirection();
    } else {
      this.select(index);
    }
  }

  /** Arrow movement: parallel = move (skip blacks); perpendicular = toggle. */
  moveArrow(dr, dc) {
    const horizontal = dc !== 0;
    if ((horizontal && this.sel.dir === 'D') || (!horizontal && this.sel.dir === 'A')) {
      this.toggleDirection();
      return;
    }
    const { width, height } = this.model;
    let r = (this.sel.index / width) | 0;
    let c = this.sel.index % width;
    for (;;) {
      r += dr;
      c += dc;
      if (r < 0 || r >= height || c < 0 || c >= width) return; // edge: stay
      const i = this.model.toIndex(r, c);
      if (!this.model.isBlack(i)) {
        this.select(i);
        return;
      }
    }
  }

  /** Jump to a word (clue click): first empty cell, else first cell. */
  selectWord(word) {
    const target =
      word.cells.find((i) => this.record.fill[i] === '') ?? word.cells[0];
    this.select(target, word.dir);
  }

  /** Tab / clue-bar chevrons: step delta through clueOrder, wrapping. */
  nextClue(delta) {
    const order = this.model.clueOrder;
    if (!order.length) return;
    const cur = this.currentWord();
    const pos = order.indexOf(cur);
    const next = order[(pos + delta + order.length) % order.length];
    this.selectWord(next);
  }

  // ---------- entry ----------

  isLocked(index) {
    if (this.record.completed) return true;
    const m = this.record.marks[index];
    return !!(m & MARK_REVEALED) || (this.record.autocheck && m & MARK_CONFIRMED);
  }

  touch() {
    this.record.updated_at = isoNow();
    this.emit('dirty', this.record);
  }

  /** Core cell write used by typing, rebus, space, and delete. */
  setCell(index, value) {
    const rec = this.record;
    rec.fill[index] = value;
    let m = rec.marks[index] & ~(MARK_WRONG | MARK_CONFIRMED);
    if (value === '') {
      m &= ~MARK_PENCIL;
    } else if (this.pencil) {
      m |= MARK_PENCIL;
    } else {
      m &= ~MARK_PENCIL;
    }
    if (value !== '' && rec.autocheck) {
      if (this.isCorrect(index)) m |= MARK_CONFIRMED;
      else m |= MARK_WRONG;
    }
    rec.marks[index] = m;
  }

  typeLetter(ch) {
    if (this.record.completed) return;
    const i = this.sel.index;
    if (!this.isLocked(i)) {
      this.setCell(i, ch.toUpperCase());
      this.emit('cells', [i]);
      this.touch();
      this.checkFull();
      if (this.record.completed) return;
    }
    this.advanceAfterType();
  }

  /** Commit a rebus entry (multi-char). Empty commits clear the cell. */
  typeRebus(str) {
    if (this.record.completed) return;
    const i = this.sel.index;
    const value = str.trim().toUpperCase();
    if (!this.isLocked(i)) {
      this.setCell(i, value);
      this.emit('cells', [i]);
      this.touch();
      this.checkFull();
      if (this.record.completed) return;
      if (value !== '') this.advanceAfterType();
    }
  }

  /**
   * NYT advancement: next empty cell after the cursor within the word
   * (or simply next cell when skipFilled is off); when the rest of the
   * word is full — optionally jump back to an earlier blank — else move
   * on to the next incomplete clue's first empty cell; when the whole
   * grid is full, just step to the next cell in the word if any.
   */
  advanceAfterType() {
    const word = this.currentWord();
    if (!word) return;
    const rec = this.record;
    const pos = word.cells.indexOf(this.sel.index);

    if (!this.settings.skipFilled) {
      if (pos < word.cells.length - 1) {
        this.select(word.cells[pos + 1]);
        return;
      }
    } else {
      for (let k = pos + 1; k < word.cells.length; k++) {
        if (rec.fill[word.cells[k]] === '') {
          this.select(word.cells[k]);
          return;
        }
      }
      if (this.settings.jumpBack) {
        for (let k = 0; k < pos; k++) {
          if (rec.fill[word.cells[k]] === '') {
            this.select(word.cells[k]);
            return;
          }
        }
      }
    }

    // word finished: go to the next clue with an empty cell
    const order = this.model.clueOrder;
    const start = order.indexOf(word);
    for (let step = 1; step <= order.length; step++) {
      const w = order[(start + step) % order.length];
      const target = w.cells.find((i) => rec.fill[i] === '');
      if (target !== undefined) {
        this.select(target, w.dir);
        return;
      }
    }
    // grid is full: stay within the word, stepping once if possible
    if (pos < word.cells.length - 1) this.select(word.cells[pos + 1]);
    else this.emitSelection();
  }

  backspace() {
    if (this.record.completed) return;
    const i = this.sel.index;
    if (this.record.fill[i] !== '' && !this.isLocked(i)) {
      this.setCell(i, '');
      this.emit('cells', [i]);
      this.touch();
      return;
    }
    // move back one cell (into the previous clue from a word start)
    const word = this.currentWord();
    if (!word) return;
    const pos = word.cells.indexOf(i);
    let target = null;
    let dir = this.sel.dir;
    if (pos > 0) {
      target = word.cells[pos - 1];
    } else {
      const order = this.model.clueOrder;
      const prev = order[(order.indexOf(word) - 1 + order.length) % order.length];
      target = prev.cells[prev.cells.length - 1];
      dir = prev.dir;
    }
    this.select(target, dir);
    if (!this.isLocked(target) && this.record.fill[target] !== '') {
      this.setCell(target, '');
      this.emit('cells', [target]);
      this.touch();
    }
  }

  deleteKey() {
    if (this.record.completed) return;
    const i = this.sel.index;
    if (!this.isLocked(i) && this.record.fill[i] !== '') {
      this.setCell(i, '');
      this.emit('cells', [i]);
      this.touch();
    }
  }

  /** Space: clear the cell and step forward one cell in the word. */
  space() {
    if (this.record.completed) return;
    const i = this.sel.index;
    if (!this.isLocked(i)) {
      if (this.record.fill[i] !== '') {
        this.setCell(i, '');
        this.emit('cells', [i]);
        this.touch();
      }
    }
    const word = this.currentWord();
    if (!word) return;
    const pos = word.cells.indexOf(i);
    if (pos < word.cells.length - 1) this.select(word.cells[pos + 1]);
  }

  // ---------- assists ----------

  /** Rebus-forgiving correctness: full string match or first letter. */
  isCorrect(index) {
    const entry = this.record.fill[index];
    if (entry === '' || entry === '.') return false;
    const sol = this.model.cells[index].solution.toUpperCase();
    return entry === sol || (entry.length === 1 && entry === sol[0]);
  }

  scopeCells(scope) {
    if (scope === 'letter') return [this.sel.index];
    if (scope === 'word') return this.currentWord()?.cells ?? [];
    return this.model.cells.filter((c) => !c.isBlack).map((c) => c.index);
  }

  check(scope) {
    if (this.record.completed || this.model.puz.scrambled) return;
    const rec = this.record;
    rec.used_check = true;
    rec.clean = false;
    const changed = [];
    for (const i of this.scopeCells(scope)) {
      if (rec.fill[i] === '' || rec.marks[i] & MARK_REVEALED) continue;
      if (!this.isCorrect(i)) {
        if (!(rec.marks[i] & MARK_WRONG)) {
          rec.marks[i] |= MARK_WRONG;
          changed.push(i);
        }
      }
    }
    if (changed.length) this.emit('cells', changed);
    this.touch();
  }

  reveal(scope) {
    if (this.record.completed || this.model.puz.scrambled) return;
    const rec = this.record;
    rec.used_reveal = true;
    rec.clean = false;
    const changed = [];
    for (const i of this.scopeCells(scope)) {
      if (rec.marks[i] & MARK_REVEALED) continue;
      const sol = this.model.cells[i].solution.toUpperCase();
      const wasCorrect = this.isCorrect(i) && rec.fill[i] === sol;
      rec.fill[i] = sol;
      rec.marks[i] =
        (rec.marks[i] & ~(MARK_PENCIL | MARK_WRONG | MARK_CONFIRMED)) |
        (wasCorrect ? 0 : MARK_REVEALED);
      changed.push(i);
    }
    if (changed.length) this.emit('cells', changed);
    this.touch();
    this.checkFull();
  }

  setAutocheck(on) {
    const rec = this.record;
    if (rec.autocheck === on) return;
    rec.autocheck = on;
    const changed = [];
    if (on) {
      rec.used_check = true;
      rec.clean = false;
      for (const cell of this.model.cells) {
        if (cell.isBlack) continue;
        const i = cell.index;
        if (rec.fill[i] === '' || rec.marks[i] & MARK_REVEALED) continue;
        const m = rec.marks[i];
        rec.marks[i] = this.isCorrect(i) ? m | MARK_CONFIRMED : m | MARK_WRONG;
        if (rec.marks[i] !== m) changed.push(i);
      }
    }
    if (changed.length) this.emit('cells', changed);
    this.touch();
  }

  clearWord() {
    this.clearCells(this.currentWord()?.cells ?? []);
  }

  clearPuzzle() {
    this.clearCells(this.model.cells.filter((c) => !c.isBlack).map((c) => c.index));
  }

  clearCells(cells) {
    if (this.record.completed) return;
    const rec = this.record;
    const changed = [];
    for (const i of cells) {
      if (this.isLocked(i)) continue;
      if (rec.fill[i] !== '' || rec.marks[i] & (MARK_PENCIL | MARK_WRONG)) {
        rec.fill[i] = '';
        rec.marks[i] &= MARK_REVEALED; // revealed mark survives, rest clears
        changed.push(i);
      }
    }
    if (changed.length) {
      this.emit('cells', changed);
      this.touch();
    }
  }

  setPencil(on) {
    this.pencil = on;
  }

  // ---------- completion ----------

  isFull() {
    return this.record.fill.every((v) => v !== '');
  }

  allCorrect() {
    for (const cell of this.model.cells) {
      if (!cell.isBlack && !this.isCorrect(cell.index)) return false;
    }
    return true;
  }

  /**
   * Called after fill mutations. On a full grid: either finish the solve
   * or announce "not quite". Scrambled puzzles (no usable solution)
   * complete as soon as they're full.
   */
  checkFull() {
    if (this.record.completed || !this.isFull()) return;
    const scrambled = this.model.puz.scrambled;
    if (scrambled || this.allCorrect()) {
      const rec = this.record;
      rec.completed = true;
      rec.solved_at = isoNow();
      rec.clean = !rec.used_check && !rec.used_reveal && !scrambled;
      this.touch();
      this.emit('full', { solved: true, clean: rec.clean });
    } else {
      this.emit('full', { solved: false, clean: false });
    }
  }
}
