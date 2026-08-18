/*
 * model.js — turns a parsed .puz (see puz.js) into a play-ready structure:
 * numbered cells, across/down words with clue text, and cell<->word links.
 *
 * Numbering is a faithful port of puzpy's DefaultClueNumbering: scan the
 * grid row-major; a cell starts an across word when it's at the left edge
 * or right of a black square and the run length is > 1 (down analogous);
 * clues are consumed from the flat .puz clue list in that scan order
 * (across before down at the same cell); the number increments whenever a
 * cell starts at least one word.
 */

import { isBlackChar } from './puz.js';
import { findClueReferences } from './util.js';

export class PuzzleModel {
  /** @param {ReturnType<import('./puz.js').parsePuz>} puz */
  constructor(puz) {
    this.puz = puz;
    this.width = puz.width;
    this.height = puz.height;

    const w = this.width;
    const h = this.height;
    const n = w * h;
    const sol = puz.solution;

    const lenAcross = (i) => {
      const col = i % w;
      let c = 0;
      for (; c < w - col; c++) if (isBlackChar(sol[i + c])) return c;
      return c;
    };
    const lenDown = (i) => {
      const row = (i / w) | 0;
      let c = 0;
      for (; c < h - row; c++) if (isBlackChar(sol[i + c * w])) return c;
      return c;
    };

    /** @type {Array<{id:string,dir:'A'|'D',num:number,clueIndex:number,clueText:string,cells:number[]}>} */
    const across = [];
    const down = [];
    let clueIndex = 0;
    let num = 1;
    for (let i = 0; i < n; i++) {
      if (isBlackChar(sol[i])) continue;
      const startedAt = clueIndex;
      const col = i % w;
      const row = (i / w) | 0;
      if (col === 0 || isBlackChar(sol[i - 1])) {
        const len = lenAcross(i);
        if (len > 1) {
          const cells = [];
          for (let c = 0; c < len; c++) cells.push(i + c);
          across.push({
            id: 'A' + num,
            dir: 'A',
            num,
            clueIndex,
            clueText: puz.clues[clueIndex] ?? '',
            clueHtml: puz.cluesFormatted?.[clueIndex] ?? null,
            cells,
          });
          clueIndex++;
        }
      }
      if (row === 0 || isBlackChar(sol[i - w])) {
        const len = lenDown(i);
        if (len > 1) {
          const cells = [];
          for (let c = 0; c < len; c++) cells.push(i + c * w);
          down.push({
            id: 'D' + num,
            dir: 'D',
            num,
            clueIndex,
            clueText: puz.clues[clueIndex] ?? '',
            clueHtml: puz.cluesFormatted?.[clueIndex] ?? null,
            cells,
          });
          clueIndex++;
        }
      }
      if (clueIndex > startedAt) num++;
    }

    this.words = { A: across, D: down };
    /** Tab order: all across in number order, then all down, wrapping. */
    this.clueOrder = [...across, ...down];
    /** 'A17' / 'D23' -> word, for resolving cross-references in clues. */
    this.byId = new Map(this.clueOrder.map((w) => [w.id, w]));

    const circledSet = new Set(puz.circled);
    /**
     * @type {Array<{index:number,row:number,col:number,isBlack:boolean,
     *   number:number,circled:boolean,solution:string,
     *   across:object|null,down:object|null}>}
     * `solution` is the full rebus string for rebus squares, else one char.
     */
    this.cells = [];
    for (let i = 0; i < n; i++) {
      this.cells.push({
        index: i,
        row: (i / w) | 0,
        col: i % w,
        isBlack: isBlackChar(sol[i]),
        number: 0,
        circled: circledSet.has(i),
        solution: puz.rebusSquares[i] ?? sol[i],
        across: null,
        down: null,
      });
    }
    for (const word of across) {
      this.cells[word.cells[0]].number = word.num;
      for (const c of word.cells) this.cells[c].across = word;
    }
    for (const word of down) {
      this.cells[word.cells[0]].number = word.num;
      for (const c of word.cells) this.cells[c].down = word;
    }
  }

  toIndex(row, col) {
    return row * this.width + col;
  }

  isBlack(index) {
    return this.cells[index].isBlack;
  }

  /** @returns {object|null} the word containing `index` in direction `dir` */
  wordAt(index, dir) {
    const cell = this.cells[index];
    return dir === 'A' ? cell.across : cell.down;
  }

  /** @returns {object|undefined} the word numbered `num` going `dir` */
  wordByNumber(num, dir) {
    return this.byId.get(dir + num);
  }

  /**
   * Entries this word's clue points at ("See 17-Across"), excluding itself.
   * Parsed from the plain text, so markup can't confuse it.
   */
  referencesOf(word) {
    if (!word) return [];
    return findClueReferences(word.clueText)
      .map(({ num, dir }) => this.wordByNumber(num, dir))
      .filter((w) => w && w !== word);
  }

  /** Position of `index` within clueOrder's word list, or -1. */
  clueOrderPos(word) {
    return this.clueOrder.indexOf(word);
  }

  /** Count of non-black cells. */
  get whiteCellCount() {
    let c = 0;
    for (const cell of this.cells) if (!cell.isBlack) c++;
    return c;
  }
}
