/*
 * solve-analysis.js — what a solve's event log says about how it went.
 * Pure (no DOM). The server runs summarize() when a solve completes; the
 * browser uses analyzeSolve() for the puzzle breakdown page and replays.
 *
 * The log (server/rooms.mjs Room.log, table solve_events) has one row per
 * change, in order: {seq, t, at, user, kind, cell, value, marks, dir}.
 *   t     the solve's own clock in ms (paused time doesn't count)
 *   at    wall-clock ms
 *   user  account name, or null (the clock itself, or a deleted account)
 *   kind  'c'  a cell changed: cell, value = its fill, marks, and dir = the
 *              typist's direction ('A'/'D') when the client said
 *         'a'  an assist: value 'check:letter|word|puzzle',
 *              'reveal:letter|word|puzzle' or 'autocheck:on|off'; cell, dir
 *              are where the cursor was
 *         'w'  the person's cursor moved to another entry: value 'A17'
 *              (logged only while they're solving)
 *         'p'  the person started (value '1') or stopped ('0') solving
 *         's'  the shared clock started ('start') or stopped ('stop')
 *         'b'  baseline: the grid changed outside the log (progress from
 *              before logging began, or from the old site). value is
 *              JSON {fill, marks}. Times before it are unknown
 *         'r'  reset: the grid and the clock start over
 *         'd'  done: the server marked the solve complete
 *
 * A solve that was reset after it was solved has several attempts. The one
 * analyzed is the first that finished, matching the solo stats log, where
 * the first completion is the one that counts.
 */

import { MARK_PENCIL, MARK_WRONG, MARK_REVEALED } from './engine.js';

/** Bump when summarize() changes; the server recomputes older summaries. */
export const ANALYSIS_VERSION = 1;

const CURVE_POINTS = 51; // progress sampled at every 2% of the solve's time

function emptyGrid(model) {
  return {
    fill: model.cells.map((c) => (c.isBlack ? '.' : '')),
    marks: new Array(model.cells.length).fill(0),
  };
}

