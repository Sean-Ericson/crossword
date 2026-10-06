/* Tests for js/custom-puzzle.js: the doc format of puzzles made on the
 * site, its conversion to the parsePuz shape, edits, and publish checks. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { parsePuzzleId } from '../js/util.js';
import {
  emptyDoc,
  applyChange,
  valueAt,
  normalizeDoc,
  docToPuz,
  modelOf,
  docFromPuz,
  publishedCopy,
  puzzleFeatures,
  problems,
  partnerOf,
  detectSymmetry,
  sameShape,
  isCustomId,
  clueKey,
} from '../js/custom-puzzle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = new PuzzleModel(parsePuz(readFileSync(path.join(here, 'fixtures', 'fixture15.puz'))));

/** A doc from rows of letters ('.' black, ' ' empty) and clues by key. */
function docOf(rows, clues = {}, extra = {}) {
  const doc = emptyDoc({ width: rows[0].length, height: rows.length, ...extra });
  rows.join('').split('').forEach((ch, i) => applyChange(doc, { k: `cell:${i}`, v: ch === ' ' ? '' : ch }));
  for (const [key, text] of Object.entries(clues)) applyChange(doc, { k: `clue:${key}`, v: text });
  return doc;
}

const codes = (list) => list.map((p) => p.code).sort();
const wordAtStart = (model, dir, cell) => model.words[dir].find((w) => w.cells[0] === cell);

test('custom: ids are their own puzzle type', () => {
  assert.ok(isCustomId('custom-Ab3_x-9Q'));
  assert.ok(!isCustomId('custom-'));
  assert.ok(!isCustomId('2026-01-01'));
  assert.ok(!isCustomId('sample'));
  assert.deepEqual(parsePuzzleId('custom-Ab3_x-9Q'), { type: 'custom', date: null });
  assert.deepEqual(parsePuzzleId('sample'), { type: 'special', date: null });
});

test('custom: docToPuz numbers the grid and orders clues like a .puz', () => {
  const doc = docOf(['CAT', 'ORE', 'WEB'], {
    A0: 'Feline', D0: 'Bovine', D1: 'Exist', D2: 'Tee, oddly', A3: 'Mine find', A6: 'Spider’s work',
  });
  const puz = docToPuz(doc);
  assert.equal(puz.solution, 'CATOREWEB');
  assert.equal(puz.fill, '---------');
  assert.deepEqual(puz.clues, ['Feline', 'Bovine', 'Exist', 'Tee, oddly', 'Mine find', 'Spider’s work']);
  const model = new PuzzleModel(puz);
  assert.deepEqual(model.words.A.map((w) => [w.num, w.clueText]), [[1, 'Feline'], [4, 'Mine find'], [5, 'Spider’s work']]);
  assert.deepEqual(model.words.D.map((w) => [w.num, w.clueText]), [[1, 'Bovine'], [2, 'Exist'], [3, 'Tee, oddly']]);
  assert.equal(model.cells[8].solution, 'B');
});

test('custom: rebus squares, circles and formatted clues reach the model', () => {
  const doc = docOf(['CAT', 'ORE', 'WEB'], { A0: '<i>Cats</i> star', D0: 'x < y' });
  applyChange(doc, { k: 'cell:4', v: 'heart' });
  applyChange(doc, { k: 'circle:2', v: 1 });
  const puz = docToPuz(doc);
  assert.deepEqual(puz.rebusSquares, { 4: 'HEART' });
  assert.equal(puz.solution[4], 'H');
  assert.deepEqual(puz.circled, [2]);
  const model = new PuzzleModel(puz);
  const a1 = model.byId.get('A1');
  assert.equal(a1.clueText, 'Cats star');
  assert.equal(a1.clueHtml, '<i>Cats</i> star');
  assert.equal(model.byId.get('D1').clueText, 'x < y', 'no markup: stays plain text');
  assert.equal(model.byId.get('D1').clueHtml, null);
  assert.equal(model.cells[4].solution, 'HEART');
});

test('custom: clues stay with their entries when blocks change elsewhere', () => {
  const doc = docOf(['     ', '     ', '     ', '     ', '     '], { A0: 'Top row', D4: 'Right side', A10: 'Middle row' });
  applyChange(doc, { k: 'cell:12', v: '.' }); // the center square
  const model = modelOf(doc);
  assert.equal(wordAtStart(model, 'A', 0).clueText, 'Top row');
  assert.equal(wordAtStart(model, 'D', 4).clueText, 'Right side');
  assert.equal(wordAtStart(model, 'A', 10).clueText, 'Middle row', 'the left half keeps the row’s clue');
  assert.equal(wordAtStart(model, 'A', 13).clueText, '');
  // block the first square of the middle row: its clue is orphaned, not lost
  applyChange(doc, { k: 'cell:10', v: '.' });
  assert.equal(modelOf(doc).words.A.some((w) => w.clueText === 'Middle row'), false);
  assert.equal(doc.clues.A10, 'Middle row');
  assert.equal(publishedCopy(doc).clues.A10, undefined, 'orphaned clues stay out of the published copy');
  applyChange(doc, { k: 'cell:10', v: '' });
  assert.equal(wordAtStart(modelOf(doc), 'A', 10).clueText, 'Middle row', 'undoing the block brings it back');
});

