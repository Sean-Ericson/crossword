/*
 * custom-puzzle.js — puzzles people make on the site ("custom-…" ids).
 * Pure: shared by the browser (builder, player, breakdown) and the server
 * (Puzzles.model, the build room, the API).
 *
 * A puzzle is a JSON doc (v1):
 *   width, height  MIN_SIZE..MAX_SIZE squares
 *   grid           a string per square, like a progress record's fill
 *                  (state.js): '.' black, '' empty, else the answer there
 *                  (more than one character is a rebus square)
 *   circles        0/1 per square
 *   clues          {key: text}. The key is the direction and the entry's
 *                  first square ('A0', 'D4'), not its number, so a clue stays
 *                  with its entry when blocks change elsewhere. A clue whose
 *                  entry is gone stays in the working copy (undoing the block
 *                  brings it back) and is left out of the published copy.
 *   title, byline, notes
 *   symmetry       'rotational' | 'mirror' | 'none': which squares a block
 *                  toggles together in the builder
 *
 * docToPuz(doc) returns exactly what parsePuz() returns for a .puz file, so
 * `new PuzzleModel(docToPuz(doc))` works wherever a downloaded puzzle does.
 *
 * Edits (the builder, through the build room) are changes {k, v}:
 *   cell:<i>   '' | '.' | 1-12 of A-Z 0-9      circle:<i>   0 | 1
 *   clue:A<i>, clue:D<i>   text               title, byline, notes, symmetry
 * applyChange() is the one place they're checked and applied, on both
 * sides of the wire.
 */

import { PuzzleModel } from './model.js';
import { CUSTOM_ID_RE } from './util.js';

export { CUSTOM_ID_RE };
export const CUSTOM_PREFIX = 'custom-';
export const MIN_SIZE = 3;
export const MAX_SIZE = 25;
export const SYMMETRIES = ['rotational', 'mirror', 'none'];
export const LIMITS = { clue: 500, title: 120, byline: 120, notes: 2000 };

const CELL_RE = /^[A-Z0-9]{1,12}$/;
const CLUE_KEY_RE = /^[AD]\d{1,4}$/;
// inline formatting a clue may carry (js/util.js setRichText renders it)
const MARKUP_RE = /<\/?(?:i|em|b|strong|sub|sup|u|br)\b[^>]*>/i;
const IMG_RE = /<img\b[^>]*>/gi;

export const isCustomId = (id) => CUSTOM_ID_RE.test(String(id ?? ''));

/** A blank grid. */
export function emptyDoc({ width, height, symmetry = 'rotational', title = '', byline = '' }) {
  const n = width * height;
  return {
    v: 1,
    width,
    height,
    grid: new Array(n).fill(''),
    circles: new Array(n).fill(0),
    clues: {},
    title: String(title).slice(0, LIMITS.title),
    byline: String(byline).slice(0, LIMITS.byline),
    notes: '',
    symmetry: SYMMETRIES.includes(symmetry) ? symmetry : 'rotational',
  };
}

export const isValidSize = (width, height) =>
  [width, height].every((x) => Number.isInteger(x) && x >= MIN_SIZE && x <= MAX_SIZE);

/** A square's value, normalized, or null if it isn't one. */
export function cellValue(v) {
  if (v === '' || v === '.') return v;
  if (typeof v !== 'string') return null;
  const up = v.toUpperCase();
  return CELL_RE.test(up) ? up : null;
}

const text = (v, max) => (typeof v === 'string' ? v.replace(IMG_RE, '').slice(0, max) : null);

/**
 * Apply one change to `doc` in place. Returns the change as applied: an
 * invalid value, or a black/white flip while `shapeLocked`, leaves the
 * square as it was and returns its real value (so the editor that sent it
 * puts it back). Returns null for a key that doesn't exist.
 * @returns {{k:string, v:any}|null}
 */
