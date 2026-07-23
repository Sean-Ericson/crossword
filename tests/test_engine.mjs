/* Unit tests for js/engine.js (pure solve logic) and js/state.js merge
 * policy, using the fixture15 puzzle. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import {
  SolveEngine,
  MARK_PENCIL,
  MARK_WRONG,
  MARK_REVEALED,
  MARK_CONFIRMED,
} from '../js/engine.js';
import { newProgress, mergeProgress, statusOf } from '../js/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const puz = parsePuz(readFileSync(path.join(here, 'fixtures', 'fixture15.puz')));
const model = new PuzzleModel(puz);

const REBUS_CELL = 2 * 15 + 0; // 'HEART'
const DOWN_ONLY_CELL = 7 * 15 + 7;

function fresh(settings = {}) {
  const record = newProgress(model, 'test', 'tester');
  const engine = new SolveEngine(model, record, {
    skipFilled: true,
    jumpBack: false,
    ...settings,
  });
  return { engine, record };
}

function correctChar(i) {
  return model.cells[i].solution[0].toUpperCase();
}

function wrongChar(i) {
  return correctChar(i) === 'Z' ? 'Y' : 'Z';
}

/** Solve every cell correctly except the given indexes (skips them). */
function fillAllExcept(engine, record, except = []) {
  for (const cell of model.cells) {
    if (cell.isBlack || except.includes(cell.index)) continue;
    engine.select(cell.index, cell.across ? 'A' : 'D', false);
    // write directly through setCell to avoid advancement side effects
    engine.setCell(cell.index, cell.solution.toUpperCase());
  }
}

test('engine: starts at 1-Across first cell', () => {
  const { engine } = fresh();
  const first = model.clueOrder[0];
  assert.equal(engine.sel.dir, 'A');
  assert.equal(engine.sel.index, first.cells[0]);
});

test('engine: typing fills, uppercases, and advances to next empty', () => {
  const { engine, record } = fresh();
  const word = engine.currentWord();
  engine.typeLetter('q');
  assert.equal(record.fill[word.cells[0]], 'Q');
  assert.equal(engine.sel.index, word.cells[1]);
});

test('engine: skipFilled skips filled squares within the word', () => {
  const { engine, record } = fresh();
  const word = engine.currentWord();
  // pre-fill second cell
  engine.setCell(word.cells[1], 'X');
  engine.typeLetter('A');
  assert.equal(engine.sel.index, word.cells[2], 'should skip the filled cell');
  void record;
});

test('engine: skipFilled off advances strictly one cell', () => {
  const { engine } = fresh({ skipFilled: false });
  const word = engine.currentWord();
  engine.setCell(word.cells[1], 'X');
  engine.typeLetter('A');
  assert.equal(engine.sel.index, word.cells[1]);
});

test('engine: at word end moves to next incomplete clue', () => {
  const { engine } = fresh();
  const word = engine.currentWord();
  for (const _ of word.cells) engine.typeLetter('A');
  const next = model.clueOrder[1];
  assert.equal(engine.currentWord(), next);
  assert.equal(engine.sel.index, next.cells.find((i) => engine.record.fill[i] === ''));
});

test('engine: jumpBack returns to earlier blank at word end', () => {
  const { engine } = fresh({ jumpBack: true });
  const word = engine.currentWord();
  engine.select(word.cells[1], 'A'); // leave first cell blank
  for (let k = 1; k < word.cells.length; k++) engine.typeLetter('B');
  assert.equal(engine.sel.index, word.cells[0], 'should jump back to the blank');
});

test('engine: backspace clears in place, then walks backward', () => {
  const { engine, record } = fresh();
  const word = engine.currentWord();
  engine.typeLetter('A');
  engine.typeLetter('B');
  // cursor on cells[2] (empty). Backspace: move to cells[1] and clear it.
  engine.backspace();
  assert.equal(engine.sel.index, word.cells[1]);
  assert.equal(record.fill[word.cells[1]], '');
  // cell under cursor now empty -> backspace moves again and clears cells[0]
  engine.backspace();
  assert.equal(engine.sel.index, word.cells[0]);
  assert.equal(record.fill[word.cells[0]], '');
});

test('engine: backspace at word start wraps to previous clue tail', () => {
  const { engine } = fresh();
  const first = model.clueOrder[0];
  const last = model.clueOrder[model.clueOrder.length - 1];
  engine.select(first.cells[0], 'A');
  engine.backspace();
  assert.equal(engine.currentWord(), last);
  assert.equal(engine.sel.index, last.cells[last.cells.length - 1]);
});

