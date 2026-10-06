/* Unit tests for js/stats-data.js (the per-solve dataset) and
 * js/stats-model.js (skill, difficulty, ratings). */
import assert from 'node:assert/strict';
import { buildDataset, splitAuthor, applyFilters, streaks, recordProgression, toCsv, puzzleInfo } from '../js/stats-data.js';
import { fitAdditive, predict, elo, bradleyTerry, pairwise, coopSynergy, constructorEffects, rankCounts } from '../js/stats-model.js';
import { mulberry32 } from '../js/stats-math.js';

test('data: authors split into constructors and editor', () => {
  assert.deepEqual(splitAuthor('Rafael Musa / Will Shortz'), { constructors: ['Rafael Musa'], editor: 'Will Shortz' });
  assert.deepEqual(splitAuthor('Aaron Gee and Avery Gee Katz / Ian Livengood'), {
    constructors: ['Aaron Gee', 'Avery Gee Katz'],
    editor: 'Ian Livengood',
  });
  assert.deepEqual(splitAuthor('A, B and C / E').constructors, ['A', 'B', 'C']);
  assert.deepEqual(splitAuthor('Joel Fagliano'), { constructors: ['Joel Fagliano'], editor: 'Joel Fagliano' });
  assert.deepEqual(splitAuthor(''), { constructors: [], editor: null });
});

const payload = {
  users: {
    sean: {
      solo: [
        ['2026-07-20', 300, '2026-07-20T15:00:00Z', 1, 's1', '2026-07-20T14:50:00Z'], // Monday, day-of, clean
        ['2026-07-21', 400, '2026-07-23T15:00:00Z', 2, null, null], // Tuesday, 2 days late, checked
        ['2026-07-13', 600, '2026-07-19T15:00:00Z', 4, null, null], // Monday, revealed
      ],
      unfinished: [['2026-07-22', 40, 120, '2026-07-23T15:00:00Z']],
    },
    devon: { solo: [['2026-07-20', 200, '2026-07-20T16:00:00Z', 1, 's2', null]], unfinished: [] },
  },
  coop: [{ id: 'c1', puzzle_id: '2026-07-20', members: ['sean', 'devon'], seconds: 150, completed_at: '2026-07-21T01:00:00Z', opened_at: null, flags: 1 }],
  summaries: { s1: { ms: 300_400, letters: 80 }, s2: { ms: 999_000 } },
};
const index = [{ id: '2026-07-20', type: 'daily', date: '2026-07-20', title: 'NY Times, Monday, July 20, 2026', author: 'Jo Doe / Will Shortz', width: 15, height: 15, blocks: 38, words: 78, avg_len: 4.9, rebus: 0, circles: 0 }];

test('data: dataset rows carry features, relatives and summaries', () => {
  const ds = buildDataset(payload, index);
  assert.equal(ds.solves.length, 4);
  const mon = ds.solves.find((s) => s.user === 'sean' && s.puzzleId === '2026-07-20');
  assert.equal(mon.weekday, 1);
  assert.equal(mon.clean, true);
  assert.equal(mon.puzzle.words, 78);
  assert.equal(mon.puzzle.squares, 225 - 38);
  assert.deepEqual(mon.puzzle.constructors, ['Jo Doe']);
  assert.equal(mon.spanMs, 10 * 60_000);
  assert.equal(mon.summary.letters, 80);
  assert.equal(mon.relative, 300 / 450, 'Monday median of 300 and 600');
  const late = ds.solves.find((s) => s.puzzleId === '2026-07-21');
  assert.equal(late.check, true);
  assert.equal(late.clean, false);
  assert.equal(ds.solves.find((s) => s.puzzleId === '2026-07-13').reveal, true);
  assert.equal(ds.solves.find((s) => s.user === 'devon').summary, null, 'a summary of a different attempt is dropped');
  assert.equal(ds.unfinished[0].pct, 40);
  assert.equal(ds.coop[0].members.length, 2);
  assert.equal(puzzleInfo('mega2025').type, 'special');
});

test('data: filters, streaks, records, csv', () => {
  const ds = buildDataset(payload, index);
  const sean = ds.solves.filter((s) => s.user === 'sean');
  assert.equal(applyFilters(sean, { cleanOnly: true }).length, 1);
  assert.equal(applyFilters(sean, { noAssists: true }).length, 1);
  assert.equal(applyFilters(sean, { weekdays: new Set([2]) }).length, 1);
  assert.equal(applyFilters(sean, { range: '30', now: Date.parse('2026-08-10T00:00:00Z') }).length, 3);
  assert.equal(applyFilters(sean, { range: '30', now: Date.parse('2026-08-21T00:00:00Z') }).length, 1);
  const st = streaks(sean, { today: '2026-07-21' });
  assert.equal(st.longest, 2, 'the 20th and 21st');
  assert.equal(st.current, 2);
  assert.equal(recordProgression(sean).map((s) => s.seconds).join(), '600,300');
  assert.equal(toCsv([{ a: 'x,y', b: 2 }], [['A', (r) => r.a], ['B', (r) => r.b]]), 'A,B\n"x,y",2');
});