test('custom: applyChange checks every kind of change', () => {
  const doc = emptyDoc({ width: 3, height: 3 });
  assert.deepEqual(applyChange(doc, { k: 'cell:0', v: 'q' }), { k: 'cell:0', v: 'Q' });
  assert.deepEqual(applyChange(doc, { k: 'cell:1', v: 'ab1' }), { k: 'cell:1', v: 'AB1' });
  assert.deepEqual(applyChange(doc, { k: 'cell:1', v: 'A-B' }), { k: 'cell:1', v: 'AB1' }, 'invalid: unchanged');
  assert.deepEqual(applyChange(doc, { k: 'cell:2', v: 'ABCDEFGHIJKLM' }), { k: 'cell:2', v: '' }, 'too long');
  assert.deepEqual(applyChange(doc, { k: 'cell:2', v: 7 }), { k: 'cell:2', v: '' });
  assert.equal(applyChange(doc, { k: 'cell:9', v: 'A' }), null, 'off the grid');
  assert.equal(applyChange(doc, { k: 'nope', v: 'A' }), null);
  assert.deepEqual(applyChange(doc, { k: 'circle:4', v: true }), { k: 'circle:4', v: 1 });
  assert.deepEqual(applyChange(doc, { k: 'circle:4', v: 0 }), { k: 'circle:4', v: 0 });
  assert.deepEqual(applyChange(doc, { k: 'clue:A0', v: 'See <img src="x"> here' }), { k: 'clue:A0', v: 'See  here' });
  assert.deepEqual(applyChange(doc, { k: 'clue:A0', v: '' }), { k: 'clue:A0', v: '' });
  assert.equal('A0' in doc.clues, false, 'an empty clue is removed');
  assert.equal(applyChange(doc, { k: 'clue:A99', v: 'x' }), null);
  assert.equal(applyChange(doc, { k: 'title', v: 'x'.repeat(500) }).v.length, 120);
  assert.deepEqual(applyChange(doc, { k: 'symmetry', v: 'diagonal' }), { k: 'symmetry', v: 'rotational' });
  assert.deepEqual(applyChange(doc, { k: 'symmetry', v: 'mirror' }), { k: 'symmetry', v: 'mirror' });
  assert.equal(valueAt(doc, 'cell:0'), 'Q');
  assert.equal(valueAt(doc, 'clue:D3'), '');
  // once published the shape can't change; letters still can
  assert.deepEqual(applyChange(doc, { k: 'cell:0', v: '.' }, { shapeLocked: true }), { k: 'cell:0', v: 'Q' });
  assert.deepEqual(applyChange(doc, { k: 'cell:0', v: 'Z' }, { shapeLocked: true }), { k: 'cell:0', v: 'Z' });
  applyChange(doc, { k: 'cell:8', v: '.' });
  assert.deepEqual(applyChange(doc, { k: 'cell:8', v: '' }, { shapeLocked: true }), { k: 'cell:8', v: '.' });
});

