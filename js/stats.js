/*
 * stats.js — pure aggregation over solve logs (stats.json `solves` maps).
 * No DOM. Streaks run over consecutive *puzzle dates* (the archive is the
 * timeline, not wall-clock solving days).
 */

import { dateFromId, weekdayOf } from './util.js';

const DAY_MS = 86400000;

function dayNumber(dateStr) {
  return Math.round(Date.parse(dateStr + 'T00:00:00Z') / DAY_MS);
}

/**
 * @param {Object<string, {seconds:number, completed_at:string, clean?:boolean}>} solves
 * @returns {{
 *   solvedCount:number, cleanCount:number,
 *   currentStreak:number, longestStreak:number,
 *   avgSeconds:number|null, bestSeconds:number|null, bestPuzzleId:string|null,
 *   byWeekday: Array<{dow:number, count:number, avgSeconds:number|null,
 *                     bestSeconds:number|null, bestPuzzleId:string|null}>,
 * }}
 */
export function computeUserStats(solves = {}) {
  const entries = Object.entries(solves);
  const stats = {
    solvedCount: entries.length,
    cleanCount: entries.filter(([, e]) => e.clean).length,
    currentStreak: 0,
    longestStreak: 0,
    avgSeconds: null,
    bestSeconds: null,
    bestPuzzleId: null,
    byWeekday: Array.from({ length: 7 }, (_, dow) => ({
      dow,
      count: 0,
      avgSeconds: null,
      bestSeconds: null,
      bestPuzzleId: null,
    })),
  };

  if (entries.length) {
    let totalSeconds = 0;
    const wkTotals = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
    for (const [id, e] of entries) {
      totalSeconds += e.seconds;
      if (stats.bestSeconds === null || e.seconds < stats.bestSeconds) {
        stats.bestSeconds = e.seconds;
        stats.bestPuzzleId = id;
      }
      const date = dateFromId(id);
      if (date) {
        const dow = weekdayOf(date);
        const wk = stats.byWeekday[dow];
        wkTotals[dow].sum += e.seconds;
        wkTotals[dow].count++;
        wk.count++;
        if (wk.bestSeconds === null || e.seconds < wk.bestSeconds) {
          wk.bestSeconds = e.seconds;
          wk.bestPuzzleId = id;
        }
      }
    }
    stats.avgSeconds = Math.round(totalSeconds / entries.length);
    for (let dow = 0; dow < 7; dow++) {
      const { sum, count } = wkTotals[dow];
      if (count) stats.byWeekday[dow].avgSeconds = Math.round(sum / count);
    }
  }

  // streaks over consecutive puzzle dates
  const days = [...new Set(entries.map(([id]) => dateFromId(id)).filter(Boolean))]
    .map(dayNumber)
    .sort((a, b) => a - b);
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > stats.longestStreak) stats.longestStreak = run;
    if (i === days.length - 1) stats.currentStreak = run;
  }

  return stats;
}

/**
 * Head-to-head across users' solve logs.
 * @param {Array<{user:string, solves:Object}>} users
 * @returns {{
 *   common: Array<{puzzleId:string, date:string|null,
 *                  times:Object<string,number>, winner:string|null}>,
 *   wins: Object<string, number>,   // fastest on a shared puzzle (ties: none)
 * }}
 */
export function compareUsers(users) {
  const wins = Object.fromEntries(users.map((u) => [u.user, 0]));
  const idCounts = new Map();
  for (const u of users) {
    for (const id of Object.keys(u.solves || {})) {
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    }
  }
  const common = [];
  for (const [id, count] of idCounts) {
    if (count < 2) continue;
    const times = {};
    for (const u of users) {
      const e = u.solves?.[id];
      if (e) times[u.user] = e.seconds;
    }
    const min = Math.min(...Object.values(times));
    const fastest = Object.entries(times).filter(([, s]) => s === min);
    const winner = fastest.length === 1 ? fastest[0][0] : null; // tie: no winner
    if (winner) wins[winner]++;
    common.push({ puzzleId: id, date: dateFromId(id), times, winner });
  }
  common.sort((a, b) => {
    if (!!a.date !== !!b.date) return a.date ? -1 : 1; // dated before special
    return (b.date || b.puzzleId).localeCompare(a.date || a.puzzleId);
  });
  return { common, wins };
}