/** Synthetic solves from known skills and difficulties. */
function synthetic({ users, puzzles, seed = 1, noise = 0.08, coverage = 0.8 }) {
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const rows = [];
  puzzles.forEach((p, k) => {
    for (const [user, skill] of Object.entries(users)) {
      if (rand() > coverage) continue;
      const y = 6 + p.weekdayEffect + p.difficulty + skill + noise * gauss();
      rows.push({ user, puzzleId: p.id, weekday: p.weekday, seconds: Math.exp(y), completedAt: k * 1000 + rand() * 10 });
    }
  });
  return rows;
}

const PUZZLES = Array.from({ length: 60 }, (_, k) => ({
  id: `p${k}`,
  weekday: k % 7,
  weekdayEffect: [0.9, 0, 0.2, 0.4, 0.6, 0.8, 1.0][k % 7],
  difficulty: ((k * 37) % 11) / 20 - 0.25,
}));

test('model: the additive fit recovers skills and difficulties', () => {
  const users = { sean: 0, devon: -0.3, kam: 0.25 };
  const rows = synthetic({ users, puzzles: PUZZLES });
  const fit = fitAdditive(rows);
  // skills are centred, so compare differences
  const diff = (u, v) => fit.user.get(u) - fit.user.get(v);
  assert.ok(Math.abs(diff('devon', 'sean') - -0.3) < 0.06, `devon-sean ${diff('devon', 'sean')}`);
  assert.ok(Math.abs(diff('kam', 'sean') - 0.25) < 0.06, `kam-sean ${diff('kam', 'sean')}`);
  // the hardest puzzle by the model is among the truly hard ones
  const hardest = [...fit.puzzle].sort((a, b) => b[1] - a[1])[0][0];
  assert.ok(PUZZLES.find((p) => p.id === hardest).difficulty >= 0.2);
  assert.ok(fit.sigma < 0.15);
  assert.ok(fit.userSe('sean') > 0);
  const pred = predict(fit, 'devon', { id: 'new', weekday: 1, constructors: [] });
  assert.ok(Math.abs(Math.log(pred.seconds) - (6 + 0 - 0.3)) < 0.15, 'Monday for devon');
  assert.equal(pred.basis, 'weekday');
  assert.equal(predict(fit, 'nobody', { id: 'new', weekday: 1 }), null);
  assert.equal(fitAdditive([]), null);
});

test('model: constructor effects feed predictions for unsolved puzzles', () => {
  const rows = synthetic({ users: { sean: 0, devon: 0.1 }, puzzles: PUZZLES, coverage: 1 });
  const fit = fitAdditive(rows);
  const puzzles = new Map(PUZZLES.map((p) => [p.id, { id: p.id, constructors: [p.difficulty > 0.1 ? 'Hard Guy' : 'Easy Gal'] }]));
  const effects = constructorEffects(fit, puzzles);
  assert.ok(effects.get('Hard Guy').effect > effects.get('Easy Gal').effect);
  const pred = predict(fit, 'sean', { id: 'unsolved', weekday: 2, constructors: ['Hard Guy'] }, effects);
  assert.equal(pred.basis, 'constructor');
});

test('model: Elo, Bradley–Terry and head-to-head agree on who is fastest', () => {
  const rows = synthetic({ users: { sean: 0, devon: -0.4, kam: 0.4 }, puzzles: PUZZLES, noise: 0.1 });
  const { ratings, history } = elo(rows);
  assert.ok(ratings.get('devon') > ratings.get('sean') && ratings.get('sean') > ratings.get('kam'));
  assert.equal(history.get('devon')[0].rating, 1500);
  const bt = bradleyTerry(rows);
  assert.ok(bt.get('devon') > bt.get('sean') && bt.get('sean') > bt.get('kam'));
  const { wins, games } = pairwise(rows);
  assert.ok(wins.get('devon').get('kam') > games.get('devon').get('kam') * 0.9);
  const ranksOf = rankCounts(rows, ['sean', 'devon', 'kam']);
  assert.ok(ranksOf.get('devon')[0] > ranksOf.get('kam')[0]);
});

test('model: co-op synergy compares with the members solo', () => {
  const rows = synthetic({ users: { sean: 0, devon: 0 }, puzzles: PUZZLES, coverage: 1, noise: 0.01 });
  const fit = fitAdditive(rows);
  const puzzles = new Map(PUZZLES.map((p) => [p.id, { id: p.id, weekday: p.weekday, constructors: [] }]));
  const p = PUZZLES[1]; // a Monday-ish puzzle both solved
  const solo = Math.exp(6 + p.weekdayEffect + p.difficulty);
  const s = coopSynergy(fit, { puzzleId: p.id, members: ['sean', 'devon'], seconds: solo / 2 }, puzzles);
  assert.ok(Math.abs(s.vsBest - 2) < 0.1, `twice as fast as either alone: ${s.vsBest}`);
  assert.ok(Math.abs(s.vsSplit - 1) < 0.05, 'exactly a perfect split');
  assert.equal(coopSynergy(fit, { puzzleId: p.id, members: ['sean', 'ghost'], seconds: 10 }, puzzles), null);
});