test('custom: normalizeDoc keeps what is valid and refuses bad sizes', () => {
  assert.throws(() => normalizeDoc({ width: 2, height: 5 }), /3×3 to 25×25/);
  assert.throws(() => normalizeDoc({ width: 26, height: 5 }), /3×3 to 25×25/);
  assert.throws(() => normalizeDoc(null), /3×3/);
  const doc = normalizeDoc({
    width: 3,
    height: 3,
    grid: ['a', '.', 'heart', '$', 5, '', 'b'],
    circles: [1, 0, 'x'],
    clues: { A0: 'ok', Z0: 'bad key', A50: 'off the grid', D2: '<img src=x>Pic' },
    title: '  Title  ',
    symmetry: 'nope',
    evil: true,
  });
  assert.deepEqual(doc.grid, ['A', '.', 'HEART', '', '', '', 'B', '', '']);
  assert.deepEqual(doc.circles, [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(doc.clues, { A0: 'ok', D2: 'Pic' });
  assert.equal(doc.title, '  Title  ', 'text is trimmed at publish, not while typing');
  assert.equal(doc.symmetry, 'rotational');
  assert.equal('evil' in doc, false);
});

test('custom: problems lists what blocks publishing', () => {
  const blank = emptyDoc({ width: 3, height: 3 });
  assert.deepEqual(codes(problems(blank).blockers), ['empty', 'unclued']);
  assert.equal(problems(blank).blockers.find((p) => p.code === 'empty').cells.length, 9);

  // square 0 has no white neighbor across or down
  const orphan = docOf(['A.CD', '.FGH', 'IJKL', 'MNOP']);
  const found = problems(orphan).blockers.find((p) => p.code === 'orphan');
  assert.deepEqual(found.cells, [0]);

  const done = docOf(['CAT', 'ORE', 'WEB'], { A0: 'a', D0: 'b', D1: 'c', D2: 'd', A3: 'e', A6: 'f' });
  assert.deepEqual(problems(done), { blockers: [], warnings: [] });
  const unclued = problems(docOf(['CAT', 'ORE', 'WEB'], { A0: 'a', D0: 'b' })).blockers[0];
  assert.equal(unclued.code, 'unclued');
  assert.equal(unclued.message, '4 entries need a clue: 4-Across, 5-Across, 2-Down and 3-Down.');
  assert.deepEqual(unclued.keys, ['A3', 'A6', 'D1', 'D2']);
});

test('custom: problems warns about unusual grids', () => {
  const w = (rows, extra) => codes(problems(docOf(rows, {}, extra)).warnings);
  assert.deepEqual(w(['AB.', 'CDE', '.FG']), ['short']);
  assert.deepEqual(w(['ABC', 'D.E', 'FGH']), ['unchecked']);
  assert.deepEqual(w(['A.B', 'C.D', 'E.F']), ['split', 'unchecked']);
  assert.deepEqual(w(['.BC', 'DEF', 'GHI']), ['asymmetric', 'short']);
  assert.deepEqual(w(['.BC', 'DEF', 'GHI'], { symmetry: 'none' }), ['short']);
  const dup = problems(docOf(['ERA', 'R.R', 'ARE'])).warnings.find((p) => p.code === 'duplicate');
  assert.match(dup.message, /^ERA is used 2 times \(1-Across and 1-Down\)\.$/);
});

test('custom: symmetry partners and detection', () => {
  assert.equal(partnerOf(0, 5, 5, 'rotational'), 24);
  assert.equal(partnerOf(7, 5, 5, 'rotational'), 17);
  assert.equal(partnerOf(6, 5, 5, 'mirror'), 8);
  assert.equal(partnerOf(7, 5, 5, 'mirror'), 7, 'the middle column mirrors itself');
  assert.equal(partnerOf(7, 5, 5, 'none'), 7);
  assert.equal(detectSymmetry(docOf(['.BC', 'DEF', 'GH.']).grid, 3, 3), 'rotational');
  assert.equal(detectSymmetry(docOf(['.B.', 'DEF', 'GHI']).grid, 3, 3), 'mirror');
  assert.equal(detectSymmetry(docOf(['.BC', 'DEF', 'GHI']).grid, 3, 3), 'none');
  assert.ok(sameShape(docOf(['.BC', 'DEF', 'GH.']), docOf(['.XY', 'ZZZ', 'QQ.'])));
  assert.ok(!sameShape(docOf(['.BC', 'DEF', 'GH.']), docOf(['ABC', 'DEF', 'GH.'])));
});

test('custom: a .puz becomes a draft that plays the same', () => {
  const doc = docFromPuz(fixture.puz);
  const model = modelOf(doc);
  assert.equal(model.width, fixture.width);
  for (const cell of fixture.cells) {
    const mine = model.cells[cell.index];
    assert.equal(mine.isBlack, cell.isBlack, `square ${cell.index}`);
    assert.equal(mine.circled, cell.circled, `circle ${cell.index}`);
    if (!cell.isBlack) assert.equal(mine.solution, cell.solution.toUpperCase(), `answer ${cell.index}`);
  }
  assert.deepEqual(model.puz.rebusSquares, { 30: 'HEART', 194: 'QUARTZ' });
  assert.deepEqual(model.clueOrder.map((w) => w.clueText), fixture.clueOrder.map((w) => w.clueText));
  assert.equal(doc.title, fixture.puz.title);
  assert.equal(doc.byline, fixture.puz.author);
  assert.deepEqual(problems(doc).blockers, []);
  assert.throws(() => docFromPuz({ ...fixture.puz, scrambled: true }), /scrambled/);
  assert.throws(() => docFromPuz({ ...fixture.puz, width: 30 }), /builder takes/);
});

test('custom: features match tools/build_index.py', () => {
  // puzzles/sample.puz is this fixture; index.json has its numbers
  const index = JSON.parse(readFileSync(path.join(here, '..', 'puzzles', 'index.json'), 'utf8'));
  const sample = index.puzzles.find((p) => p.id === 'sample');
  const expected = { blocks: sample.blocks, words: sample.words, avg_len: sample.avg_len, rebus: sample.rebus, circles: sample.circles };
  assert.deepEqual(puzzleFeatures(fixture), expected);
  assert.deepEqual(puzzleFeatures(modelOf(docFromPuz(fixture.puz))), expected);
  assert.equal(clueKey(fixture.clueOrder[0]), 'A0');
});
