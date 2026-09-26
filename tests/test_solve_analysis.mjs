/* Unit tests for js/solve-analysis.js: turning a solve's event log into
 * times, errors, dwell and the stored summary. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { MARK_REVEALED, MARK_WRONG } from '../js/engine.js';
import { analyzeSolve, attemptOf, replayGrid, sampleCurve, summarize } from '../js/solve-analysis.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = new PuzzleModel(parsePuz(readFileSync(path.join(here, 'fixtures', 'fixture15.puz'))));
const open = model.cells.filter((c) => !c.isBlack).map((c) => c.index);
const answer = (i) => model.cells[i].solution.toUpperCase();
const wrongFor = (i) => (answer(i)[0] === 'Z' ? 'Y' : 'Z');

/** A little log builder: seq and wall time follow along. */
function log() {
  const events = [];
  const add = (kind, t, fields = {}) => {
    events.push({ seq: events.length + 1, t, at: 1e12 + t, user: 'sean', kind, cell: null, value: null, marks: 0, dir: null, ...fields });
    return api;
  };
  const api = {
    events,
    c: (t, cell, value, fields = {}) => add('c', t, { cell, value, ...fields }),
    w: (t, word, fields = {}) => add('w', t, { value: word, ...fields }),
    add,
  };
  return api;
}

/** Every square right, one per `step` ms from `t0`. */
function fillAll(l, t0, step, fields = {}) {
  open.forEach((i, k) => l.c(t0 + k * step, i, answer(i), { dir: 'A', ...fields }));
  return t0 + (open.length - 1) * step;
}

test('analysis: first letter, stall, typo hunt, curve', () => {
  const l = log();
  l.add('s', 0, { value: 'start', user: null });
  const first = open[0];
  l.c(5_000, first, wrongFor(first), { dir: 'A' }); // wrong, fixed at the very end
  const rest = open.slice(1);
  rest.forEach((i, k) => l.c(6_000 + k * 100, i, answer(i), { dir: 'D' }));
  const full = 6_000 + (rest.length - 1) * 100;
  l.c(full + 30_000, first, answer(first), { dir: 'A' }); // the typo hunt took 30 s
  l.add('d', full + 30_000);
  const a = analyzeSolve(model, l.events);
  assert.equal(a.done, true);
  assert.equal(a.firstEntry.t, 5_000);
  assert.deepEqual(a.stall, { ms: 30_000, at: full });
  assert.equal(a.fullAt, full);
  assert.equal(a.finishMs, 30_000);
  assert.equal(a.people[0].wrong, 1);
  assert.equal(a.people[0].fixedOwn, 1);
  assert.equal(a.people[0].across, 2);
  assert.equal(a.people[0].down, rest.length);
  assert.deepEqual(a.confusions, { [`${wrongFor(first)}>${answer(first)}`]: 1 });
  assert.deepEqual(a.fixLatency, [full + 30_000 - 5_000]);
  const curve = sampleCurve(a.curve, a.ms, a.cellCount);
  assert.equal(curve.filled.length, 51);
  assert.equal(curve.filled[0], 0);
  assert.equal(curve.filled.at(-1), 100);
  assert.ok(curve.correct.at(-2) < 100, 'one square wrong until the end');
});

test('analysis: entries lock in, rank in order, and collect dwell', () => {
  const l = log();
  const w1 = model.words.A[0];
  const w2 = model.words.A[1];
  l.w(0, w1.id);
  w1.cells.forEach((i, k) => l.c(1_000 + k, i, answer(i), { dir: 'A' }));
  l.w(10_000, w2.id);
  l.add('p', 12_000, { value: '0' }); // stepped away: dwell stops
  l.add('p', 50_000, { value: '1' });
  l.w(50_000, w2.id);
  w2.cells.forEach((i, k) => l.c(51_000 + k, i, answer(i), { dir: 'A' }));
  const a = analyzeSolve(model, l.events);
  const e1 = a.words.find((w) => w.id === w1.id);
  const e2 = a.words.find((w) => w.id === w2.id);
  assert.equal(e1.dwell, 10_000);
  assert.equal(e2.dwell, 2_000 + (51_000 + w2.cells.length - 1 - 50_000), 'closed at the end of the log');
  assert.equal(e1.rank, 1);
  assert.equal(e2.rank, 2);
  assert.equal(e1.locked, 1_000 + w1.cells.length - 1);
  assert.equal(e1.own, w1.cells.length);
  assert.equal(e1.answer, w1.cells.map(answer).join(''));
  assert.equal(a.done, false);
});

