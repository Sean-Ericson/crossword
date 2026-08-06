/*
 * state.js — per-puzzle progress records: creation, localStorage
 * persistence, status derivation, and the cross-device merge policy.
 *
 * Record schema (schema 1):
 *   fill:  string per cell; "" empty, "." black, else the entry
 *          (multi-char = rebus)
 *   marks: bitflags per cell (see MARK_* in engine.js):
 *          0x01 pencil, 0x02 checked-wrong, 0x04 revealed,
 *          0x08 autocheck-confirmed
 */

import { isoNow } from './util.js';
import { settingsKey } from './settings.js';

export function progressKey(user, puzzleId) {
  return `xw:${user}:progress:${puzzleId}`;
}

export function newProgress(model, puzzleId, user) {
  return {
    schema: 1,
    puzzle_id: puzzleId,
    user,
    fill: model.cells.map((c) => (c.isBlack ? '.' : '')),
    marks: new Array(model.cells.length).fill(0),
    elapsed: 0,
    completed: false,
    solved_at: null,
    clean: true,
    used_check: false,
    used_reveal: false,
    autocheck: false,
    // Pristine records carry no timestamp so that any real remote record
    // wins the merge on a fresh device; set on first actual edit.
    updated_at: '',
  };
}

/** True if the record shape plausibly matches this puzzle. */
export function recordFitsModel(record, model) {
  return (
    record &&
    record.schema === 1 &&
    Array.isArray(record.fill) &&
    record.fill.length === model.cells.length &&
    Array.isArray(record.marks) &&
    record.marks.length === model.cells.length
  );
}

