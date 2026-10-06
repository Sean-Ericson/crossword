/*
 * words.js — the word list behind the builder's suggestions. Pure: the
 * server builds one (server/words.mjs) and answers /api/words with it.
 *
 * A pattern has one character per square: a letter, or '?' for a blank.
 * Words are A-Z only, 2 to MAX_LEN letters; rebus answers are left out,
 * since they don't fit one letter to a square.
 *
 * The index keeps, per length, the words (best score first) and one bitset
 * per (position, letter) of the words with that letter there, so a
 * pattern's matches are the AND of its letters' bitsets. suggest() goes one
 * step further, the way constructors fill: a word only counts if every
 * blank it fills leaves the entry crossing there something that fits.
 */

export const MAX_LEN = 25;
const DEFAULT_SCORE = 50;

/** "Ice-cream" -> "ICECREAM"; null for anything that isn't 2+ plain letters. */
export function normalizeWord(raw) {
  const w = String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[\s'’.\-_&]/g, '');
  return /^[A-Z]+$/.test(w) && w.length >= 2 && w.length <= MAX_LEN ? w : null;
}

/**
 * A word list file: one entry per line, "WORD;SCORE" (Spread the Wordlist,
 * Peter Broda's list, Crossfire and XWord Info dictionaries) or just "WORD".
 * Lines starting with # are comments.
 * @returns {Array<[string, number]>}
 */
export function parseWordList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [word, score] = line.split(';');
    const n = Number(score);
    out.push([word, score != null && score.trim() !== '' && Number.isFinite(n) ? n : DEFAULT_SCORE]);
  }
  return out;
}

const popcount = (bits) => {
  let n = 0;
  for (let v of bits) {
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    n += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return n;
};

function* setBits(bits) {
  for (let k = 0; k < bits.length; k++) {
    let v = bits[k];
    while (v) {
      const low = v & -v;
      yield k * 32 + 31 - Math.clz32(low);
      v ^= low;
    }
  }
}

export class WordIndex {
  /** @param {Iterable<[string, number]>} entries word and score; higher scores are better words */
  constructor(entries) {
    const best = new Map();
    for (const [raw, score] of entries) {
      const word = normalizeWord(raw);
      if (!word) continue;
      const s = Number.isFinite(score) ? score : DEFAULT_SCORE;
      if (!(best.get(word) >= s)) best.set(word, s);
    }
    const lengths = new Map();
    for (const [word, score] of best) {
      if (!lengths.has(word.length)) lengths.set(word.length, []);
      lengths.get(word.length).push([word, score]);
    }
    this.size = best.size;
    this.byLen = new Map();
    for (const [len, list] of lengths) {
      list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const n32 = Math.ceil(list.length / 32);
      const bits = Array.from({ length: len * 26 }, () => new Uint32Array(n32));
      list.forEach(([word], k) => {
        for (let p = 0; p < len; p++) bits[p * 26 + word.charCodeAt(p) - 65][k >>> 5] |= 1 << (k & 31);
      });
      const all = new Uint32Array(n32).fill(0xffffffff);
      if (list.length % 32) all[n32 - 1] = (1 << (list.length % 32)) - 1;
      this.byLen.set(len, { words: list.map((e) => e[0]), scores: list.map((e) => e[1]), bits, all });
    }
  }

  /** Bitset of the words that fit `pattern`, or null when none could (no words that long). */
  matches(pattern) {
    const group = this.byLen.get(pattern.length);
    if (!group) return null;
    let out = null;
    for (let p = 0; p < pattern.length; p++) {
      const ch = pattern[p];
      if (ch === '?') continue;
      const c = ch.charCodeAt(0) - 65;
      if (c < 0 || c >= 26) return new Uint32Array(group.all.length);
      const b = group.bits[p * 26 + c];
      if (!out) out = b.slice();
      else for (let k = 0; k < out.length; k++) out[k] &= b[k];
    }
    return out ?? group.all.slice();
  }

  count(pattern) {
    const bits = this.matches(pattern);
    return bits ? popcount(bits) : 0;
  }

  /** The letters (a 26-bit mask) that square `at` takes in the words fitting `pattern`. */
  lettersAt(pattern, at) {
    const bits = this.matches(pattern);
    if (!bits) return 0;
    const { words } = this.byLen.get(pattern.length);
    let mask = 0;
    for (const k of setBits(bits)) {
      mask |= 1 << (words[k].charCodeAt(at) - 65);
      if (mask === 0x3ffffff) break;
    }
    return mask;
  }

  /**
   * Words for an entry, best first.
   * @param {string} pattern  the entry so far
   * @param {Array<{pattern:string, at:number}|null>} cross  per square: the
   *   entry crossing it (its pattern, and this square's place in it); only
   *   blank squares matter
   * @returns {{words: Array<[string, number]>, total: number, loose: number}}
   *   total: how many fit the crossings too; loose: how many fit the entry alone
   */
  suggest(pattern, cross = [], limit = 100) {
    let bits = this.matches(pattern);
    if (!bits) return { words: [], total: 0, loose: 0 };
    const group = this.byLen.get(pattern.length);
    const loose = popcount(bits);
    for (let p = 0; p < pattern.length; p++) {
      const c = cross[p];
      if (pattern[p] !== '?' || !c || c.pattern.length < 2) continue;
      const ok = this.lettersAt(c.pattern, c.at);
      const keep = new Uint32Array(bits.length);
      for (let letter = 0; letter < 26; letter++) {
        if (!(ok & (1 << letter))) continue;
        const b = group.bits[p * 26 + letter];
        for (let k = 0; k < keep.length; k++) keep[k] |= b[k];
      }
      for (let k = 0; k < bits.length; k++) bits[k] &= keep[k];
    }
    const words = [];
    for (const k of setBits(bits)) {
      if (words.length >= limit) break;
      words.push([group.words[k], group.scores[k]]);
    }
    return { words, total: popcount(bits), loose };
  }
}
