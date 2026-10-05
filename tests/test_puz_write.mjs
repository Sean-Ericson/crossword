/* Tests for js/puz-write.js: .puz files the builder and player hand out. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { writePuz, checksum, puzFileName } from '../js/puz-write.js';
import { encodeCp1252, decodeCp1252 } from '../js/cp1252.js';
import { emptyDoc, applyChange, docToPuz, docFromPuz, modelOf } from '../js/custom-puzzle.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const original = readFileSync(path.join(here, 'fixtures', 'fixture15.puz'));

test('puz write: header, checksums and text match a file puzpy wrote', () => {
  // the fixture came from tools/make_fixture.py (puzpy), whose reserved bytes are zero
  const bytes = writePuz(parsePuz(original));
  const textEnd = 0x34 + 2 * 225;
  assert.deepEqual([...bytes.subarray(0, 0x34)], [...original.subarray(0, 0x34)], 'header with all three checksums');
  // solution, fill, then title, author, copyright, clues and notes
  const end = (b) => {
    let pos = textEnd;
    for (let k = 0; k < 3 + 81 + 1; k++) pos = b.indexOf(0, pos) + 1;
    return pos;
  };
  assert.deepEqual([...bytes.subarray(0x34, end(bytes))], [...original.subarray(0x34, end(original))]);
});

test('puz write: rebus squares and circles read back the same', () => {
  const before = new PuzzleModel(parsePuz(original));
  const after = new PuzzleModel(parsePuz(writePuz(before.puz)));
  assert.deepEqual(after.puz.rebusSquares, before.puz.rebusSquares);
  assert.deepEqual(after.puz.circled, before.puz.circled);
  assert.deepEqual(after.cells.map((c) => c.solution), before.cells.map((c) => c.solution));
  assert.deepEqual(after.clueOrder.map((w) => w.clueText), before.clueOrder.map((w) => w.clueText));
  assert.equal(after.puz.notes, before.puz.notes);
});

test('puz write: a custom puzzle survives download and upload', () => {
  // C A T      a rebus (CAT) in the corner, a blank square (a draft),
  // O # E      a circle, and text Windows-1252 only partly covers
  // W E B
  const doc = emptyDoc({ width: 3, height: 3, title: 'Café “Noir” 🙂', byline: 'Sean & Devon' });
  ['cat', '', 'T', 'O', '.', 'E', 'W', 'E', 'B'].forEach((v, i) => applyChange(doc, { k: `cell:${i}`, v }));
  applyChange(doc, { k: 'circle:2', v: 1 });
  const clues = { A0: '<i>Felix</i>, e.g.', A6: 'Spider’s work', D0: 'Bovine', D2: 'Kitty – not “dog”' };
  for (const [key, v] of Object.entries(clues)) applyChange(doc, { k: `clue:${key}`, v });
  const back = docFromPuz(parsePuz(writePuz(docToPuz(doc))));
  assert.deepEqual(back.grid, ['CAT', '', 'T', 'O', '.', 'E', 'W', 'E', 'B'], 'the blank stays blank');
  assert.deepEqual(back.circles, doc.circles);
  assert.equal(back.title, 'Café “Noir” ?', 'Windows-1252 has no emoji');
  assert.equal(back.byline, 'Sean & Devon');
  assert.deepEqual(back.clues, { ...clues, A0: 'Felix, e.g.' }, 'markup stripped, punctuation kept');
  assert.deepEqual(modelOf(back).puz.rebusSquares, { 0: 'CAT' });
});

test('puz write: helpers', () => {
  assert.equal(checksum([]), 0);
  assert.equal(checksum([1, 2, 3]), checksum([3], checksum([2], checksum([1]))), 'sums chain');
  assert.equal(decodeCp1252(encodeCp1252('’“”–—€ é')), '’“”–—€ é');
  assert.deepEqual([...encodeCp1252('a🙂b')], [97, 63, 98]);
  assert.equal(puzFileName('Word Square!'), 'word-square.puz');
  assert.equal(puzFileName('Café au lait'), 'cafe-au-lait.puz');
  assert.equal(puzFileName('   ', 'custom-x'), 'custom-x.puz');
});