export function loadLocal(user, puzzleId) {
  try {
    const raw = localStorage.getItem(progressKey(user, puzzleId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLocal(record) {
  try {
    localStorage.setItem(
      progressKey(record.user, record.puzzle_id),
      JSON.stringify(record)
    );
    return true;
  } catch {
    return false; // quota/private mode: play on, in memory only
  }
}

export function hasAnyFill(record) {
  return record.fill.some((v) => v !== '' && v !== '.');
}

/** 'unsolved' | 'in-progress' | 'solved' | 'solved-clean' */
export function statusOf(record) {
  if (!record) return 'unsolved';
  if (record.completed) return record.clean ? 'solved-clean' : 'solved';
  return hasAnyFill(record) || record.elapsed > 0 ? 'in-progress' : 'unsolved';
}

// ---------- per-user solve log (stats.json mirror) ----------

export function statsKey(user) {
  return `xw:${user}:stats`;
}

export function newStatsDoc(user) {
  return { schema: 1, user, updated_at: isoNow(), solves: {} };
}

export function loadStatsLocal(user) {
  try {
    const raw = localStorage.getItem(statsKey(user));
    const doc = raw ? JSON.parse(raw) : null;
    return doc && doc.schema === 1 && doc.solves ? doc : newStatsDoc(user);
  } catch {
    return newStatsDoc(user);
  }
}

export function saveStatsLocal(doc) {
  try {
    localStorage.setItem(statsKey(doc.user), JSON.stringify(doc));
  } catch {
    /* quota/private mode */
  }
}

/** Build the stats entry for a completed progress record. */
export function solveEntryFrom(record) {
  return {
    seconds: record.elapsed,
    completed_at: record.solved_at || isoNow(),
    clean: !!record.clean,
    used_check: !!record.used_check,
    used_reveal: !!record.used_reveal,
  };
}

/**
 * Union-merge two stats docs. On a shared puzzle id the entry with the
 * earlier completed_at wins (the first genuine solve is canonical).
 */
export function mergeStats(a, b) {
  if (!a) return b;
  if (!b) return a;
  const merged = { schema: 1, user: a.user || b.user, updated_at: isoNow(), solves: {} };
  const ids = new Set([...Object.keys(a.solves || {}), ...Object.keys(b.solves || {})]);
  for (const id of ids) {
    const ea = a.solves?.[id];
    const eb = b.solves?.[id];
    if (ea && eb) {
      merged.solves[id] =
        (ea.completed_at || '9999') <= (eb.completed_at || '9999') ? ea : eb;
    } else {
      merged.solves[id] = ea || eb;
    }
  }
  return merged;
}

/** Record a solve into the local mirror; returns the updated doc. */
export function addSolveLocal(user, puzzleId, entry) {
  const doc = loadStatsLocal(user);
  if (!doc.solves[puzzleId]) {
    doc.solves[puzzleId] = entry;
    doc.updated_at = isoNow();
    saveStatsLocal(doc);
  }
  return doc;
}

/**
 * Cross-device merge: a completed record wins outright; otherwise the newer
 * `updated_at` wins, except elapsed time is never lost (max of both) and
 * assist usage is OR-ed. Returns one of the two inputs when possible so
 * callers can test identity to see which side won.
 */
export function mergeProgress(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.completed !== b.completed) return a.completed ? a : b;
  const winner = (a.updated_at || '') >= (b.updated_at || '') ? a : b;
  if (winner.completed) return winner;
  const elapsed = Math.max(a.elapsed || 0, b.elapsed || 0);
  const usedCheck = !!(a.used_check || b.used_check);
  const usedReveal = !!(a.used_reveal || b.used_reveal);
  if (
    elapsed === (winner.elapsed || 0) &&
    usedCheck === !!winner.used_check &&
    usedReveal === !!winner.used_reveal
  ) {
    return winner; // nothing from the loser survives; keep identity
  }
  // keep winner's grid; carry over max elapsed and OR-ed assist flags
  return {
    ...winner,
    elapsed,
    used_check: usedCheck,
    used_reveal: usedReveal,
    clean: !usedCheck && !usedReveal,
  };
}

// ---------- moving local data between profiles ----------

/** Puzzle ids this user has a local progress record for. */
export function listProgressIds(user) {
  const prefix = `xw:${user}:progress:`;
  const ids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
  } catch {
    /* no storage available */
  }
  return ids;
}

/** What a profile has stored locally — drives the migration prompt. */
export function localDataSummary(user) {
  const ids = listProgressIds(user);
  const solves = Object.keys(loadStatsLocal(user).solves || {}).length;
  const started = ids.filter((id) => {
    const record = loadLocal(user, id);
    return record && !record.completed && (hasAnyFill(record) || record.elapsed > 0);
  }).length;
  return { puzzles: ids.length, solves, started, any: ids.length > 0 || solves > 0 };
}

/**
 * Move one profile's local progress and stats onto another (e.g. adopting
 * what you solved as "guest" when you first name yourself). Records that
 * exist on both sides go through mergeProgress / mergeStats, so nothing is
 * lost or double-counted. The source is cleared afterwards by default, so
 * the same solves can't later be claimed by a second profile too.
 */
export function migrateUserData(fromUser, toUser, { clearSource = true } = {}) {
  const result = { puzzles: 0, solves: 0 };
  if (!fromUser || !toUser || fromUser === toUser) return result;

  for (const id of listProgressIds(fromUser)) {
    const source = loadLocal(fromUser, id);
    if (!source) continue;
    const merged = mergeProgress({ ...source, user: toUser }, loadLocal(toUser, id));
    saveLocal({ ...merged, user: toUser, puzzle_id: id });
    result.puzzles++;
  }

  const mergedStats = mergeStats(loadStatsLocal(fromUser), loadStatsLocal(toUser));
  mergedStats.user = toUser;
  saveStatsLocal(mergedStats);
  result.solves = Object.keys(mergedStats.solves || {}).length;

  // carry settings over only if the destination hasn't set its own
  try {
    const sourceSettings = localStorage.getItem(settingsKey(fromUser));
    if (sourceSettings && !localStorage.getItem(settingsKey(toUser))) {
      localStorage.setItem(settingsKey(toUser), sourceSettings);
    }
  } catch {
    /* ignore */
  }

  if (clearSource) deleteUserData(fromUser);

  return result;
}

/**
 * Erase everything a profile stores on this device. Does not touch the
 * data repo — remote copies are deleted on GitHub if they aren't wanted.
 */
export function deleteUserData(user) {
  let removed = 0;
  try {
    for (const id of listProgressIds(user)) {
      localStorage.removeItem(progressKey(user, id));
      removed++;
    }
    localStorage.removeItem(statsKey(user));
    localStorage.removeItem(settingsKey(user));
    // any leftover bookkeeping for this profile (e.g. sync registration);
    // collect first, since removing shifts the key indexes
    const prefix = `xw:${user}:`;
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* no storage available */
  }
  return removed;
}
