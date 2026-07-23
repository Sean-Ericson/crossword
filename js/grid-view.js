/*
 * grid-view.js — DOM rendering of the puzzle grid. Cells are built once;
 * updates toggle classes / text only. All interaction is delegated to the
 * page via the onCellClick callback.
 */

import { el } from './util.js';
import {
  MARK_PENCIL,
  MARK_WRONG,
  MARK_REVEALED,
} from './engine.js';

export class GridView {
  /**
   * @param {HTMLElement} container
   * @param {import('./model.js').PuzzleModel} model
   * @param {{onCellClick?: (index:number) => void}} opts
   */
  constructor(container, model, opts = {}) {
    this.model = model;
    this.board = el('div', {
      class: 'board',
      style: `--cols:${model.width};--rows:${model.height}`,
      role: 'grid',
      'aria-label': 'Crossword grid',
    });
    this.cellEls = [];

    for (const cell of model.cells) {
      const node = el('div', {
        class: 'cell' + (cell.isBlack ? ' black' : ''),
        dataset: { i: String(cell.index) },
      });
      if (!cell.isBlack) {
        if (cell.circled) node.append(el('div', { class: 'cell-circle' }));
        if (cell.number) node.append(el('span', { class: 'cell-num' }, String(cell.number)));
        node.append(el('span', { class: 'cell-letter' }));
      }
      this.cellEls.push(node);
      this.board.append(node);
    }

    this.board.addEventListener('mousedown', (e) => {
      const cellEl = e.target.closest('.cell');
      if (!cellEl || cellEl.classList.contains('black')) return;
      e.preventDefault(); // keep focus/keyboard on document
      opts.onCellClick?.(Number(cellEl.dataset.i));
    });

    container.append(this.board);

    // size the board to fit its container, keeping square cells
    this.wrap = container;
    this.resizeObserver = new ResizeObserver(() => this.rescale());
    this.resizeObserver.observe(container);
    this.rescale();

    this.appliedSelection = [];
  }

  rescale() {
    const { width: cols, height: rows } = this.model;
    const availW = this.wrap.clientWidth || 0;
    const availH = this.wrap.clientHeight || 0;
    const MAX_CELL = 40; // NYT cells are ~33-38px
    const cell = Math.max(
      12,
      Math.min(
        Math.floor(availW / cols) || MAX_CELL,
        availH > 60 ? Math.floor(availH / rows) : Infinity,
        MAX_CELL
      )
    );
    this.board.style.width = `${cell * cols + 5}px`; // + frame/gap slack
    this.board.style.height = `${cell * rows + 5}px`;
    this.board.style.fontSize = `${Math.max(8, cell * 0.62)}px`;
  }

  /** Refresh a cell's letter + marker classes from the progress record. */
  updateCell(index, record) {
    const nodeEl = this.cellEls[index];
    const cell = this.model.cells[index];
    if (cell.isBlack) return;
    const value = record.fill[index];
    const marks = record.marks[index];
    const letterEl = nodeEl.querySelector('.cell-letter');
    letterEl.textContent = value;
    letterEl.dataset.len = String(value.length);
    nodeEl.classList.toggle('pencil', !!(marks & MARK_PENCIL));
    nodeEl.classList.toggle('wrong', !!(marks & MARK_WRONG));
    nodeEl.classList.toggle('revealed', !!(marks & MARK_REVEALED));
  }

  updateAll(record) {
    for (const cell of this.model.cells) {
      if (!cell.isBlack) this.updateCell(cell.index, record);
    }
  }

  setSelection(index, wordCells) {
    for (const i of this.appliedSelection) {
      this.cellEls[i].classList.remove('sel-cell', 'sel-word');
    }
    this.appliedSelection = [];
    for (const i of wordCells) {
      this.cellEls[i].classList.add('sel-word');
      this.appliedSelection.push(i);
    }
    if (index != null) {
      this.cellEls[index].classList.add('sel-cell');
      if (!wordCells.includes(index)) this.appliedSelection.push(index);
    }
  }

  clearSelection() {
    this.setSelection(null, []);
  }

  /** Viewport rect of a cell (for the rebus input overlay). */
  cellRect(index) {
    return this.cellEls[index].getBoundingClientRect();
  }

  setCompleted(done) {
    this.board.classList.toggle('completed', done);
  }
}
