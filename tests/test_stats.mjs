/* Unit tests for js/stats.js aggregation. */
import assert from 'node:assert/strict';
import { computeUserStats, compareUsers } from '../js/stats.js';

const S = (seconds, clean = false) => ({
  seconds,
  completed_at: '2026-07-23T12:00:00Z',
  clean,
});

test('stats: empty solves', () => {
  const st = computeUserStats({});
  assert.equal(st.solvedCount, 0);
  assert.equal(st.currentStreak, 0);
  assert.equal(st.longestStreak, 0);
  assert.equal(st.avgSeconds, null);
  assert.equal(st.byWeekday.length, 7);
});

test('stats: totals, clean count, best/avg', () => {
  const st = computeUserStats({
    '2026-07-20': S(300, true), // Monday
    '2026-07-13': S(100, false), // Monday
    '2026-07-14': S(500, true), // Tuesday
    special1: S(50, false), // non-dated: counts, no weekday/streak
  });
  assert.equal(st.solvedCount, 4);
  assert.equal(st.cleanCount, 2);
  assert.equal(st.bestSeconds, 50);
  assert.equal(st.bestPuzzleId, 'special1');
  assert.equal(st.avgSeconds, Math.round(950 / 4));
  const monday = st.byWeekday[1];
  assert.equal(monday.count, 2);
  assert.equal(monday.avgSeconds, 200);
  assert.equal(monday.bestSeconds, 100);
  assert.equal(monday.bestPuzzleId, '2026-07-13');
  assert.equal(st.byWeekday[0].count, 0); // no Sundays
});

test('stats: streaks with gaps; current = run at latest date', () => {
  const st = computeUserStats({
    '2026-07-01': S(1),
    '2026-07-02': S(1),
    '2026-07-03': S(1),
    '2026-07-05': S(1),
  });
  assert.equal(st.longestStreak, 3);
  assert.equal(st.currentStreak, 1);
});

test('stats: streak across a month boundary', () => {
  const st = computeUserStats({
    '2026-06-29': S(1),
    '2026-06-30': S(1),
    '2026-07-01': S(1),
    '2026-07-02': S(1),
  });
  assert.equal(st.longestStreak, 4);
  assert.equal(st.currentStreak, 4);
});

test('stats: single solve = streak of 1', () => {
  const st = computeUserStats({ '2026-07-20': S(60) });
  assert.equal(st.longestStreak, 1);
  assert.equal(st.currentStreak, 1);
});

test('compare: common puzzles, winners, ties', () => {
  const { common, wins } = compareUsers([
    { user: 'a', solves: { p1: S(100), '2026-07-20': S(200), only: S(1) } },
    { user: 'b', solves: { p1: S(90), '2026-07-20': S(200) } },
  ]);
  assert.equal(common.length, 2);
  const p1 = common.find((c) => c.puzzleId === 'p1');
  assert.equal(p1.winner, 'b');
  const tie = common.find((c) => c.puzzleId === '2026-07-20');
  assert.equal(tie.winner, null);
  assert.deepEqual(wins, { a: 0, b: 1 });
  // dated ids sort before non-dated, newest first
  assert.equal(common[0].puzzleId, '2026-07-20');
});

test('compare: three users, puzzle shared by two still counts', () => {
  const { common } = compareUsers([
    { user: 'a', solves: { p1: S(100) } },
    { user: 'b', solves: { p1: S(50) } },
    { user: 'c', solves: {} },
  ]);
  assert.equal(common.length, 1);
  assert.deepEqual(Object.keys(common[0].times).sort(), ['a', 'b']);
});