test('analysis: reveals are not typing; checks mark squares', () => {
  const l = log();
  const i = open[0];
  const j = open[1];
  l.c(1_000, i, wrongFor(i));
  l.add('a', 2_000, { value: 'check:letter', cell: i });
  l.c(2_000, i, wrongFor(i), { marks: MARK_WRONG });
  l.add('a', 3_000, { value: 'reveal:letter', cell: j });
  l.c(3_000, j, answer(j), { marks: MARK_REVEALED });
  const a = analyzeSolve(model, l.events);
  assert.equal(a.people[0].letters, 1);
  assert.equal(a.cells[i].checked, true);
  assert.equal(a.cells[j].revealed, true);
  assert.deepEqual(a.checks, { letter: 1, word: 0, puzzle: 0 });
  assert.deepEqual(a.reveals, { letter: 1, word: 0, puzzle: 0 });
});

test('analysis: co-op fixes are credited across people', () => {
  const l = log();
  const i = open[0];
  l.c(1_000, i, wrongFor(i), { user: 'sean' });
  l.c(2_000, i, answer(i), { user: 'devon' });
  const a = analyzeSolve(model, l.events);
  const byName = Object.fromEntries(a.people.map((p) => [p.name, p]));
  assert.equal(byName.sean.wrong, 1);
  assert.equal(byName.devon.fixedOthers, 1);
  assert.equal(byName.devon.final, 1);
  assert.equal(byName.sean.final, 0);
  assert.deepEqual(a.fixes, { 'devon>sean': 1 });
});

test('analysis: the first finished attempt counts; a baseline makes it partial', () => {
  const l = log();
  const end1 = fillAll(l, 1_000, 10);
  l.add('d', end1);
  l.add('r', 0);
  const end2 = fillAll(l, 500, 1);
  l.add('d', end2);
  assert.equal(attemptOf(l.events).at(-1).t, end1);
  assert.equal(analyzeSolve(model, l.events).ms, end1);

  const p = log();
  const fill = model.cells.map((c) => (c.isBlack ? '.' : ''));
  fill[open[0]] = answer(open[0]);
  p.add('b', 0, { user: null, value: JSON.stringify({ fill, marks: fill.map(() => 0) }) });
  open.slice(1).forEach((i, k) => p.c(1_000 + k, i, answer(i)));
  assert.equal(analyzeSolve(model, p.events).partial, true);
  assert.equal(replayGrid(model, p.events).fill[open[0]], answer(open[0]));
});

test('analysis: summary fits the stats payload', () => {
  const l = log();
  l.add('s', 0, { value: 'start', user: null });
  const end = fillAll(l, 2_000, 50);
  l.add('d', end);
  const { v, scalars, detail } = summarize(model, l.events);
  assert.ok(v >= 1);
  assert.equal(scalars.ms, end);
  assert.equal(scalars.letters, open.length);
  assert.equal(scalars.cells, open.length);
  assert.equal(scalars.words, model.clueOrder.length);
  assert.equal(scalars.start_cell, open[0]);
  assert.equal(scalars.start_word, model.cells[open[0]].across.id);
  assert.equal(scalars.by.sean.final, open.length);
  assert.equal(detail.words.length, model.clueOrder.length);
  assert.deepEqual(detail.missed, []);
  assert.equal(detail.quadrants.length, 4);
  assert.ok(JSON.stringify(scalars).length < 1_000, 'scalars stay small');
});
