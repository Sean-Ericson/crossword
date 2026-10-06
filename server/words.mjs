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
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { docToPuz } from '../js/custom-puzzle.js';
import { WordIndex, parseWordList } from '../js/words.js';
import { SITE_DIR } from './config.mjs';

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