export function applyChange(doc, change, { shapeLocked = false } = {}) {
  const k = String(change?.k ?? '');
  const v = change?.v;
  const n = doc.width * doc.height;
  let m;
  if ((m = /^cell:(\d+)$/.exec(k))) {
    const i = Number(m[1]);
    if (i >= n) return null;
    let value = cellValue(v) ?? doc.grid[i];
    if (shapeLocked && (value === '.') !== (doc.grid[i] === '.')) value = doc.grid[i];
    doc.grid[i] = value;
    return { k, v: value };
  }
  if ((m = /^circle:(\d+)$/.exec(k))) {
    const i = Number(m[1]);
    if (i >= n) return null;
    doc.circles[i] = v === 1 || v === true ? 1 : 0;
    return { k, v: doc.circles[i] };
  }
  if ((m = /^clue:([AD])(\d+)$/.exec(k))) {
    if (Number(m[2]) >= n) return null;
    const key = m[1] + m[2];
    const value = text(v, LIMITS.clue) ?? doc.clues[key] ?? '';
    if (value === '') delete doc.clues[key];
    else doc.clues[key] = value;
    return { k, v: value };
  }
  if (k === 'title' || k === 'byline' || k === 'notes') {
    doc[k] = text(v, LIMITS[k]) ?? doc[k];
    return { k, v: doc[k] };
  }
  if (k === 'symmetry') {
    if (SYMMETRIES.includes(v)) doc.symmetry = v;
    return { k, v: doc.symmetry };
  }
  return null;
}

/** The value `doc` holds for a change key (undefined for unknown keys). */
export function valueAt(doc, k) {
  let m;
  if ((m = /^cell:(\d+)$/.exec(k))) return doc.grid[Number(m[1])];
  if ((m = /^circle:(\d+)$/.exec(k))) return doc.circles[Number(m[1])];
  if ((m = /^clue:([AD]\d+)$/.exec(k))) return doc.clues[m[1]] ?? '';
  if (k === 'title' || k === 'byline' || k === 'notes' || k === 'symmetry') return doc[k];
  return undefined;
}

/**
 * A clean doc from untrusted JSON (an upload, an API body). Anything that
 * isn't valid is dropped; a size that isn't allowed throws.
 */
export function normalizeDoc(raw) {
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (!isValidSize(width, height)) {
    throw new Error(`Grids are ${MIN_SIZE}×${MIN_SIZE} to ${MAX_SIZE}×${MAX_SIZE} squares.`);
  }
  const doc = emptyDoc({ width, height });
  const n = width * height;
  const grid = Array.isArray(raw.grid) ? raw.grid : [];
  const circles = Array.isArray(raw.circles) ? raw.circles : [];
  for (let i = 0; i < n; i++) {
    if (i < grid.length) applyChange(doc, { k: `cell:${i}`, v: grid[i] });
    if (i < circles.length) applyChange(doc, { k: `circle:${i}`, v: circles[i] });
  }
  const clues = raw.clues && typeof raw.clues === 'object' ? Object.entries(raw.clues) : [];
  for (const [key, value] of clues.slice(0, 2 * n)) {
    if (CLUE_KEY_RE.test(key)) applyChange(doc, { k: `clue:${key}`, v: value });
  }
  for (const k of ['title', 'byline', 'notes', 'symmetry']) {
    if (raw[k] != null) applyChange(doc, { k, v: raw[k] });
  }
  return doc;
}

export const clueKey = (word) => word.dir + word.cells[0];

/** Plain text of a clue that may carry inline formatting. */
export const plainClue = (raw) => (MARKUP_RE.test(raw) ? raw.replace(/<[^>]*>/g, '') : raw);

/** The parsePuz() shape for a doc (see js/puz.js). */
export function docToPuz(doc) {
  const n = doc.width * doc.height;
  let solution = '';
  let fill = '';
  const rebusSquares = {};
  const circled = [];
  for (let i = 0; i < n; i++) {
    const v = doc.grid[i] ?? '';
    if (v === '.') {
      solution += '.';
      fill += '.';
      continue;
    }
    solution += v ? v[0] : ' '; // ' ': not filled in yet (drafts only)
    fill += '-';
    if (v.length > 1) rebusSquares[i] = v;
    if (doc.circles?.[i]) circled.push(i);
  }
  const base = {
    width: doc.width,
    height: doc.height,
    version: 'custom',
    scrambled: false,
    diagramless: false,
    title: (doc.title ?? '').trim(),
    author: (doc.byline ?? '').trim(),
    copyright: '',
    notes: (doc.notes ?? '').trim(),
    solution,
    fill,
    clues: [],
    cluesFormatted: null,
    circled,
    rebus: null,
    rebusSquares,
  };
  // number the grid once to learn the clue order (across before down at a square)
  const numbering = new PuzzleModel(base);
  const clues = new Array(numbering.clueOrder.length).fill('');
  const formatted = {};
  for (const word of numbering.clueOrder) {
    const raw = (doc.clues?.[clueKey(word)] ?? '').trim();
    clues[word.clueIndex] = plainClue(raw);
    if (clues[word.clueIndex] !== raw) formatted[word.clueIndex] = raw;
  }
  return { ...base, clues, cluesFormatted: Object.keys(formatted).length ? formatted : null };
}

