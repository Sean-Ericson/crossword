/* Tests for moving a profile's local data onto another profile
 * (js/state.js migrateUserData), against a minimal localStorage shim. */
import assert from 'node:assert/strict';

// Minimal localStorage before importing anything that touches it.
const store = new Map();
globalThis.localStorage = {
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  saveLocal,
  loadLocal,
  saveStatsLocal,
  loadStatsLocal,
  newStatsDoc,
  listProgressIds,
  localDataSummary,
  migrateUserData,
} = await import('../js/state.js');
const { loadSettings, saveSettings } = await import('../js/settings.js');

/** Compact progress record; the migration never inspects the grid. */
function record(user, id, over = {}) {
  return {
    schema: 1,
    puzzle_id: id,
    user,
    fill: ['A', ''],
    marks: [0, 0],
    elapsed: 100,
    completed: false,
    solved_at: null,
    clean: true,
    used_check: false,
    used_reveal: false,
    autocheck: false,
    updated_at: '2026-07-20T00:00:00.000Z',
    ...over,
  };
}

const solve = (seconds, at) => ({
  seconds,
  completed_at: at,
  clean: true,
  used_check: false,
  used_reveal: false,
});

function reset() {
  store.clear();
}

test('migrate: guest data moves to the new profile and guest is cleared', () => {
  reset();
  saveLocal(record('guest', '2026-07-20', { completed: true, elapsed: 300 }));
  saveLocal(record('guest', '2026-07-21'));
  const stats = newStatsDoc('guest');
  stats.solves['2026-07-20'] = solve(300, '2026-07-20T10:00:00Z');
  saveStatsLocal(stats);

  const moved = migrateUserData('guest', 'sean');
  assert.deepEqual(moved, { puzzles: 2, solves: 1 });

  const adopted = loadLocal('sean', '2026-07-20');
  assert.equal(adopted.user, 'sean', 'record is re-owned');
  assert.equal(adopted.completed, true);
  assert.equal(adopted.elapsed, 300);
  assert.equal(loadStatsLocal('sean').solves['2026-07-20'].seconds, 300);

  assert.deepEqual(listProgressIds('guest'), [], 'source progress cleared');
  assert.deepEqual(loadStatsLocal('guest').solves, {}, 'source stats cleared');
});

test('migrate: merges rather than clobbers when both sides have the puzzle', () => {
  reset();
  // guest finished it; the destination only had it in progress
  saveLocal(
    record('guest', '2026-07-20', {
      completed: true,
      elapsed: 250,
      updated_at: '2026-07-20T00:00:00.000Z',
    })
  );
  saveLocal(
    record('sean', '2026-07-20', {
      elapsed: 90,
      updated_at: '2026-07-25T00:00:00.000Z', // newer, but incomplete
    })
  );
  const guestStats = newStatsDoc('guest');
  guestStats.solves['2026-07-20'] = solve(250, '2026-07-20T10:00:00Z');
  saveStatsLocal(guestStats);
  const seanStats = newStatsDoc('sean');
  seanStats.solves['2026-07-19'] = solve(400, '2026-07-19T10:00:00Z');
  saveStatsLocal(seanStats);

  migrateUserData('guest', 'sean');

  const merged = loadLocal('sean', '2026-07-20');
  assert.equal(merged.completed, true, 'completed beats newer-but-unfinished');
  assert.equal(merged.elapsed, 250);
  assert.deepEqual(
    Object.keys(loadStatsLocal('sean').solves).sort(),
    ['2026-07-19', '2026-07-20'],
    'solve logs are unioned'
  );
});

test('migrate: settings carry over only when the target has none', () => {
  reset();
  saveSettings('guest', { skipFilled: false, jumpBack: true });
  saveLocal(record('guest', '2026-07-20'));
  migrateUserData('guest', 'sean');
  assert.equal(loadSettings('sean').jumpBack, true, 'adopted guest settings');

  reset();
  saveSettings('guest', { jumpBack: true });
  saveSettings('dana', { jumpBack: false });
  saveLocal(record('guest', '2026-07-20'));
  migrateUserData('guest', 'dana');
  assert.equal(loadSettings('dana').jumpBack, false, 'kept its own settings');
});

test('migrate: same profile, or nothing to move, is a no-op', () => {
  reset();
  saveLocal(record('guest', '2026-07-20'));
  assert.deepEqual(migrateUserData('guest', 'guest'), { puzzles: 0, solves: 0 });
  assert.equal(listProgressIds('guest').length, 1, 'self-migration left data alone');
  assert.deepEqual(migrateUserData('', 'sean'), { puzzles: 0, solves: 0 });

  reset();
  assert.deepEqual(migrateUserData('guest', 'sean'), { puzzles: 0, solves: 0 });
});

test('migrate: clearSource:false leaves the original intact', () => {
  reset();
  saveLocal(record('guest', '2026-07-20'));
  migrateUserData('guest', 'sean', { clearSource: false });
  assert.equal(listProgressIds('guest').length, 1);
  assert.equal(listProgressIds('sean').length, 1);
});

test('summary: counts solved and in-progress separately', () => {
  reset();
  assert.equal(localDataSummary('guest').any, false);

  saveLocal(record('guest', '2026-07-20', { completed: true }));
  saveLocal(record('guest', '2026-07-21', { fill: ['A', ''], elapsed: 60 }));
  saveLocal(record('guest', '2026-07-22', { fill: ['', ''], elapsed: 0 })); // untouched
  const stats = newStatsDoc('guest');
  stats.solves['2026-07-20'] = solve(300, '2026-07-20T10:00:00Z');
  saveStatsLocal(stats);

  const summary = localDataSummary('guest');
  assert.equal(summary.any, true);
  assert.equal(summary.puzzles, 3);
  assert.equal(summary.solves, 1);
  assert.equal(summary.started, 1, 'only the touched-but-unfinished one');
});

test('listProgressIds: does not leak across similarly named profiles', () => {
  reset();
  saveLocal(record('sean', '2026-07-20'));
  saveLocal(record('sean-2', '2026-07-21'));
  assert.deepEqual(listProgressIds('sean'), ['2026-07-20']);
  assert.deepEqual(listProgressIds('sean-2'), ['2026-07-21']);
});
