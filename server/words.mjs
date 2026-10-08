/*
 * words.mjs — the word list behind the builder's suggestions (/api/words,
 * js/words.js). It's built from:
 *   - every answer in the archive's puzzles, scored by how often it has
 *     been used (once: 60, then up toward 100);
 *   - the answers of published custom puzzles, the same way;
 *   - `wordList` in server/config.json, if set: a file in the usual
 *     WORD;SCORE format (Spread the Wordlist, Peter Broda's list, a
 *     Crossfire or XWord Info dictionary), with its own scores.
 * A word in more than one keeps its best score. The list builds in the
 * background at startup and again after the daily download and when a
 * puzzle is published; until the first build is done, suggestions are
 * empty.
 *
 * People's own lists (wordlists.html, the word_lists tables) go over it:
 * forUser() gives the list as one person sees it (js/words.js
 * LayeredIndex), built when first wanted and kept for a while. Edits are
 * patched in (wordsChanged); after a big change it's built afresh, which
 * for a list of half a million words takes about a second. A new site
 * list keeps their words and only lays them over it again.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { docToPuz } from '../js/custom-puzzle.js';
import { WordIndex, LayeredIndex, parseWordList } from '../js/words.js';
import { SITE_DIR } from './config.mjs';

// people's views kept at once: at most this many, holding at most this many of their own words
const MAX_VIEWS = 12;
const MAX_VIEW_WORDS = 2_000_000;
// a view takes up to this many changed words as a patch before it's rebuilt
export const MAX_PATCH = 20_000;

const usedScore = (uses) => Math.min(100, Math.round(50 + 10 * Math.log2(1 + uses)));

/** Each answer in a model, rebus squares and all (WordIndex drops what it can't use). */
function answersOf(model) {
  return model.clueOrder.map((w) => w.cells.map((i) => model.cells[i].solution).join(''));
}

export class Words {
  constructor(cfg, { store = null, log = console } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.index = null;
    this.building = null;
    this.again = false;
    this.timer = null;
    this.views = new Map(); // user id -> {base, index, size}; oldest use first
  }

  /** Build (or rebuild) now; resolves when the new list is in use. */
  build() {
    if (this.building) {
      this.again = true; // something changed mid-build: go once more after
      return this.building;
    }
    this.building = this.make()
      .then((index) => {
        this.index = index;
      })
      .catch((err) => this.log.error?.(`word list: ${err.stack || err}`))
      .finally(() => {
        this.building = null;
        if (this.again) {
          this.again = false;
          this.build();
        }
      });
    return this.building;
  }

  /** The list, building it the first time it's wanted (null until it's ready). */
  current() {
    if (!this.index && !this.building) this.build();
    return this.index;
  }

  /**
   * The list as one person sees it: the site's (unless they turned it off)
   * with their own lists that are on over it. null while the site's list
   * is still building.
   */
  forUser(userId) {
    if (!this.store) return this.current();
    const useSite = this.store.wordListPrefs(userId).use_site;
    const base = useSite ? this.current() : null;
    if (useSite && !base) return null;
    let view = this.views.get(userId);
    this.views.delete(userId); // back in at the end: the most recently used
    if (!view) {
      const index = new LayeredIndex(base, this.store.ownWords(userId), { clean: true });
      view = { index, size: index.own.size };
    } else if (view.index.base !== base) {
      view.index = view.index.over(base); // a new site list, or they switched it: their words stay
    }
    this.views.set(userId, view);
    let held = 0;
    for (const v of this.views.values()) held += v.size + v.index.patch.size;
    for (const [id, v] of this.views) {
      if (this.views.size <= MAX_VIEWS && held <= MAX_VIEW_WORDS) break;
      if (id === userId) continue;
      this.views.delete(id);
      held -= v.size + v.index.patch.size;
    }
    return view.index;
  }

  /**
   * Some of someone's words changed (rescored, added, removed, or a list
   * switched on or off). Up to MAX_PATCH words in all are patched into
   * their view; past that, or for null ("too many to say"), it's built
   * afresh when next wanted.
   * @param {string[]|null} words  plain words
   */
  wordsChanged(userId, words) {
    const view = this.views.get(userId);
    if (!view) return;
    if (!words || view.index.patch.size + words.length > MAX_PATCH) {
      this.views.delete(userId);
      return;
    }
    if (words.length) view.index = view.index.withChanges(this.store.ownScores(userId, words));
  }

  /** A puzzle came in or was published: rebuild in a little while. */
  rebuildSoon(ms = 5000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.build(), ms);
    this.timer.unref?.();
  }

  async make() {
    const started = Date.now();
    const uses = new Map();
    const count = (answer) => uses.set(answer, (uses.get(answer) ?? 0) + 1);
    let puzzles = 0;
    let files = [];
    try {
      files = (await readdir(this.cfg.puzzlesDir)).filter((f) => f.endsWith('.puz'));
    } catch {
      /* no archive (yet) */
    }
    for (const f of files) {
      try {
        const bytes = await readFile(path.join(this.cfg.puzzlesDir, f));
        const puz = parsePuz(bytes);
        if (puz.scrambled) continue;
        answersOf(new PuzzleModel(puz)).forEach(count);
        puzzles++;
      } catch {
        /* a file that doesn't parse adds nothing */
      }
    }
    for (const doc of this.store?.publishedDocs() ?? []) {
      answersOf(new PuzzleModel(docToPuz(doc))).forEach(count);
      puzzles++;
    }
    const entries = [...uses].map(([answer, n]) => [answer, usedScore(n)]);
    let listed = 0;
    if (this.cfg.wordList) {
      const file = path.resolve(SITE_DIR, this.cfg.wordList);
      try {
        const list = parseWordList(await readFile(file, 'utf8'));
        listed = list.length;
        entries.push(...list);
      } catch (err) {
        this.log.error?.(`word list: can't read ${file}: ${err.message}`);
      }
    }
    const index = new WordIndex(entries);
    this.log.info?.(
      `word list: ${index.size} words from ${puzzles} puzzles${listed ? ` and ${listed} listed` : ''} (${Date.now() - started} ms)`
    );
    return index;
  }
}
