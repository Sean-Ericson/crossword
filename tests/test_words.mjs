/* Tests for js/words.js: the builder's word list and suggestions. */
import assert from 'node:assert/strict';

import { WordIndex, normalizeWord, parseWordList } from '../js/words.js';

const letters = (mask) => [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((_, k) => mask & (1 << k)).join('');

test('words: entries are normalized; the best score wins', () => {
  assert.equal(normalizeWord('ice cream'), 'ICECREAM');
  assert.equal(normalizeWord("Rock 'n' roll"), 'ROCKNROLL');
  assert.equal(normalizeWord('Café'), 'CAFE');
  assert.equal(normalizeWord('A'), null, 'one letter');
  assert.equal(normalizeWord('R2D2'), null, 'digits');
  assert.equal(normalizeWord('x'.repeat(26)), null, 'too long');
  const index = new WordIndex([['cat', 40], ['CAT', 60], ['cat', 10], ['dog', 50]]);
  assert.equal(index.size, 2);
  assert.deepEqual(index.suggest('???').words, [['CAT', 60], ['DOG', 50]]);
});

test('words: list files in the usual WORD;SCORE format', () => {
  const list = parseWordList('# a comment\r\nAREA;60\narea;55\nZYZZYVA;25\nplain\n\nbad;score\n');
  assert.deepEqual(list, [['AREA', 60], ['area', 55], ['ZYZZYVA', 25], ['plain', 50], ['bad', 50]]);
});

test('words: patterns, counts and the letters a square can take', () => {
  const index = new WordIndex(['CAT', 'COT', 'CUT', 'COB', 'TAB', 'CATS'].map((w, k) => [w, 100 - k]));
  assert.equal(index.count('C?T'), 3);
  assert.equal(index.count('???'), 5);
  assert.equal(index.count('??B'), 2);
  assert.equal(index.count('Q??'), 0);
  assert.equal(index.count('????'), 1);
  assert.equal(index.count('?????'), 0, 'no words that long');
  assert.equal(index.count('C1T'), 0, 'not a letter');
  assert.equal(letters(index.lettersAt('C?T', 1)), 'AOU');
  assert.equal(letters(index.lettersAt('???', 2)), 'BT');
  assert.deepEqual(index.suggest('C?T', [], 2).words, [['CAT', 100], ['COT', 99]], 'best first, limited');
});

test('words: suggestions keep only words every crossing can take', () => {
  // the entry ??T crosses, at its first square, an entry whose pattern is ?AB:
  // only T (TAB) fits there, so of CAT/COT/CUT/... nothing starting with C survives
  const index = new WordIndex(['CAT', 'COT', 'CUT', 'TAT', 'TOT', 'TAB'].map((w) => [w, 50]));
  const plain = index.suggest('??T');
  assert.equal(plain.total, 5);
  const crossed = index.suggest('??T', [{ pattern: '?AB', at: 0 }, null, null]);
  assert.deepEqual(crossed.words.map(([w]) => w), ['TAT', 'TOT']);
  assert.equal(crossed.total, 2);
  assert.equal(crossed.loose, 5, 'and how many fit without the crossings');
  // a crossing nothing fits leaves nothing
  assert.equal(index.suggest('??T', [{ pattern: '?ZZ', at: 0 }]).total, 0);
  // filled squares aren't constrained by their crossings
  assert.equal(index.suggest('C?T', [{ pattern: '?ZZ', at: 0 }]).total, 3);
});

test('words: big lists stay consistent across bitset words', () => {
  // more than 32 words of a length: the bitsets span several Uint32 words
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = Array.from({ length: 500 }, () => Array.from({ length: 4 }, () => 'ABCDE'[Math.floor(rand() * 5)]).join(''));
  const index = new WordIndex(words.map((w) => [w, 1]));
  const unique = new Set(words);
  for (const pattern of ['????', 'A???', '?B?C', 'EEEE', 'A?A?']) {
    const re = new RegExp(`^${pattern.replace(/\?/g, '.')}$`);
    assert.equal(index.count(pattern), [...unique].filter((w) => re.test(w)).length, pattern);
  }
  assert.equal(index.suggest('????', [], 1000).words.length, unique.size);
});
