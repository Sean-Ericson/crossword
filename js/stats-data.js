/*
 * stats-data.js — turns GET /api/stats-all and puzzles/index.json into one
 * row per solve with everything the stats page slices and correlates by.
 * Pure (no DOM); dates are read in the browser's time zone.
 */

import { parsePuzzleId, weekdayOf, themeTitle } from './util.js';
import { median } from './stats-math.js';

const DAY_MS = 86400000;

/**
 * "Rafael Musa / Will Shortz" -> constructors + editor. With no " / " the
 * one name did both (the Mini's editor constructs most of them).
 */
export function splitAuthor(author) {
  const [makers, editor] = String(author || '').split(/\s+\/\s+/);
  const constructors = (makers || '')
    .split(/\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { constructors, editor: editor?.trim() || constructors[0] || null };
}

/** One puzzle's facts, from its index.json entry (or just its id). */
export function puzzleInfo(id, entry = null) {
  const { type, date } = parsePuzzleId(id);
  const { constructors, editor } = splitAuthor(entry?.author);
  const width = entry?.width ?? null;
  const height = entry?.height ?? null;
  const title = themeTitle(entry?.title ?? '');
  return {
    id,
    type,
    date,
    weekday: date ? weekdayOf(date) : null,
    title,
    titled: !!title,
    constructors,
    editor,
    width,
    height,
    size: width && height ? width * height : null,
    blocks: entry?.blocks ?? null,
    squares: width && height && entry?.blocks != null ? width * height - entry.blocks : null,
    words: entry?.words ?? null,
    avgLen: entry?.avg_len ?? null,
    rebus: entry?.rebus ?? null,
    circles: entry?.circles ?? null,
  };
}

/** "2026-09-25" for a timestamp, in local time. */
export function localDate(ms) {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayNumber = (dateStr) => Math.round(Date.parse(dateStr + 'T00:00:00Z') / DAY_MS);

/**
 * @param {object} payload GET /api/stats-all
 * @param {Array<object>} index puzzles/index.json `puzzles`
 * @returns {{solves: object[], coop: object[], unfinished: object[], puzzles: Map<string, object>}}
 */
export function buildDataset(payload, index = []) {
  const entries = new Map(index.map((e) => [e.id, e]));
  const puzzles = new Map();
  const info = (id) => {
    if (!puzzles.has(id)) puzzles.set(id, puzzleInfo(id, entries.get(id)));
    return puzzles.get(id);
  };
  for (const e of index) info(e.id);
  const summaries = payload.summaries ?? {};

  const base = (puzzleId, seconds, completedAt, flags, openedAt, solveId) => {
    const p = info(puzzleId);
    const done = Date.parse(completedAt);
    const opened = openedAt ? Date.parse(openedAt) : null;
    const when = new Date(done);
    const solvedOn = Number.isFinite(done) ? localDate(done) : null;
    let summary = solveId ? (summaries[solveId] ?? null) : null;
    // a summary of a later attempt (reset and solved again) doesn't describe this time
    if (summary && Math.abs(summary.ms / 1000 - seconds) > 2) summary = null;
    return {
      puzzleId,
      puzzle: p,
      type: p.type,
      date: p.date,
      weekday: p.weekday,
      seconds,
      logT: seconds > 0 ? Math.log(seconds) : null,
      completedAt: done,
      solvedOn,
      solveHour: Number.isFinite(done) ? when.getHours() : null,
      solveWeekday: Number.isFinite(done) ? when.getDay() : null,
      lagDays: p.date && solvedOn ? dayNumber(solvedOn) - dayNumber(p.date) : null,
      dayOf: !!(p.date && solvedOn === p.date),
      openedAt: opened,
      spanMs: opened != null && Number.isFinite(done) ? Math.max(0, done - opened) : null,
      clean: !!(flags & 1),
      check: !!(flags & 2),
      reveal: !!(flags & 4),
      solveId: solveId ?? null,
      summary,
    };
  };

  const solves = [];
  const unfinished = [];
  for (const [user, doc] of Object.entries(payload.users ?? {})) {
    for (const [puzzleId, seconds, completedAt, flags, solveId, openedAt] of doc.solo) {
      solves.push({ user, kind: 'solo', ...base(puzzleId, seconds, completedAt, flags, openedAt, solveId) });
    }
    for (const [puzzleId, pct, elapsed, updatedAt] of doc.unfinished) {
      unfinished.push({ user, puzzleId, puzzle: info(puzzleId), pct, elapsed, updatedAt: Date.parse(updatedAt) });
    }
  }
  const coop = (payload.coop ?? []).map((c) => ({
    kind: 'coop',
    id: c.id,
    members: c.members,
    ...base(c.puzzle_id, c.seconds, c.completed_at, c.flags, c.opened_at, c.id),
  }));

  addRelative(solves);
  return { solves, coop, unfinished, puzzles };
}

/**
 * Each solo solve's time relative to that person's typical time for the
 * same kind of puzzle (type and weekday): 0.8 = 20% faster than usual.
 */
function addRelative(solves) {
  const groups = new Map();
  const key = (s) => `${s.user}|${s.type}|${s.weekday ?? '-'}`;
  for (const s of solves) {
    if (!groups.has(key(s))) groups.set(key(s), []);
    groups.get(key(s)).push(s.seconds);
  }
  const typical = new Map([...groups].map(([k, xs]) => [k, median(xs)]));
  for (const s of solves) {
    const t = typical.get(key(s));
    s.typical = t;
    s.relative = t ? s.seconds / t : null;
  }
}

/** Date-range keys for the filter bar, and how far back each reaches. */
export const RANGES = [
  ['all', 'All time', null],
  ['365', 'Past year', 365],
  ['90', 'Past 90 days', 90],
  ['30', 'Past 30 days', 30],
];

/**
 * @param {object[]} rows solves
 * @param {{type?:string, range?:string, weekdays?:Set<number>|null,
 *          cleanOnly?:boolean, noAssists?:boolean, now?:number}} f
 */
export function applyFilters(rows, { type = null, range = 'all', weekdays = null, cleanOnly = false, noAssists = false, now = Date.now() } = {}) {
  const days = RANGES.find(([k]) => k === range)?.[2] ?? null;
  const since = days ? now - days * DAY_MS : null;
  return rows.filter(
    (s) =>
      (!type || s.type === type) &&
      (since == null || s.completedAt >= since) &&
      (!weekdays || !weekdays.size || (s.weekday != null && weekdays.has(s.weekday))) &&
      (!cleanOnly || s.clean) &&
      (!noAssists || (!s.check && !s.reveal))
  );
}

/**
 * Streaks of consecutive puzzle dates (the archive is the timeline), and of
 * days on which that day's puzzle was solved on the day ("day-of").
 */
export function streaks(rows, { today = localDate(Date.now()) } = {}) {
  const run = (dates, liveFrom) => {
    const days = [...new Set(dates)].map(dayNumber).sort((a, b) => a - b);
    let longest = 0;
    let current = 0;
    let r = 0;
    for (let i = 0; i < days.length; i++) {
      r = i > 0 && days[i] === days[i - 1] + 1 ? r + 1 : 1;
      longest = Math.max(longest, r);
    }
    if (days.length) {
      const last = days[days.length - 1];
      current = liveFrom == null || last >= liveFrom ? r : 0;
    }
    return { longest, current };
  };
  const dated = rows.filter((s) => s.date);
  const byDate = run(dated.map((s) => s.date), null);
  // a day-of streak is still alive if yesterday's puzzle was solved yesterday
  const dayOf = run(dated.filter((s) => s.dayOf).map((s) => s.date), dayNumber(today) - 1);
  return { current: byDate.current, longest: byDate.longest, dayOfCurrent: dayOf.current, dayOfLongest: dayOf.longest };
}

/** Personal records in date order: each solve that beat every earlier one. */
export function recordProgression(rows) {
  const sorted = [...rows].sort((a, b) => a.completedAt - b.completedAt);
  const out = [];
  let best = Infinity;
  for (const s of sorted) {
    if (s.seconds < best) {
      best = s.seconds;
      out.push(s);
    }
  }
  return out;
}

/** Group rows by a key function into a Map, preserving first-seen order. */
export function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** CSV text from rows and [header, getter] columns. */
export function toCsv(rows, columns) {
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(([h]) => cell(h)).join(','), ...rows.map((r) => columns.map(([, get]) => cell(get(r))).join(','))].join('\n');
}
