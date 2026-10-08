/* Tests for js/words.js: the builder's word list and suggestions. */
import assert from 'node:assert/strict';

import { WordIndex, LayeredIndex, normalizeWord, parseWordList, cleanEntries, clampScore, DEFAULT_SCORE } from '../js/words.js';
import { mulberry32 } from '../js/stats-math.js';

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

test('words: list files also take commas and tabs before a score; a BOM is ignored', () => {
  const list = parseWordList('﻿CRANE,90\nCRATE\t40\nHELLO, WORLD\nICE CREAM;55\n', { defaultScore: 30 });
  assert.deepEqual(list, [['CRANE', 90], ['CRATE', 40], ['HELLO, WORLD', 30], ['ICE CREAM', 55]]);
});

test('words: a person’s entries are plain words scored 0-100; a 0 wins', () => {
  const { words, skipped } = cleanEntries([['ice cream', 120], ['R2D2', 50], ['area', 40.4], ['AREA', 70], ['esne', 60], ['ESNE', 0], ['x', 5]]);
  assert.deepEqual([...words], [['ICECREAM', 100], ['AREA', 70], ['ESNE', 0]]);
  assert.equal(skipped, 2);
  assert.equal(clampScore(-3), 0);
  assert.equal(clampScore('abc'), DEFAULT_SCORE);
});

test('words: a person’s lists sit over the site’s: their scores replace it, 0 hides', () => {
  const site = new WordIndex([['CAT', 60], ['COT', 70], ['CUT', 80], ['DOG', 50], ['ESNE', 90]]);
  const view = new LayeredIndex(site, [['cot', 95], ['CUT', 0], ['CAB', 40], ['ESNE', 10]]);
  assert.deepEqual(view.suggest('C??').words, [['COT', 95], ['CAT', 60], ['CAB', 40]], 'merged best first; CUT is hidden');
  assert.equal(view.count('C?T'), 2);
  assert.equal(view.count('????'), 1);
  assert.equal(view.size, 5, 'CAT COT DOG ESNE CAB');
  assert.equal(view.scoreOf('cot'), 95);
  assert.equal(view.scoreOf('CUT'), null);
  assert.equal(view.scoreOf('ESNE'), 10);
  assert.equal(view.scoreOf('DOG'), 50);
  assert.equal(site.scoreOf('CUT'), 80, 'the shared index is untouched');
  assert.equal(site.count('C?T'), 3);
  // the site's list turned off: only their own words
  const alone = new LayeredIndex(null, [['cot', 95], ['CUT', 0], ['CAB', 40]]);
  assert.deepEqual(alone.suggest('C??').words, [['COT', 95], ['CAB', 40]]);
  assert.equal(alone.size, 2);
  // the same word in two of their lists: the best score, unless one hides it
  const twice = new LayeredIndex(site, [['DOG', 20], ['DOG', 30], ['CAT', 70], ['CAT', 0]]);
  assert.equal(twice.scoreOf('DOG'), 30);
  assert.equal(twice.scoreOf('CAT'), null);
});

test('words: crossings count every layer’s words', () => {
  // ??T crosses ?AB at its first square; TAB is only in the person's list
  const site = new WordIndex(['CAT', 'COT', 'TAT', 'TOT'].map((w) => [w, 50]));
  const plain = site.suggest('??T', [{ pattern: '?AB', at: 0 }, null, null]);
  assert.equal(plain.total, 0, 'nothing fits ?AB on the site’s list alone');
  const view = new LayeredIndex(site, [['TAB', 60], ['TUT', 70], ['TOT', 0]]);
  const crossed = view.suggest('??T', [{ pattern: '?AB', at: 0 }, null, null]);
  assert.deepEqual(crossed.words, [['TUT', 70], ['TAT', 50]]);
  assert.equal(crossed.loose, 4, 'CAT COT TAT TUT');
  assert.equal(String.fromCharCode(65 + Math.log2(view.lettersAt('?AB', 0))), 'T');
});

