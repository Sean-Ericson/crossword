/* Cross-checks js/puz.js + js/model.js against the Python reference dumps
 * (tests/fixtures/*.expected.json produced by dump_puz.py), plus util tests. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import {
  formatTime,
  b64EncodeUtf8,
  b64DecodeUtf8,
  dateFromId,
  weekdayOf,
  parsePuzzleId,
  themeTitle,
} from '../js/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);

function jsDump(puzPath) {
  const p = parsePuz(readFileSync(puzPath));
  const m = new PuzzleModel(p);
  const words = (list) =>
    list.map((w) => ({
      num: w.num,
      clueIndex: w.clueIndex,
      cell: w.cells[0],
      len: w.cells.length,
    }));
  return {
    width: p.width,
    height: p.height,
    version: p.version,
    scrambled: p.scrambled,
    title: p.title,
    author: p.author,
    copyright: p.copyright,
    notes: p.notes,
    solution: p.solution,
    fill: p.fill,
    clues: p.clues,
    across: words(m.words.A),
    down: words(m.words.D),
    circled: p.circled,
    rebusSquares: p.rebusSquares,
  };
}

for (const name of ['fixture15', 'mega']) {
  test(`parser cross-check vs Python: ${name}`, () => {
    const expected = JSON.parse(
      readFileSync(fixture(name + '.expected.json'), 'utf-8')
    );
    const actual = jsDump(fixture(name + '.puz'));
    for (const key of Object.keys(expected)) {
      assert.deepEqual(actual[key], expected[key], `field '${key}' differs`);
    }
    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(expected).sort(),
      'dump key sets differ'
    );
  });
}

test('model: down-only cell has no across word', () => {
  const p = parsePuz(readFileSync(fixture('fixture15.puz')));
  const m = new PuzzleModel(p);
  const cell = m.cells[7 * 15 + 7]; // r7c7: black left+right, white above+below
  assert.equal(cell.isBlack, false);
  assert.equal(cell.across, null);
  assert.ok(cell.down, 'expected a down word');
});

test('model: cell/word linking is consistent', () => {
  const p = parsePuz(readFileSync(fixture('fixture15.puz')));
  const m = new PuzzleModel(p);
  for (const dir of ['A', 'D']) {
    for (const w of m.words[dir]) {
      for (const c of w.cells) {
        assert.equal(m.wordAt(c, dir), w, `cell ${c} not linked to ${w.id}`);
      }
    }
  }
  // every white cell is in at least one word
  for (const cell of m.cells) {
    if (!cell.isBlack) assert.ok(cell.across || cell.down);
  }
});

test('model: rebus square carries full solution string', () => {
  const p = parsePuz(readFileSync(fixture('fixture15.puz')));
  const m = new PuzzleModel(p);
  assert.equal(m.cells[2 * 15 + 0].solution, 'HEART');
  assert.equal(m.cells[12 * 15 + 14].solution, 'QUARTZ');
  assert.equal(m.cells[0].solution.length, 1);
});

test('util: formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(61), '1:01');
  assert.equal(formatTime(512), '8:32');
  assert.equal(formatTime(3725), '1:02:05');
});

test('util: base64 utf8 round-trip', () => {
  for (const s of ['hello', '“smart” — quotes…', '日本語 🧩', '']) {
    assert.equal(b64DecodeUtf8(b64EncodeUtf8(s)), s);
  }
  assert.equal(b64DecodeUtf8('aGVs\nbG8='), 'hello'); // tolerates newlines
});

test('util: date helpers', () => {
  assert.equal(dateFromId('2026-07-21'), '2026-07-21');
  assert.equal(dateFromId('mega2025'), null);
  assert.equal(weekdayOf('2026-07-21'), 2); // a Tuesday
  assert.equal(weekdayOf('2026-07-19'), 0); // a Sunday
});

test('util: parsePuzzleId classifies all types', () => {
  assert.deepEqual(parsePuzzleId('2026-07-21'), { type: 'daily', date: '2026-07-21' });
  assert.deepEqual(parsePuzzleId('mini-2026-07-21'), { type: 'mini', date: '2026-07-21' });
  assert.deepEqual(parsePuzzleId('midi-2026-07-21'), { type: 'midi', date: '2026-07-21' });
  assert.deepEqual(parsePuzzleId('bonus-2026-07-01'), { type: 'bonus', date: '2026-07-01' });
  assert.deepEqual(parsePuzzleId('mega2025'), { type: 'special', date: null });
  assert.deepEqual(parsePuzzleId('mini-2026-7-1'), { type: 'special', date: null });
  assert.deepEqual(parsePuzzleId('dateFromId-2026-07-21x'), { type: 'special', date: null });
});

test('util: themeTitle strips the generated NYT date prefix', () => {
  assert.equal(
    themeTitle('NY Times, Wednesday, July 1, 2026 GO-O-O-OAL ORIENTED'),
    'GO-O-O-OAL ORIENTED'
  );
  assert.equal(themeTitle('NY Times, Monday, July 27, 2026'), '');
  assert.equal(themeTitle('Super Mega 2025'), 'Super Mega 2025');
  assert.equal(themeTitle(''), '');
});