function parseBaseline(value, model) {
  try {
    const g = JSON.parse(value);
    if (Array.isArray(g.fill) && g.fill.length === model.cells.length) {
      return {
        fill: g.fill.map(String),
        marks: Array.isArray(g.marks) && g.marks.length === model.cells.length ? g.marks.map(Number) : new Array(model.cells.length).fill(0),
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Apply one event to a {fill, marks} grid in place (replays use this too).
 * @returns {boolean} whether the grid changed
 */
export function applyEvent(model, grid, e) {
  if (e.kind === 'c') {
    const i = e.cell;
    if (!Number.isInteger(i) || i < 0 || i >= grid.fill.length || model.cells[i].isBlack) return false;
    const fill = e.value ?? '';
    const marks = e.marks ?? 0;
    if (grid.fill[i] === fill && grid.marks[i] === marks) return false;
    grid.fill[i] = fill;
    grid.marks[i] = marks;
    return true;
  }
  if (e.kind === 'r') {
    const fresh = emptyGrid(model);
    grid.fill.splice(0, grid.fill.length, ...fresh.fill);
    grid.marks.splice(0, grid.marks.length, ...fresh.marks);
    return true;
  }
  if (e.kind === 'b') {
    const g = parseBaseline(e.value, model);
    if (!g) return false;
    grid.fill.splice(0, grid.fill.length, ...g.fill);
    grid.marks.splice(0, grid.marks.length, ...g.marks);
    return true;
  }
  return false;
}

/** The grid as the whole log leaves it. */
export function replayGrid(model, events) {
  const grid = emptyGrid(model);
  for (const e of events) applyEvent(model, grid, e);
  return grid;
}

/**
 * The events of the attempt that counts: from the last reset before the
 * first 'd' through that 'd'; with no 'd', the latest attempt.
 */
export function attemptOf(events) {
  let start = 0;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.kind === 'r') start = k + 1;
    else if (e.kind === 'd') return events.slice(start, k + 1);
  }
  return events.slice(start);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Everything the log says about one solve.
 * @param {import('./model.js').PuzzleModel} model
 * @param {Array<object>} events the whole log (the attempt is picked here)
 */
export function analyzeSolve(model, events) {
  const evs = attemptOf(events);
  const n = model.cells.length;
  const scrambled = !!model.puz?.scrambled;
  const open = model.cells.filter((c) => !c.isBlack).map((c) => c.index);
  const sol = model.cells.map((c) => (c.isBlack ? '' : String(c.solution).toUpperCase()));
  const isRight = (i, v) => !scrambled && v !== '' && (v === sol[i] || (v.length === 1 && v === sol[i][0]));

  const grid = emptyGrid(model);
  const cells = model.cells.map((c) =>
    c.isBlack
      ? null
      : {
          first: null, // t of the first letter typed here
          firstBy: null,
          since: null, // t since which it has held a correct letter
          by: null, // who put the current letter there
          changes: 0,
          wrong: 0, // wrong letters typed here
          pencil: 0,
          checked: false, // a check flagged it wrong at some point
          revealed: false,
          errBy: null, // an uncorrected wrong letter: who typed it, when
          errAt: null,
        }
  );
  const words = new Map(
    model.clueOrder.map((w) => [
      w.id,
      { id: w.id, dir: w.dir, num: w.num, cells: w.cells, first: null, correct: null, own: 0, cross: 0, dwell: new Map() },
    ])
  );

  const people = new Map();
  const person = (name) => {
    const key = name ?? '';
    if (!people.has(key)) {
      people.set(key, {
        name: name ?? null,
        letters: 0,
        wrong: 0,
        erased: 0,
        overwrites: 0,
        fixedOwn: 0,
        fixedOthers: 0,
        across: 0,
        down: 0,
        pencil: 0,
        final: 0,
        dwell: 0,
      });
    }
    return people.get(key);
  };

  let partial = false;
  let filled = 0;
  let right = 0;
  let fullSince = null; // t the grid last became full
  let firstEntry = null;
  let lastProgress = null; // t of the latest letter (the wait for the first isn't a stall)
  let stall = { ms: 0, at: 0 };
  let sittings = 0;
  let firstAt = null;
  let lastT = 0;
  let doneT = null;
  let doneAt = null;
  const curve = [[0, 0, 0]];
  const assists = [];
  const confusions = {};
  const fixes = {}; // 'fixer>author' -> count
  const fixLatency = [];
  const focus = new Map(); // user -> {word, since}

  const closeFocus = (user, t) => {
    const f = focus.get(user);
    if (!f) return;
    focus.delete(user);
    const w = words.get(f.word);
    const ms = Math.max(0, t - f.since);
    if (w) w.dwell.set(user, (w.dwell.get(user) ?? 0) + ms);
    person(user).dwell += ms;
  };
  const closeAllFocus = (t) => {
    for (const user of [...focus.keys()]) closeFocus(user, t);
  };

  const recount = () => {
    filled = 0;
    right = 0;
    for (const i of open) {
      if (grid.fill[i] !== '') filled++;
      if (isRight(i, grid.fill[i])) right++;
    }
  };

  for (const e of evs) {
    firstAt ??= e.at;
    if (e.t > lastT) lastT = e.t;
    switch (e.kind) {
      case 'b': {
        const g = parseBaseline(e.value, model);
        if (!g) break;
        for (const i of open) {
          grid.fill[i] = g.fill[i];
          grid.marks[i] = g.marks[i];
          const c = cells[i];
          c.since = isRight(i, g.fill[i]) ? e.t : null;
          c.by = null;
          if (g.fill[i] !== '') partial = true;
        }
        recount();
        fullSince = filled === open.length ? e.t : null;
        curve.push([e.t, filled, right]);
        break;
      }
      case 'c': {
        const i = e.cell;
        const c = cells[i];
        if (!c) break;
        const prev = grid.fill[i];
        const prevMarks = grid.marks[i];
        const v = e.value ?? '';
        const m = e.marks ?? 0;
        grid.fill[i] = v;
        grid.marks[i] = m;
        if (m & MARK_WRONG && !(prevMarks & MARK_WRONG) && v === prev) c.checked = true;
        if (v === prev) break;

        c.changes++;
        const wasOk = isRight(i, prev);
        const nowOk = isRight(i, v);
        if (prev === '') filled++;
        if (v === '') filled--;
        if (wasOk !== nowOk) right += nowOk ? 1 : -1;
        const who = person(e.user);

        if (m & MARK_REVEALED) {
          c.revealed = true;
        } else if (v === '') {
          who.erased++;
        } else {
          // a letter typed (or pasted as a rebus)
          who.letters++;
          if (prev !== '') who.overwrites++;
          if (m & MARK_PENCIL) {
            who.pencil++;
            c.pencil++;
          }
          if (e.dir === 'A') who.across++;
          else if (e.dir === 'D') who.down++;
          if (c.first == null) {
            c.first = e.t;
            c.firstBy = e.user;
          }
          firstEntry ??= { t: e.t, cell: i, dir: e.dir ?? null, user: e.user };
          for (const w of [model.cells[i].across, model.cells[i].down]) {
            if (!w) continue;
            const ws = words.get(w.id);
            ws.first ??= e.t;
            if (e.dir === w.dir) ws.own++;
            else if (e.dir) ws.cross++;
          }
          if (!scrambled && !nowOk) {
            who.wrong++;
            c.wrong++;
            c.errBy = e.user;
            c.errAt ??= e.t;
            if (v.length === 1 && sol[i].length === 1) {
              const key = `${v}>${sol[i]}`;
              confusions[key] = (confusions[key] ?? 0) + 1;
            }
          }
          if (nowOk && c.errAt != null) {
            fixLatency.push(e.t - c.errAt);
            if (c.errBy === e.user) who.fixedOwn++;
            else {
              who.fixedOthers++;
              const key = `${e.user ?? ''}>${c.errBy ?? ''}`;
              fixes[key] = (fixes[key] ?? 0) + 1;
            }
            c.errBy = null;
            c.errAt = null;
          }
          if (lastProgress != null && e.t - lastProgress > stall.ms) stall = { ms: e.t - lastProgress, at: lastProgress };
          lastProgress = e.t;
        }
        c.by = v === '' ? null : e.user;
        if (nowOk && !wasOk) c.since = e.t;
        else if (!nowOk) c.since = null;
        for (const w of [model.cells[i].across, model.cells[i].down]) {
          if (!w) continue;
          const ws = words.get(w.id);
          if (ws.correct == null && w.cells.every((k) => isRight(k, grid.fill[k]))) ws.correct = e.t;
        }
        if (filled === open.length) fullSince ??= e.t;
        else fullSince = null;
        curve.push([e.t, filled, right]);
        break;
      }
      case 'a': {
        const [kind, scope] = String(e.value ?? '').split(':');
        assists.push({ t: e.t, user: e.user, kind, scope, cell: e.cell ?? null });
        break;
      }
      case 'w':
        closeFocus(e.user, e.t);
        if (e.value) focus.set(e.user, { word: e.value, since: e.t });
        break;
      case 'p':
        if (e.value === '0') closeFocus(e.user, e.t);
        break;
      case 's':
        if (e.value === 'start') sittings++;
        else closeAllFocus(e.t);
        break;
      case 'd':
        doneT = e.t;
        doneAt = e.at;
        break;
      default:
        break;
    }
  }

  const endT = doneT ?? lastT;
  closeAllFocus(endT);
  if (doneT != null && lastProgress != null && doneT - lastProgress > stall.ms) {
    stall = { ms: doneT - lastProgress, at: lastProgress };
  }

  // who holds each finished square, and when each entry was locked in
  for (const i of open) {
    const c = cells[i];
    if (c.by != null && isRight(i, grid.fill[i]) && !c.revealed) person(c.by).final++;
  }
  const wordList = model.clueOrder.map((w) => {
    const ws = words.get(w.id);
    const cs = w.cells.map((k) => cells[k]);
    const allRight = w.cells.every((k) => isRight(k, grid.fill[k]));
    const holders = new Map();
    for (const c of cs) if (c.by != null) holders.set(c.by, (holders.get(c.by) ?? 0) + 1);
    const by = [...holders].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    let dwell = 0;
    for (const ms of ws.dwell.values()) dwell += ms;
    return {
      id: w.id,
      dir: w.dir,
      num: w.num,
      len: w.cells.length,
      answer: w.cells.map((k) => sol[k]).join(''),
      clue: w.clueText,
      first: ws.first, // first letter typed in it
      correct: ws.correct, // first time every square was right
      locked: allRight ? Math.max(...cs.map((c) => c.since ?? 0)) : null, // right from then to the end
      dwell, // ms anyone spent on it
      dwellBy: Object.fromEntries(ws.dwell),
      errors: cs.reduce((s, c) => s + c.wrong, 0),
      revealed: cs.some((c) => c.revealed),
      checked: cs.some((c) => c.checked),
      own: ws.own, // letters typed going this entry's direction
      cross: ws.cross, // ...and going the crossing direction
      by,
    };
  });
  const order = [...wordList].filter((w) => w.correct != null).sort((a, b) => a.correct - b.correct);
  order.forEach((w, k) => (w.rank = k + 1));

  // quadrants, for "where did they start and how did they move"
  const midR = model.height / 2;
  const midC = model.width / 2;
  const quadrants = ['NW', 'NE', 'SW', 'SE'].map((q) => {
    const idx = open.filter((i) => {
      const { row, col } = model.cells[i];
      return (q[0] === 'N' ? row < midR : row >= midR) && (q[1] === 'W' ? col < midC : col >= midC);
    });
    const firsts = idx.map((i) => cells[i].first).filter((t) => t != null);
    const done = idx.every((i) => isRight(i, grid.fill[i])) ? Math.max(0, ...idx.map((i) => cells[i].since ?? 0)) : null;
    return { q, cells: idx.length, first: firsts.length ? Math.min(...firsts) : null, done };
  });

  const scopeCounts = (kind) => {
    const out = { letter: 0, word: 0, puzzle: 0 };
    for (const a of assists) if (a.kind === kind && a.scope in out) out[a.scope]++;
    return out;
  };

  return {
    v: ANALYSIS_VERSION,
    partial,
    scrambled,
    done: doneT != null,
    ms: endT,
    wallMs: doneAt != null && firstAt != null ? doneAt - firstAt : null,
    cellCount: open.length,
    firstEntry,
    stall,
    fullAt: fullSince,
    finishMs: doneT != null && fullSince != null ? doneT - fullSince : null,
    sittings,
    curve, // [t, filled, correct] after every change
    cells,
    words: wordList,
    people: [...people.values()].filter((p) => p.name != null || p.letters || p.erased),
    assists,
    checks: scopeCounts('check'),
    reveals: scopeCounts('reveal'),
    autocheck: assists.some((a) => a.kind === 'autocheck' && a.scope === 'on'),
    confusions,
    fixes,
    fixLatency,
    quadrants,
    grid,
  };
}

/** Progress at every 2% of the solve's time, as whole percents of squares. */
export function sampleCurve(curve, endMs, cellCount, points = CURVE_POINTS) {
  const filled = [];
  const correct = [];
  let k = 0;
  let last = [0, 0, 0];
  for (let p = 0; p < points; p++) {
    const t = (endMs * p) / (points - 1);
    while (k < curve.length && curve[k][0] <= t) last = curve[k++];
    filled.push(cellCount ? Math.round((last[1] * 100) / cellCount) : 0);
    correct.push(cellCount ? Math.round((last[2] * 100) / cellCount) : 0);
  }
  return { filled, correct };
}

/**
 * What gets stored per solve: `scalars` feed the stats page's aggregates
 * (small, sent for every solve), `detail` the per-entry and per-letter
 * views (fetched only when needed). Times are ms on the solve's clock.
 */
export function summarize(model, events) {
  const a = analyzeSolve(model, events);
  const sum = (key) => a.people.reduce((s, p) => s + p[key], 0);
  const start = a.firstEntry;
  const startWord = start ? model.wordAt(start.cell, start.dir ?? 'A') ?? model.wordAt(start.cell, start.dir === 'D' ? 'A' : 'D') : null;
  const scalars = {
    v: a.v,
    partial: a.partial,
    scrambled: a.scrambled,
    done: a.done,
    ms: a.ms,
    wall_ms: a.wallMs,
    cells: a.cellCount,
    words: model.clueOrder.length,
    w: model.width,
    h: model.height,
    first_ms: start?.t ?? null,
    start_cell: start?.cell ?? null,
    start_word: startWord?.id ?? null,
    stall_ms: a.stall.ms,
    stall_at: a.stall.at,
    full_ms: a.fullAt,
    finish_ms: a.finishMs,
    sittings: a.sittings,
    letters: sum('letters'),
    wrong: sum('wrong'),
    erased: sum('erased'),
    overwrites: sum('overwrites'),
    fixed: sum('fixedOwn') + sum('fixedOthers'),
    fix_ms: median(a.fixLatency),
    across: sum('across'),
    down: sum('down'),
    pencil: sum('pencil'),
    checks: a.checks,
    reveals: a.reveals,
    autocheck: a.autocheck,
    revealed_cells: a.cells.filter((c) => c?.revealed).length,
    by: Object.fromEntries(
      a.people
        .filter((p) => p.name != null)
        .map((p) => [
          p.name,
          { letters: p.letters, wrong: p.wrong, final: p.final, fixed_own: p.fixedOwn, fixed_others: p.fixedOthers, dwell: p.dwell },
        ])
    ),
  };
  const detail = {
    curve: sampleCurve(a.curve, a.ms, a.cellCount),
    // [id, len, first, correct, locked, dwell, errors, own, cross, rank]
    words: a.words.map((w) => [w.id, w.len, w.first, w.correct, w.locked, w.dwell, w.errors, w.own, w.cross, w.rank ?? null]),
    // entries that went wrong: the answer is here so "most missed" needs no puzzle files
    missed: a.words
      .filter((w) => w.errors || w.revealed || w.checked)
      .map((w) => [w.id, w.answer, w.errors, w.revealed ? 1 : 0, w.checked ? 1 : 0]),
    confusions: a.confusions,
    fixes: a.fixes,
    quadrants: a.quadrants.map((q) => [q.q, q.first, q.done]),
  };
  return { v: a.v, scalars, detail };
}