test('engine: perpendicular arrow toggles direction without moving', () => {
  const { engine } = fresh();
  const at = engine.sel.index;
  engine.moveArrow(1, 0); // down arrow while in Across mode
  assert.equal(engine.sel.dir, 'D');
  assert.equal(engine.sel.index, at);
});

test('engine: parallel arrow moves and skips black squares', () => {
  const { engine } = fresh();
  // row 0: cells 0-3 white, cell 4 black, cells 5-9 white
  engine.select(3, 'A');
  engine.moveArrow(0, 1);
  assert.equal(engine.sel.index, 5, 'should skip the black square at 4');
  engine.moveArrow(0, -1);
  assert.equal(engine.sel.index, 3);
});

test('engine: arrow at grid edge stays put', () => {
  const { engine } = fresh();
  engine.select(0, 'A');
  engine.moveArrow(0, -1);
  assert.equal(engine.sel.index, 0);
});

test('engine: second click on the same cell toggles direction', () => {
  const { engine } = fresh();
  engine.select(1, 'A');
  engine.clickCell(0); // new cell: selects, keeps direction
  assert.equal(engine.sel.dir, 'A');
  assert.equal(engine.sel.index, 0);
  engine.clickCell(0); // same cell: toggles
  assert.equal(engine.sel.dir, 'D');
});

test('engine: selection on a down-only cell forces Down', () => {
  const { engine } = fresh();
  engine.select(DOWN_ONLY_CELL, 'A');
  assert.equal(engine.sel.dir, 'D');
});

test('engine: Tab cycles clues and wraps across->down', () => {
  const { engine } = fresh();
  engine.nextClue(1);
  assert.equal(engine.currentWord(), model.clueOrder[1]);
  engine.nextClue(-1);
  engine.nextClue(-1); // wraps to the end (last down clue)
  assert.equal(engine.currentWord(), model.clueOrder[model.clueOrder.length - 1]);
});

test('engine: space clears and steps one cell', () => {
  const { engine, record } = fresh();
  const word = engine.currentWord();
  engine.typeLetter('A');
  engine.select(word.cells[0], 'A');
  engine.space();
  assert.equal(record.fill[word.cells[0]], '');
  assert.equal(engine.sel.index, word.cells[1]);
});

test('engine: pencil mode marks entries; pen overwrite clears mark', () => {
  const { engine, record } = fresh();
  const i = engine.sel.index;
  engine.setPencil(true);
  engine.typeLetter('A');
  assert.ok(record.marks[i] & MARK_PENCIL);
  engine.setPencil(false);
  engine.select(i, 'A');
  engine.typeLetter('B');
  assert.equal(record.marks[i] & MARK_PENCIL, 0);
});

test('engine: check marks only wrong, non-empty cells; sets used_check', () => {
  const { engine, record } = fresh();
  const word = engine.currentWord();
  const [a, b, c] = word.cells;
  engine.setCell(a, correctChar(a));
  engine.setCell(b, wrongChar(b));
  engine.check('word');
  assert.equal(record.marks[a] & MARK_WRONG, 0, 'correct unmarked');
  assert.ok(record.marks[b] & MARK_WRONG, 'wrong marked');
  assert.equal(record.marks[c] & MARK_WRONG, 0, 'empty skipped');
  assert.ok(record.used_check);
  assert.equal(record.clean, false);
});

test('engine: wrong mark clears when the cell is edited', () => {
  const { engine, record } = fresh();
  const i = engine.sel.index;
  engine.setCell(i, wrongChar(i));
  engine.check('letter');
  assert.ok(record.marks[i] & MARK_WRONG);
  engine.select(i, 'A');
  engine.typeLetter(correctChar(i));
  assert.equal(record.marks[i] & MARK_WRONG, 0);
});

test('engine: reveal sets solution, locks cell, survives clear', () => {
  const { engine, record } = fresh();
  const i = engine.sel.index;
  engine.reveal('letter');
  assert.equal(record.fill[i], model.cells[i].solution.toUpperCase());
  assert.ok(record.marks[i] & MARK_REVEALED);
  assert.ok(engine.isLocked(i));
  assert.ok(record.used_reveal);
  // typing on a locked cell advances without changing it
  engine.select(i, 'A');
  engine.typeLetter('Z');
  assert.equal(record.fill[i], model.cells[i].solution.toUpperCase());
  // clear does not remove revealed cells
  engine.clearPuzzle();
  assert.equal(record.fill[i], model.cells[i].solution.toUpperCase());
  assert.ok(record.marks[i] & MARK_REVEALED);
});