export const modelOf = (doc) => new PuzzleModel(docToPuz(doc));

/** What solvers get: trimmed text, and only the clues of entries that exist. */
export function publishedCopy(doc) {
  const model = modelOf(doc);
  const clues = {};
  for (const word of model.clueOrder) clues[clueKey(word)] = (doc.clues[clueKey(word)] ?? '').trim();
  return {
    ...structuredClone(doc),
    clues,
    title: doc.title.trim(),
    byline: doc.byline.trim(),
    notes: doc.notes.trim(),
  };
}

/** The square that mirrors `i` under `symmetry` (itself when there's none). */
export function partnerOf(i, width, height, symmetry) {
  if (symmetry === 'rotational') return width * height - 1 - i;
  if (symmetry === 'mirror') return Math.floor(i / width) * width + (width - 1 - (i % width));
  return i;
}

/** The most standard symmetry the grid's blocks have. */
export function detectSymmetry(grid, width, height) {
  for (const symmetry of ['rotational', 'mirror']) {
    if (grid.every((v, i) => (v === '.') === (grid[partnerOf(i, width, height, symmetry)] === '.'))) return symmetry;
  }
  return 'none';
}

/** Same size and same black squares: a solve of one fits the other. */
export function sameShape(a, b) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.grid.length === b.grid.length &&
    a.grid.every((v, i) => (v === '.') === (b.grid[i] === '.'))
  );
}

/**
 * A draft from a parsed .puz (js/puz.js), for uploads. Letters a square
 * can't hold come in blank.
 */
export function docFromPuz(puz) {
  if (puz.scrambled) throw new Error('That file’s answers are locked (scrambled), so it can’t be imported.');
  if (puz.diagramless) throw new Error('Diagramless puzzles aren’t supported.');
  if (!isValidSize(puz.width, puz.height)) {
    throw new Error(`That puzzle is ${puz.width}×${puz.height}; the builder takes ${MIN_SIZE}×${MIN_SIZE} to ${MAX_SIZE}×${MAX_SIZE}.`);
  }
  const model = new PuzzleModel(puz);
  const doc = emptyDoc({ width: puz.width, height: puz.height });
  for (const cell of model.cells) {
    applyChange(doc, { k: `cell:${cell.index}`, v: cell.isBlack ? '.' : cell.solution });
    if (cell.circled && !cell.isBlack) doc.circles[cell.index] = 1;
  }
  for (const word of model.clueOrder) {
    applyChange(doc, { k: `clue:${clueKey(word)}`, v: word.clueText });
  }
  for (const [k, v] of [['title', puz.title], ['byline', puz.author], ['notes', puz.notes]]) {
    applyChange(doc, { k, v: String(v ?? '').trim() });
  }
  doc.symmetry = detectSymmetry(doc.grid, doc.width, doc.height);
  return doc;
}