test('words: big layered lists match a plain index of the same words', () => {
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const word = () => Array.from({ length: 4 }, () => 'ABCDE'[Math.floor(rand() * 5)]).join('');
  const siteEntries = Array.from({ length: 400 }, () => [word(), Math.floor(rand() * 100)]);
  const ownEntries = Array.from({ length: 150 }, () => [word(), Math.floor(rand() * 101)]);
  const site = new WordIndex(siteEntries);
  const view = new LayeredIndex(site, ownEntries);
  // the same thing worked out by hand: their scores replace the site's, 0 hides
  const { words: own } = cleanEntries(ownEntries);
  const merged = new Map([...site.suggest('????', [], 1e6).words]);
  for (const [w, s] of own) {
    if (s) merged.set(w, s);
    else merged.delete(w);
  }
  const expected = new WordIndex([...merged]);
  for (const pattern of ['????', 'A???', '?B?C', 'EEEE', 'A?A?']) {
    assert.equal(view.count(pattern), expected.count(pattern), pattern);
    assert.deepEqual(view.suggest(pattern, [], 1e6).words, expected.suggest(pattern, [], 1e6).words, pattern);
  }
  const cross = [{ pattern: 'A??', at: 1 }, null, { pattern: '?C?', at: 0 }, null];
  assert.deepEqual(view.suggest('????', cross, 1e6), expected.suggest('????', cross, 1e6));
  assert.equal(view.size, expected.size);
});

test('words: a view patched with changes matches one built from scratch', () => {
  const rand = mulberry32(5);
  const word = () => Array.from({ length: 3 + Math.floor(rand() * 2) }, () => 'ABCD'[Math.floor(rand() * 4)]).join('');
  const siteOf = () => new WordIndex(Array.from({ length: 200 }, () => [word(), Math.floor(rand() * 100)]));
  let site = siteOf();
  const truth = new Map(); // what their lists hold now: word -> score (0 hides it)
  for (let k = 0; k < 80; k++) truth.set(word(), Math.floor(rand() * 101));
  let view = new LayeredIndex(site, truth);
  const same = (a, b, label) => {
    for (const pattern of ['???', '????', 'A??', '?B?C', 'DD??']) {
      assert.equal(a.count(pattern), b.count(pattern), `${label} ${pattern}`);
      assert.deepEqual(a.suggest(pattern, [], 1e6), b.suggest(pattern, [], 1e6), `${label} ${pattern}`);
    }
    const cross = [{ pattern: 'A??', at: 1 }, null, { pattern: '?C??', at: 0 }];
    assert.deepEqual(a.suggest('???', cross, 1e6), b.suggest('???', cross, 1e6), label);
    for (const w of [...truth.keys()].slice(0, 30)) assert.equal(a.scoreOf(w), b.scoreOf(w), `${label} ${w}`);
    assert.equal(a.size, b.size, `${label} size`);
  };
  for (let round = 0; round < 12; round++) {
    const changes = new Map();
    for (let k = 0; k < 6; k++) {
      const w = rand() < 0.5 ? [...truth.keys()][Math.floor(rand() * truth.size)] : word();
      const r = rand();
      const s = r < 0.3 ? null : r < 0.45 ? 0 : 1 + Math.floor(rand() * 100);
      changes.set(w, s);
      if (s == null) truth.delete(w);
      else truth.set(w, s);
    }
    view = view.withChanges(changes);
    same(view, new LayeredIndex(site, truth), `round ${round}`);
    if (round === 5) {
      site = siteOf(); // the site's list was rebuilt
      view = view.over(site);
      same(view, new LayeredIndex(site, truth), 'over a new site list');
    }
  }
  same(view.over(null), new LayeredIndex(null, truth), 'without the site’s list');
  same(view.over(null).over(site), new LayeredIndex(site, truth), 'and with it again');
});