test('engine: autocheck locks confirmed-correct cells while on', () => {
  const { engine, record } = fresh();
  const i = engine.sel.index;
  engine.setCell(i, correctChar(i));
  engine.setAutocheck(true);
  assert.ok(record.marks[i] & MARK_CONFIRMED);
  assert.ok(engine.isLocked(i));
  assert.ok(record.used_check);
  // wrong entries get marked as typed
  const j = engine.currentWord().cells[1];
  engine.select(j, 'A');
  engine.typeLetter(wrongChar(j));
  assert.ok(record.marks[j] & MARK_WRONG);
  // toggling off releases locks
  engine.setAutocheck(false);
  assert.equal(engine.isLocked(i), false);
});

test('engine: rebus entry commits multi-char; first-letter also correct', () => {
  const { engine, record } = fresh();
  engine.select(REBUS_CELL, 'A');
  engine.typeRebus('heart');
  assert.equal(record.fill[REBUS_CELL], 'HEART');
  assert.ok(engine.isCorrect(REBUS_CELL));
  engine.select(REBUS_CELL, 'A');
  engine.setCell(REBUS_CELL, 'H'); // Across Lite first-letter convention
  assert.ok(engine.isCorrect(REBUS_CELL));
  engine.setCell(REBUS_CELL, 'X');
  assert.equal(engine.isCorrect(REBUS_CELL), false);
});

test('engine: completion — clean solve', () => {
  const { engine, record } = fresh();
  const events = [];
  engine.on('full', (e) => events.push(e));
  const lastCell = model.cells.filter((c) => !c.isBlack).at(-1).index;
  fillAllExcept(engine, record, [lastCell]);
  engine.select(lastCell, 'A');
  engine.typeLetter(correctChar(lastCell));
  assert.deepEqual(events, [{ solved: true, clean: true }]);
  assert.ok(record.completed);
  assert.ok(record.clean);
  assert.ok(record.solved_at);
  assert.equal(statusOf(record), 'solved-clean');
  // mutations after completion are ignored
  engine.typeLetter('Z');
  assert.ok(engine.isFull());
});

test('engine: completion — filled but wrong announces, then solves on fix', () => {
  const { engine, record } = fresh();
  const events = [];
  engine.on('full', (e) => events.push(e));
  const target = model.cells.filter((c) => !c.isBlack)[0].index;
  fillAllExcept(engine, record, [target]);
  engine.select(target, 'A');
  engine.typeLetter(wrongChar(target));
  assert.deepEqual(events.at(-1), { solved: false, clean: false });
  assert.equal(record.completed, false);
  // fix it
  engine.select(target, 'A');
  engine.typeLetter(correctChar(target));
  assert.deepEqual(events.at(-1), { solved: true, clean: true });
  assert.ok(record.completed);
});

test('engine: solve after reveal is not clean', () => {
  const { engine, record } = fresh();
  engine.reveal('letter');
  fillAllExcept(engine, record, []);
  engine.checkFull();
  assert.ok(record.completed);
  assert.equal(record.clean, false);
  assert.equal(statusOf(record), 'solved');
});

test('state: mergeProgress — completed wins outright', () => {
  const a = newProgress(model, 'p', 'u');
  const b = newProgress(model, 'p', 'u');
  a.completed = true;
  a.updated_at = '2026-01-01T00:00:00Z';
  b.updated_at = '2026-06-01T00:00:00Z'; // newer but incomplete
  assert.equal(mergeProgress(a, b), a);
  assert.equal(mergeProgress(b, a), a);
});

test('state: mergeProgress — newer wins, elapsed maxed, assists OR-ed', () => {
  const a = newProgress(model, 'p', 'u');
  const b = newProgress(model, 'p', 'u');
  a.updated_at = '2026-06-02T00:00:00Z';
  a.elapsed = 100;
  a.fill[0] = 'A';
  b.updated_at = '2026-06-01T00:00:00Z';
  b.elapsed = 500;
  b.used_check = true;
  const m = mergeProgress(a, b);
  assert.equal(m.fill[0], 'A', "winner's grid kept");
  assert.equal(m.elapsed, 500, 'elapsed never lost');
  assert.ok(m.used_check);
  assert.equal(m.clean, false);
});

test('state: merge with null sides', () => {
  const a = newProgress(model, 'p', 'u');
  assert.equal(mergeProgress(a, null), a);
  assert.equal(mergeProgress(null, a), a);
});