/** Grid numbers the stats page correlates times with (tools/build_index.py). */
export function puzzleFeatures(model) {
  const lengths = model.clueOrder.map((w) => w.cells.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  return {
    blocks: model.cells.filter((c) => c.isBlack).length,
    words: lengths.length,
    avg_len: lengths.length ? Math.round((total / lengths.length) * 100) / 100 : 0,
    rebus: Object.keys(model.puz.rebusSquares ?? {}).length,
    circles: model.cells.filter((c) => c.circled && !c.isBlack).length,
  };
}

export const entryName = (word) => `${word.num}-${word.dir === 'A' ? 'Across' : 'Down'}`;

/** The answer an entry holds so far, or null while it has blank squares. */
export function answerOf(doc, word) {
  const parts = word.cells.map((i) => doc.grid[i]);
  return parts.every(Boolean) ? parts.join('') : null;
}

/** "1-Across, 5-Down and 3 more" */
function some(names, max = 4) {
  if (names.length <= max) return names.join(names.length === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ' and $1');
  return `${names.slice(0, max - 1).join(', ')} and ${names.length - max + 1} more`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What stands between a doc and publishing it (blockers), and what's merely
 * unusual (warnings). Each: {code, message, cells, keys?}.
 */
export function problems(doc, model = modelOf(doc)) {
  const blockers = [];
  const warnings = [];
  const n = doc.width * doc.height;
  const white = [];
  for (let i = 0; i < n; i++) if (doc.grid[i] !== '.') white.push(i);

  if (!white.length) {
    blockers.push({ code: 'no-squares', message: 'The grid has no white squares.', cells: [] });
    return { blockers, warnings };
  }
  const orphan = white.filter((i) => !model.cells[i].across && !model.cells[i].down);
  if (orphan.length) {
    blockers.push({
      code: 'orphan',
      message: `${plural(orphan.length, 'square')} ${orphan.length === 1 ? 'isn’t' : 'aren’t'} in any entry (a square needs a white neighbor across or down).`,
      cells: orphan,
    });
  }
  const empty = white.filter((i) => doc.grid[i] === '');
  if (empty.length) {
    blockers.push({ code: 'empty', message: `${plural(empty.length, 'square')} still ${empty.length === 1 ? 'needs' : 'need'} a letter.`, cells: empty });
  }
  const unclued = model.clueOrder.filter((w) => !(doc.clues[clueKey(w)] ?? '').trim());
  if (unclued.length) {
    blockers.push({
      code: 'unclued',
      message: `${unclued.length === 1 ? 'An entry needs' : `${unclued.length} entries need`} a clue: ${some(unclued.map(entryName))}.`,
      cells: unclued.flatMap((w) => w.cells),
      keys: unclued.map(clueKey),
    });
  }

  const short = model.clueOrder.filter((w) => w.cells.length === 2);
  if (short.length) {
    warnings.push({ code: 'short', message: `Two-letter entries: ${some(short.map(entryName))}.`, cells: short.flatMap((w) => w.cells) });
  }
  const unchecked = white.filter((i) => !model.cells[i].across !== !model.cells[i].down);
  if (unchecked.length) {
    warnings.push({
      code: 'unchecked',
      message: `${plural(unchecked.length, 'square')} ${unchecked.length === 1 ? 'is' : 'are'} only in one entry (unchecked).`,
      cells: unchecked,
    });
  }
  const byAnswer = new Map();
  for (const w of model.clueOrder) {
    const answer = answerOf(doc, w);
    if (!answer) continue;
    if (!byAnswer.has(answer)) byAnswer.set(answer, []);
    byAnswer.get(answer).push(w);
  }
  for (const [answer, words] of byAnswer) {
    if (words.length > 1) {
      warnings.push({ code: 'duplicate', message: `${answer} is used ${words.length} times (${some(words.map(entryName))}).`, cells: words.flatMap((w) => w.cells) });
    }
  }
  if (doc.symmetry !== 'none') {
    const off = [];
    for (let i = 0; i < n; i++) {
      if ((doc.grid[i] === '.') !== (doc.grid[partnerOf(i, doc.width, doc.height, doc.symmetry)] === '.')) off.push(i);
    }
    if (off.length) {
      warnings.push({ code: 'asymmetric', message: `The black squares aren’t ${doc.symmetry === 'mirror' ? 'mirror' : 'rotationally'} symmetric.`, cells: off });
    }
  }
  const areas = regions(doc);
  if (areas.length > 1) {
    areas.sort((a, b) => b.length - a.length);
    warnings.push({
      code: 'split',
      message: `The white squares are split into ${areas.length} separate areas.`,
      cells: areas.slice(1).flat(),
    });
  }
  return { blockers, warnings };
}

/** Groups of white squares that touch across or down. */
function regions(doc) {
  const { width: w, height: h, grid } = doc;
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || grid[start] === '.') continue;
    const area = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      area.push(i);
      const r = Math.floor(i / w);
      const c = i % w;
      for (const [rr, cc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const j = rr * w + cc;
        if (!seen[j] && grid[j] !== '.') {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push(area);
  }
  return out;
}
