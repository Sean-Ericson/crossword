/*
 * builder-engine.js — the cursor and typing in the puzzle builder. It's the
 * solver's engine (engine.js), so the keys feel the same, with three
 * differences for building:
 *   - arrows step one square at a time onto black squares too (that's how
 *     you get to a block to remove it), turning first when perpendicular;
 *   - typing moves through the entry and stops at its end (Tab goes on);
 *   - a full grid is never "solved".
 * The record it edits holds the puzzle's answers: record.fill[i] is the
 * doc's grid[i]. Blocks are the builder's to change (builder-page.js
 * toggleBlock), never typed.
 */

import { SolveEngine } from './engine.js';

export class BuildEngine extends SolveEngine {
  /**
   * @param {import('./model.js').PuzzleModel} model
   * @param {{fill: string[], marks: number[]}} record
   */
  constructor(model, record) {
    super(model, record, { skipFilled: false, jumpBack: false });
  }

  moveArrow(dr, dc) {
    const want = dc !== 0 ? 'A' : 'D';
    if (this.sel.dir !== want) {
      this.sel.dir = want;
      this.emitSelection();
      return;
    }
    const { width, height } = this.model;
    const r = Math.floor(this.sel.index / width) + dr;
    const c = (this.sel.index % width) + dc;
    if (r < 0 || r >= height || c < 0 || c >= width) return;
    this.sel.index = r * width + c;
    this.emitSelection();
  }

  /** Select any square, black ones included, keeping the direction when it can. */
  selectSquare(index, dir = this.sel.dir) {
    this.sel.index = index;
    this.sel.dir = dir;
    if (!this.model.isBlack(index)) this.fixDirection();
    this.emitSelection();
  }

  clickCell(index) {
    if (index === this.sel.index && !this.model.isBlack(index)) {
      // a lone square has no word either way; flip anyway, so typing goes where you look
      if (this.crossWord()) this.toggleDirection();
      else this.selectSquare(index, this.sel.dir === 'A' ? 'D' : 'A');
    } else {
      this.selectSquare(index);
    }
  }

  advanceAfterType() {
    const word = this.currentWord();
    if (!word) return this.emitSelection();
    const pos = word.cells.indexOf(this.sel.index);
    if (pos < word.cells.length - 1) this.select(word.cells[pos + 1]);
    else this.emitSelection();
  }

  checkFull() {}
}
