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
 *
 * A person's own word lists (wordlists.html) sit over the site's index as a
 * LayeredIndex: a word in their lists takes their score instead of the
 * site's, and a score of 0 hides it. Each layer is a WordIndex plus, per
 * length, a bitset of its words a higher layer replaces, so the site's
 * index is built once and shared by everyone. Their words are a snapshot
 * (which can be big: a whole downloaded list) plus a small patch of the
 * words they've changed since, so an edit doesn't rebuild the snapshot.
 */

export const MAX_LEN = 25;
export const MAX_SCORE = 100;
export const DEFAULT_SCORE = 50;

/** A score for a person's own list: a whole number from 0 (hidden) to 100. */
export function clampScore(score, fallback = DEFAULT_SCORE) {
  const n = Number(score);
  return Number.isFinite(n) ? Math.min(MAX_SCORE, Math.max(0, Math.round(n))) : fallback;
}

/** "Ice-cream" -> "ICECREAM"; null for anything that isn't 2+ plain letters. */
export function normalizeWord(raw) {
  if (typeof raw === 'string' && /^[A-Z]{2,25}$/.test(raw)) return raw; // already plain
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
 * A comma or a tab before a number works too (a spreadsheet's CSV). Lines
 * starting with # are comments.
 * @returns {Array<[string, number]>}
 */
export function parseWordList(text, { defaultScore = DEFAULT_SCORE } = {}) {
  const out = [];
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    let word = line;
    let score;
    let m;
    if (line.includes(';')) [word, score] = line.split(';');
    else if ((m = /^(.+?)\s*[,\t]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line))) [, word, score] = m;
    const n = Number(score);
    out.push([word, score != null && score.trim() !== '' && Number.isFinite(n) ? n : defaultScore]);
  }
  return out;
}

/** One word in two of a person's lists: a 0 wins (it hides the word), otherwise the best score. */
export function keepScore(was, score) {
  return was === undefined ? score : was === 0 || score === 0 ? 0 : Math.max(was, score);
}

/**
 * Entries for a person's list: words made plain, scores 0-100, one entry
 * per word (see keepScore).
 * @param {Iterable<[string, number]>} entries
 * @returns {{words: Map<string, number>, skipped: number}} skipped: entries that aren't words
 */
export function cleanEntries(entries) {
  const words = new Map();
  let skipped = 0;
  for (const [raw, score] of entries) {
    const word = normalizeWord(raw);
    if (!word) {
      skipped++;
      continue;
    }
    words.set(word, keepScore(words.get(word), clampScore(score)));
  }
  return { words, skipped };
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

/**
 * The words of one layer that fit `pattern`: a bitset over the layer's
 * index (fresh, so callers may change it), or null when it has no words
 * that long.
 */
function layerMatches({ index, drop }, pattern) {
  const bits = index.matches(pattern);
  const gone = bits && drop?.get(pattern.length);
  if (gone) for (let k = 0; k < bits.length; k++) bits[k] &= ~gone[k];
  return bits;
}

function countIn(layers, pattern) {
  let n = 0;
  for (const layer of layers) {
    const bits = layerMatches(layer, pattern);
    if (bits) n += popcount(bits);
  }
  return n;
}

/** The letters (a 26-bit mask) square `at` takes in the layers' words fitting `pattern`. */
function lettersIn(layers, pattern, at) {
  let mask = 0;
  for (const layer of layers) {
    const bits = layerMatches(layer, pattern);
    if (!bits) continue;
    const { words } = layer.index.byLen.get(pattern.length);
    for (const k of setBits(bits)) {
      mask |= 1 << (words[k].charCodeAt(at) - 65);
      if (mask === 0x3ffffff) return mask;
    }
  }
  return mask;
}

/** See WordIndex.suggest; each layer's words come best first, so they merge in order. */
function suggestIn(layers, pattern, cross, limit) {
  const sets = layers.map((layer) => layerMatches(layer, pattern));
  if (sets.every((bits) => !bits)) return { words: [], total: 0, loose: 0 };
  const loose = sets.reduce((n, bits) => n + (bits ? popcount(bits) : 0), 0);
  for (let p = 0; p < pattern.length; p++) {
    const c = cross[p];
    if (pattern[p] !== '?' || !c || c.pattern.length < 2) continue;
    const ok = lettersIn(layers, c.pattern, c.at);
    sets.forEach((bits, j) => {
      if (!bits) return;
      const group = layers[j].index.byLen.get(pattern.length);
      const keep = new Uint32Array(bits.length);
      for (let letter = 0; letter < 26; letter++) {
        if (!(ok & (1 << letter))) continue;
        const b = group.bits[p * 26 + letter];
        for (let k = 0; k < keep.length; k++) keep[k] |= b[k];
      }
      for (let k = 0; k < bits.length; k++) bits[k] &= keep[k];
    });
  }
  const heads = [];
  sets.forEach((bits, j) => {
    if (!bits) return;
    const group = layers[j].index.byLen.get(pattern.length);
    const it = setBits(bits);
    const head = { it, group, k: it.next() };
    if (!head.k.done) heads.push(head);
  });
  const better = (a, b) => {
    const sa = a.group.scores[a.k.value];
    const sb = b.group.scores[b.k.value];
    return sa !== sb ? sa > sb : a.group.words[a.k.value] < b.group.words[b.k.value];
  };
  const words = [];
  while (heads.length && words.length < limit) {
    let best = 0;
    for (let h = 1; h < heads.length; h++) if (better(heads[h], heads[best])) best = h;
    const head = heads[best];
    words.push([head.group.words[head.k.value], head.group.scores[head.k.value]]);
    head.k = head.it.next();
    if (head.k.done) heads.splice(best, 1);
  }
  return { words, total: sets.reduce((n, bits) => n + (bits ? popcount(bits) : 0), 0), loose };
}

/** The score a layer gives a word, or undefined when it doesn't have it (or a higher layer replaced it). */
function scoreIn({ index, drop }, word) {
  const k = index.positionOf(word);
  if (k == null) return undefined;
  const gone = drop?.get(word.length);
  if (gone && gone[k >>> 5] & (1 << (k & 31))) return undefined;
  return index.byLen.get(word.length).scores[k];
}

export class WordIndex {
  /**
   * @param {Iterable<[string, number]>} entries word and score; higher scores are better words
   * @param {{clean?: boolean}} opts  clean: the entries are already plain
   *   words, each once, with numeric scores (skips sorting that out)
   */
  constructor(entries, { clean = false } = {}) {
    let best = entries;
    if (!clean) {
      best = new Map();
      for (const [raw, score] of entries) {
        const word = normalizeWord(raw);
        if (!word) continue;
        const s = Number.isFinite(score) ? score : DEFAULT_SCORE;
        if (!(best.get(word) >= s)) best.set(word, s);
      }
    }
    const lengths = new Map();
    this.size = 0;
    for (const [word, score] of best) {
      if (!lengths.has(word.length)) lengths.set(word.length, []);
      lengths.get(word.length).push([word, score]);
      this.size++;
    }
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
    this.layers = [{ index: this, drop: null }];
    this.positions = null; // word -> place in its length's list, built when first wanted
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
    return countIn(this.layers, pattern);
  }

  /** The letters (a 26-bit mask) that square `at` takes in the words fitting `pattern`. */
  lettersAt(pattern, at) {
    return lettersIn(this.layers, pattern, at);
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
    return suggestIn(this.layers, pattern, cross, limit);
  }

  /** Where a (plain) word sits in its length's list, or null. */
  positionOf(word) {
    if (!this.positions) {
      this.positions = new Map();
      for (const { words } of this.byLen.values()) words.forEach((w, k) => this.positions.set(w, k));
    }
    return this.positions.get(word) ?? null;
  }

  /** A word's score, or null when it isn't in the list. */
  scoreOf(word) {
    const w = normalizeWord(word);
    return (w && scoreIn(this.layers[0], w)) ?? null;
  }
}

/** Per length, a bitset of `index`'s words among `words` (added to `masks`). */
function maskOf(index, words, masks = new Map()) {
  for (const word of words) {
    const k = index.positionOf(word);
    if (k == null) continue;
    let bits = masks.get(word.length);
    if (!bits) masks.set(word.length, (bits = new Uint32Array(index.byLen.get(word.length).all.length)));
    bits[k >>> 5] |= 1 << (k & 31);
  }
  return masks;
}

const countMasks = (masks) => {
  let n = 0;
  for (const bits of masks.values()) n += popcount(bits);
  return n;
};

/**
 * The word list as one person sees it: their own words over the site's
 * index (or alone, when they've turned the site's off). Answers the same
 * questions as a WordIndex.
 *
 * Layers, top first: `fresh`, the words changed since the snapshot (from
 * `patch`); `own`, the snapshot's scored words, less the changed ones; and
 * the site's `base`, less every word of theirs (scored or hidden).
 */
export class LayeredIndex {
  /**
   * @param {WordIndex|null} base  the site's index, shared, never changed
   * @param {Iterable<[string, number]>} own  the words of their lists that
   *   are on, with their scores (0 hides a word; see keepScore for a word
   *   listed twice)
   * @param {{clean?: boolean}} opts  clean: `own` is already a Map of plain
   *   words to whole-number scores (from the database)
   */
  constructor(base, own, { clean = false } = {}) {
    const words = clean ? own : cleanEntries(own).words;
    const scored = [];
    this.hidden = new Set();
    for (const [word, s] of words) {
      if (s > 0) scored.push([word, s]);
      else this.hidden.add(word);
    }
    this.own = new WordIndex(scored, { clean: true });
    this.patch = new Map(); // word -> their score now (0 hides it), or null: in none of their lists now
    stack(this, base, null);
  }

  /**
   * The same view after some of their words changed, sharing the big
   * indexes: `changes` maps each word to their score now, or null when no
   * list of theirs (that's on) has it any more.
   * @param {Map<string, number|null>} changes
   */
  withChanges(changes) {
    const view = Object.create(LayeredIndex.prototype);
    Object.assign(view, { own: this.own, hidden: this.hidden, patch: new Map([...this.patch, ...changes]) });
    return stack(view, this.base, this.siteDrop);
  }

  /** The same words over another site index (a rebuilt one, or null to leave it out). */
  over(base) {
    const view = Object.create(LayeredIndex.prototype);
    Object.assign(view, { own: this.own, hidden: this.hidden, patch: this.patch });
    return stack(view, base, base === this.base ? this.siteDrop : null);
  }

  count(pattern) {
    return countIn(this.layers, pattern);
  }

  lettersAt(pattern, at) {
    return lettersIn(this.layers, pattern, at);
  }

  suggest(pattern, cross = [], limit = 100) {
    return suggestIn(this.layers, pattern, cross, limit);
  }

  /** The score suggestions use for a word, or null when they leave it out. */
  scoreOf(word) {
    const w = normalizeWord(word);
    if (!w) return null;
    for (const layer of this.layers) {
      const s = scoreIn(layer, w);
      if (s !== undefined) return s;
    }
    return null;
  }
}

/**
 * Lay a view's words over `base`. siteDrop: the site's words the snapshot
 * replaces, when it's already worked out for this base (it's the slow
 * part: a lookup per word of theirs).
 */
function stack(view, base, siteDrop) {
  const { own, hidden, patch } = view;
  view.base = base;
  view.fresh = new WordIndex([...patch].filter(([, s]) => s > 0), { clean: true });
  const ownDrop = maskOf(own, patch.keys());
  view.layers = [
    { index: view.fresh, drop: null },
    { index: own, drop: ownDrop },
  ];
  view.size = view.fresh.size + own.size - countMasks(ownDrop);
  view.siteDrop = null;
  if (base) {
    if (!siteDrop) {
      siteDrop = maskOf(base, hidden);
      for (const { words } of own.byLen.values()) maskOf(base, words, siteDrop);
    }
    view.siteDrop = siteDrop;
    // a changed word gives way on the site's list while it's in a list of theirs
    const drop = new Map([...siteDrop].map(([len, bits]) => [len, bits.slice()]));
    for (const [word, s] of patch) {
      const k = base.positionOf(word);
      if (k == null) continue;
      let bits = drop.get(word.length);
      if (!bits) drop.set(word.length, (bits = new Uint32Array(base.byLen.get(word.length).all.length)));
      if (s == null) bits[k >>> 5] &= ~(1 << (k & 31));
      else bits[k >>> 5] |= 1 << (k & 31);
    }
    view.layers.push({ index: base, drop });
    view.size += base.size - countMasks(drop);
  }
  return view;
}
