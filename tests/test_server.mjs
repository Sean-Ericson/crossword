/* Tests for the self-hosted server: auth, the SQLite store, live rooms
 * (convergence of concurrent edits, the shared timer, completion), and the
 * browser-side LiveSolve bookkeeping that pairs with them. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { SolveEngine } from '../js/engine.js';
import { newProgress } from '../js/state.js';
import { LiveSolve } from '../js/net.js';
import { Store } from '../server/db.mjs';
import { hashPassword, verifyPassword, hashToken, LoginLimiter, parseCookies } from '../server/auth.mjs';
import { Hub } from '../server/rooms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = new PuzzleModel(parsePuz(readFileSync(path.join(here, 'fixtures', 'fixture15.puz'))));
const PUZZLE = '2026-01-01';
const quiet = { info() {}, error() {} };

function setup() {
  const store = new Store(':memory:');
  let clock = 1_000_000;
  const hub = new Hub({
    store,
    puzzles: { model: async (id) => (id === PUZZLE ? model : null) },
    now: () => clock,
    flushMs: 60_000,
    log: quiet,
  });
  const users = ['sean', 'devon', 'kam'].map((name) =>
    store.createUser({ name, pwHash: 'x' })
  );
  return { store, hub, users, tick: (ms) => (clock += ms) };
}

/** A simulated browser: LiveSolve + engine, with a manual network. */
function client(hub, user) {
  const inbox = [];
  const outbox = [];
  const conn = hub.connect(user, (msg) => inbox.push(structuredClone(msg)));
  const live = new LiveSolve({ puzzleId: PUZZLE });
  live.send = (msg) => {
    if (!live.connId) return false;
    outbox.push(structuredClone(msg));
    return true;
  };
  const record = newProgress(model, PUZZLE, user.name);
  const engine = new SolveEngine(model, record, { skipFilled: true, jumpBack: false });
  engine.deferCompletion = true;
  live.on('snapshot', (msg, overlay) => {
    engine.replaceRecord(msg.record);
    if (overlay.length) engine.applyRemoteCells(overlay);
  });
  live.on('cells', (changes) => engine.applyRemoteCells(changes));
  engine.on('cells', (indexes, meta) => {
    if (!meta.remote) live.sendCells(indexes.map((i) => ({ i, fill: record.fill[i], marks: record.marks[i] })));
  });
  return {
    conn,
    live,
    engine,
    record,
    inbox,
    outbox,
    /** deliver one server->client message */
    recv() {
      if (inbox.length) live.receive(inbox.shift());
    },
    /** deliver one client->server message */
    async sendOne() {
      if (outbox.length) await hub.handle(this.conn, outbox.shift());
    },
  };
}

async function drain(clients, hub) {
  for (let guard = 0; guard < 10000; guard++) {
    const busy = clients.find((c) => c.outbox.length || c.inbox.length);
    if (!busy) return;
    for (const c of clients) {
      while (c.outbox.length) await c.sendOne();
    }
    for (const c of clients) {
      while (c.inbox.length) c.recv();
    }
  }
  throw new Error('network never settled');
}

// deterministic PRNG (mulberry32)
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const open = model.cells.filter((c) => !c.isBlack).map((c) => c.index);

// ---------- auth ----------

test('auth: scrypt hash verifies only the right password', () => {
  const h = hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('correct hors', h));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('auth: login limiter blocks after max failures, per key', () => {
  const lim = new LoginLimiter({ max: 3, windowMs: 1000 });
  const keys = ['ip:1', 'user:sean'];
  for (let i = 0; i < 3; i++) lim.fail(keys, 100);
  assert.ok(lim.blocked(keys, 200));
  assert.ok(lim.blocked(['user:sean'], 200));
  assert.ok(!lim.blocked(['ip:2', 'user:devon'], 200));
  assert.ok(!lim.blocked(keys, 1200), 'window passes');
});

test('auth: cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; xw_session=abc%3D; b'), { a: '1', xw_session: 'abc=' });
});

// ---------- store ----------

test('store: sessions expire', () => {
  const { store, users } = setup();
  store.createSession(hashToken('tok'), users[0].id, 5000);
  assert.equal(store.sessionUser(hashToken('tok'), 4000)?.name, 'sean');
  assert.equal(store.sessionUser(hashToken('tok'), 6000), null);
  assert.equal(store.sessionUser(hashToken('nope'), 4000), null);
});

test('store: users get distinct colors and validated names', () => {
  const { store, users } = setup();
  assert.equal(new Set(users.map((u) => u.color)).size, 3);
  assert.throws(() => store.createUser({ name: 'Bad Name', pwHash: 'x' }));
});

test('store: one solo solve per user+puzzle, many co-ops', () => {
  const { store, users } = setup();
  const [sean, devon, kam] = users;
  const rec = newProgress(model, PUZZLE, 'sean');
  store.createSolve({ puzzleId: PUZZLE, kind: 'solo', ownerId: sean.id, createdBy: sean.id, memberIds: [sean.id], record: rec });
  assert.throws(() =>
    store.createSolve({ puzzleId: PUZZLE, kind: 'solo', ownerId: sean.id, createdBy: sean.id, memberIds: [sean.id], record: rec })
  );
  store.createSolve({ puzzleId: PUZZLE, kind: 'coop', createdBy: sean.id, memberIds: [sean.id, devon.id], record: rec });
  store.createSolve({ puzzleId: PUZZLE, kind: 'coop', createdBy: devon.id, memberIds: [devon.id, kam.id], record: rec });
  store.createSolve({ puzzleId: PUZZLE, kind: 'coop', createdBy: kam.id, memberIds: [sean.id, devon.id, kam.id], record: rec });
  assert.equal(store.solvesForUser(sean.id, PUZZLE).length, 3); // solo + 2 co-ops
  assert.equal(store.solvesForUser(devon.id, PUZZLE).length, 3);
  assert.equal(store.solvesForUser(kam.id, PUZZLE).length, 2);
});

test('store: solo stats keep the earliest completion', () => {
  const { store, users } = setup();
  const e = (completed_at, seconds) => ({ seconds, completed_at, clean: true, used_check: false, used_reveal: false });
  assert.ok(store.recordSoloSolve(users[0].id, PUZZLE, e('2026-02-01T00:00:00Z', 300)));
  assert.ok(!store.recordSoloSolve(users[0].id, PUZZLE, e('2026-03-01T00:00:00Z', 100)));
  assert.ok(store.recordSoloSolve(users[0].id, PUZZLE, e('2026-01-15T00:00:00Z', 200)));
  const doc = store.statsDoc(users[0]);
  assert.equal(doc.solves[PUZZLE].seconds, 200);
  assert.equal(doc.user, 'sean');
});

// ---------- rooms ----------

test('rooms: solo join creates the solve once; strangers cannot join co-ops', async () => {
  const { store, hub, users } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  const b = client(hub, users[0]); // same user, second device
  await hub.handle(b.conn, { type: 'join', puzzle: PUZZLE });
  assert.equal(a.conn.room, b.conn.room);
  assert.equal(store.solvesForUser(users[0].id).length, 1);

  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
    memberIds: [users[0].id, users[1].id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const k = client(hub, users[2]);
  await hub.handle(k.conn, { type: 'join', solve: coop.id });
  assert.equal(k.conn.room, null);
  assert.equal(k.inbox.at(-1).type, 'error');
  assert.equal(k.inbox.at(-1).code, 'not-member');
});

test('rooms: concurrent random edits from 3 clients converge', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { store, hub, users } = setup();
    const coop = store.createSolve({
      puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
      memberIds: users.map((u) => u.id), record: newProgress(model, PUZZLE, 'coop'),
    });
    const clients = users.map((u) => client(hub, u));
    for (const c of clients) {
      await hub.handle(c.conn, { type: 'join', solve: coop.id });
      c.recv(); // snapshot
    }
    const rand = rng(seed);
    // few cells, many edits: plenty of same-cell collisions
    const hot = open.slice(0, 6);
    for (let step = 0; step < 600; step++) {
      const c = clients[Math.floor(rand() * clients.length)];
      const r = rand();
      if (r < 0.45) {
        c.engine.select(hot[Math.floor(rand() * hot.length)], 'A', false);
        const roll = rand();
        if (roll < 0.7) c.engine.typeLetter('ABCDE'[Math.floor(rand() * 5)]);
        else c.engine.deleteKey();
      } else if (r < 0.75) {
        await c.sendOne();
      } else {
        c.recv();
      }
    }
    await drain(clients, hub);
    const room = clients[0].conn.room;
    for (const c of clients) {
      assert.deepEqual(c.record.fill, room.record.fill, `seed ${seed}: ${c.conn.user.name} diverged`);
      assert.deepEqual(c.record.marks, room.record.marks);
      assert.equal(c.live.pending.length, 0);
    }
  }
});

test('rooms: reconnect replays unacknowledged edits', async () => {
  const { hub, users } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  a.recv();
  a.engine.select(open[0], 'A', false);
  a.engine.typeLetter('Q');
  // connection drops before the edit reaches the server
  a.outbox.length = 0;
  hub.disconnect(a.conn);
  a.live.connId = null;
  // reconnect: new server-side conn, fresh snapshot
  const again = hub.connect(users[0], (m) => a.inbox.push(structuredClone(m)));
  a.conn = again;
  await hub.handle(again, { type: 'join', puzzle: PUZZLE });
  a.recv(); // snapshot -> overlay + resend
  assert.equal(a.record.fill[open[0]], 'Q', 'local edit survives the snapshot');
  await drain([a], hub);
  assert.equal(again.room.record.fill[open[0]], 'Q', 'server got it after reconnect');
});

test('rooms: shared timer runs while anyone is active; pause stops everyone', async () => {
  const { store, hub, users, tick } = setup();
  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
    memberIds: [users[0].id, users[1].id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const a = client(hub, users[0]);
  const b = client(hub, users[1]);
  await hub.handle(a.conn, { type: 'join', solve: coop.id });
  await hub.handle(b.conn, { type: 'join', solve: coop.id });
  const room = a.conn.room;
  await hub.handle(a.conn, { type: 'active', on: true });
  tick(10_000);
  await hub.handle(b.conn, { type: 'active', on: true });
  await hub.handle(a.conn, { type: 'active', on: false }); // a steps away; b still solving
  tick(5_000);
  assert.equal(Math.round(room.elapsed()), 15);
  await hub.handle(a.conn, { type: 'pause' });
  tick(60_000);
  assert.equal(Math.round(room.elapsed()), 15);
  assert.ok(b.inbox.some((m) => m.type === 'paused' && m.by === 'sean'));
  hub.disconnect(b.conn);
  hub.disconnect(a.conn);
  assert.equal(store.solveById(coop.id).record.elapsed, 15, 'flushed on last leave');
});

test('rooms: server completes the solve; solo solves reach the stats log', async () => {
  const { store, hub, users, tick } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  await hub.handle(a.conn, { type: 'active', on: true });
  tick(42_000);
  const changes = open.map((i) => ({ i, fill: model.cells[i].solution.toUpperCase(), marks: 0 }));
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes });
  const done = a.inbox.find((m) => m.type === 'completed');
  assert.ok(done, 'completed broadcast');
  assert.equal(done.elapsed, 42);
  assert.equal(done.clean, true);
  const doc = store.statsDoc(users[0]);
  assert.equal(doc.solves[PUZZLE].seconds, 42);
  // edits after completion bounce back with the real values
  a.inbox.length = 0;
  await hub.handle(a.conn, { type: 'cells', opId: 2, changes: [{ i: open[0], fill: '', marks: 0 }] });
  assert.equal(a.inbox[0].changes[0].fill, changes[0].fill);
});

test('rooms: co-op completion stays out of solo stats', async () => {
  const { store, hub, users } = setup();
  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
    memberIds: [users[0].id, users[1].id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', solve: coop.id });
  await hub.handle(a.conn, { type: 'flags', used_check: true });
  const changes = open.map((i) => ({ i, fill: model.cells[i].solution.toUpperCase(), marks: 0 }));
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes });
  assert.deepEqual(store.statsDoc(users[0]).solves, {});
  const coopStats = store.coopStats(users[1].id);
  assert.equal(coopStats.length, 1);
  assert.deepEqual(coopStats[0].members.sort(), ['devon', 'sean']);
  assert.equal(coopStats[0].clean, false);
});

test('rooms: deleting a user hangs up on them; co-op partners keep the solve', async () => {
  const { store, hub, users } = setup();
  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
    memberIds: [users[0].id, users[1].id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const a = client(hub, users[0]);
  const b = client(hub, users[1]);
  let closed = 0;
  b.conn.close = () => closed++;
  await hub.handle(a.conn, { type: 'join', solve: coop.id });
  await hub.handle(b.conn, { type: 'join', solve: coop.id });
  await hub.handle(b.conn, { type: 'cells', opId: 1, changes: [{ i: open[0], fill: 'Q', marks: 0 }] });
  a.inbox.length = 0;

  hub.dropUser(users[1].id, () => store.deleteUser(users[1].id));
  assert.equal(closed, 1);
  assert.equal(b.conn.room, null);
  assert.equal(store.userById(users[1].id), null);
  const room = hub.rooms.get(coop.id);
  assert.deepEqual(room.members.map((m) => m.name), ['sean']);
  assert.ok(a.inbox.some((m) => m.type === 'members' && m.members.length === 1));
  assert.ok(a.inbox.some((m) => m.type === 'presence' && m.presence.length === 1));
  assert.equal(room.record.fill[open[0]], 'Q', 'their edits stay');
  hub.disconnect(a.conn);
  assert.equal(store.solveById(coop.id).record.fill[open[0]], 'Q', 'flushed when the last person left');
});

test('rooms: bad cell values are ignored', async () => {
  const { hub, users } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  const room = a.conn.room;
  const black = model.cells.find((c) => c.isBlack).index;
  await hub.handle(a.conn, {
    type: 'cells',
    opId: 1,
    changes: [
      { i: black, fill: 'A', marks: 0 },
      { i: -1, fill: 'A', marks: 0 },
      { i: open[0], fill: 'TOOLONGFORAREBUS', marks: 0 },
      { i: open[1], fill: 'x', marks: 99 },
    ],
  });
  assert.equal(room.record.fill[black], '.');
  assert.equal(room.record.fill[open[0]], '');
  assert.equal(room.record.fill[open[1]], 'X');
  assert.equal(room.record.marks[open[1]], 0);
});

// ---------- solve log ----------

const answer = (i) => model.cells[i].solution.toUpperCase();
const kinds = (events) => events.map((e) => e.kind).join('');

test('log: a solo solve logs letters, focus, sittings and assists, then a summary', async () => {
  const { store, hub, users, tick } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  const room = a.conn.room;
  const w1 = model.words.A[0];
  await hub.handle(a.conn, { type: 'cursor', index: w1.cells[0], dir: 'A' }); // not solving yet: no 'w'
  await hub.handle(a.conn, { type: 'active', on: true }); // p, w, s
  await hub.handle(a.conn, { type: 'cursor', index: w1.cells[1], dir: 'A' }); // same entry: no 'w'
  tick(3_000);
  await hub.handle(a.conn, {
    type: 'cells', opId: 1, dir: 'A',
    changes: [{ i: w1.cells[0], fill: 'Q', marks: 0 }, { i: w1.cells[1], fill: answer(w1.cells[1]), marks: 0 }],
  });
  await hub.handle(a.conn, { type: 'cells', opId: 2, changes: [{ i: w1.cells[1], fill: answer(w1.cells[1]), marks: 0 }] }); // no change
  await hub.handle(a.conn, { type: 'assist', kind: 'check', scope: 'word', index: w1.cells[0], dir: 'A' });
  await hub.handle(a.conn, { type: 'assist', kind: 'nuke', scope: 'all' });
  assert.equal(a.inbox.at(-1).type, 'error', 'unknown assists are refused');
  const d1 = model.words.D.find((w) => w.cells[0] !== w1.cells[0]);
  await hub.handle(a.conn, { type: 'cursor', index: d1.cells[0], dir: 'D' }); // new entry: 'w'
  tick(2_000);
  await hub.handle(a.conn, { type: 'active', on: false }); // p, s
  tick(60_000); // away: the solve's clock doesn't move
  await hub.handle(a.conn, { type: 'active', on: true });
  tick(1_000);
  const rest = open.map((i) => ({ i, fill: answer(i), marks: 0 }));
  await hub.handle(a.conn, { type: 'cells', opId: 3, dir: 'D', changes: rest });

  const events = store.events(room.id);
  assert.equal(kinds(events.slice(0, 3)), 'pws');
  assert.deepEqual(events.slice(3, 5).map((e) => [e.kind, e.t, e.user, e.value, e.dir]), [
    ['c', 3000, 'sean', 'Q', 'A'],
    ['c', 3000, 'sean', answer(w1.cells[1]), 'A'],
  ]);
  assert.deepEqual(events.slice(5, 7).map((e) => [e.kind, e.value]), [['a', 'check:word'], ['w', d1.id]]);
  assert.equal(kinds(events.slice(7, 12)), 'psp' + 'ws');
  const done = events.at(-1);
  assert.equal(done.kind, 'd');
  assert.equal(done.t, 6_000, 'solving time, not wall time');
  assert.deepEqual(events.map((e) => e.seq), events.map((_, k) => k + 1));

  const summary = store.summary(room.id);
  assert.equal(summary.scalars.ms, 6_000);
  assert.equal(summary.scalars.sittings, 2);
  assert.equal(summary.scalars.wrong, 1, 'the Q');
  assert.equal(summary.scalars.fixed, 1);
  assert.equal(summary.scalars.checks.word, 1);
  assert.equal(summary.scalars.partial, false);
  assert.equal(summary.scalars.first_ms, 3_000);
  assert.equal(summary.detail.curve.filled.at(-1), 100);
});

test('log: reset keeps the earlier attempt, and the first completion is summarized', async () => {
  const { store, hub, users, tick } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  const room = a.conn.room;
  await hub.handle(a.conn, { type: 'active', on: true });
  tick(10_000);
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes: open.map((i) => ({ i, fill: answer(i), marks: 0 })) });
  const first = store.summary(room.id);
  assert.equal(first.scalars.ms, 10_000);
  await hub.handle(a.conn, { type: 'reset' });
  await hub.handle(a.conn, { type: 'active', on: true });
  tick(4_000);
  await hub.handle(a.conn, { type: 'cells', opId: 2, changes: open.map((i) => ({ i, fill: answer(i), marks: 0 })) });
  const events = store.events(room.id);
  assert.equal(events.filter((e) => e.kind === 'r').length, 1);
  assert.equal(events.filter((e) => e.kind === 'd').length, 2, 'both attempts kept');
  assert.equal(store.summary(room.id).scalars.ms, 10_000, 'still the first');
  assert.equal(store.statsDoc(users[0]).solves[PUZZLE].seconds, 10);
});

test('log: co-op letters are credited to whoever typed them, fixes included', async () => {
  const { store, hub, users, tick } = setup();
  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
    memberIds: [users[0].id, users[1].id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const a = client(hub, users[0]);
  const b = client(hub, users[1]);
  await hub.handle(a.conn, { type: 'join', solve: coop.id });
  await hub.handle(b.conn, { type: 'join', solve: coop.id });
  await hub.handle(a.conn, { type: 'active', on: true });
  await hub.handle(b.conn, { type: 'active', on: true });
  const half = Math.floor(open.length / 2);
  tick(1_000);
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes: [{ i: open[0], fill: answer(open[0]) === 'Z' ? 'Y' : 'Z', marks: 0 }] });
  tick(1_000);
  await hub.handle(b.conn, { type: 'cells', opId: 1, changes: open.slice(0, half).map((i) => ({ i, fill: answer(i), marks: 0 })) });
  tick(1_000);
  await hub.handle(a.conn, { type: 'cells', opId: 2, changes: open.slice(half).map((i) => ({ i, fill: answer(i), marks: 0 })) });
  const s = store.summary(coop.id).scalars;
  assert.equal(s.by.devon.fixed_others, 1, 'devon fixed sean’s letter');
  assert.equal(s.by.sean.wrong, 1);
  assert.equal(s.by.devon.final, half);
  assert.equal(s.by.sean.final, open.length - half);
  assert.deepEqual(store.summary(coop.id).detail.fixes, { 'devon>sean': 1 });
});

test('log: a grid changed outside the log gets a baseline; analysis calls it partial', async () => {
  const { store, hub, users } = setup();
  const record = newProgress(model, PUZZLE, 'sean');
  record.fill[open[0]] = answer(open[0]); // progress from before logging began
  const solve = store.createSolve({ puzzleId: PUZZLE, kind: 'solo', ownerId: users[0].id, createdBy: users[0].id, memberIds: [users[0].id], record });
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  hub.disconnect(a.conn);
  let events = store.events(solve.id);
  assert.equal(kinds(events), 'b');
  // opened again with nothing changed: no second baseline
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes: open.map((i) => ({ i, fill: answer(i), marks: 0 })) });
  events = store.events(solve.id);
  assert.equal(events.filter((e) => e.kind === 'b').length, 1);
  assert.equal(store.summary(solve.id).scalars.partial, true);
});

test('log: deleting someone mid-solve keeps their logged letters', async () => {
  const { store, hub, users } = setup();
  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id,
    memberIds: [users[0].id, users[1].id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const a = client(hub, users[0]);
  const b = client(hub, users[1]);
  await hub.handle(a.conn, { type: 'join', solve: coop.id });
  await hub.handle(b.conn, { type: 'join', solve: coop.id });
  await hub.handle(b.conn, { type: 'cells', opId: 1, changes: [{ i: open[0], fill: 'Q', marks: 0 }] });
  hub.dropUser(users[1].id, () => store.deleteUser(users[1].id));
  hub.disconnect(a.conn);
  const typed = store.events(coop.id).filter((e) => e.kind === 'c');
  assert.equal(typed.length, 1);
  assert.equal(typed[0].user, null, 'the account is gone, the letter stays');
});

test('log: summaries from an older analysis are recomputed', async () => {
  const { store, hub, users } = setup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes: open.map((i) => ({ i, fill: answer(i), marks: 0 })) });
  const id = a.conn.room.id;
  store.db.prepare('UPDATE solve_summaries SET v = 0').run();
  assert.equal(await hub.refreshSummaries(), 1);
  assert.notEqual(store.summary(id).v, 0);
  assert.equal(await hub.refreshSummaries(), 0);
});

test('store: a version 2 database gains the solve log and keeps its rows', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xw-migrate-'));
  const file = path.join(dir, 'x.db');
  let store = new Store(file);
  const u = store.createUser({ name: 'sean', pwHash: 'x' });
  store.recordSoloSolve(u.id, PUZZLE, { seconds: 5, completed_at: '2026-01-01T00:00:00Z', clean: true });
  store.db.exec('DROP TABLE solve_events; DROP TABLE solve_summaries; PRAGMA user_version = 2;');
  store.close();
  store = new Store(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.statsDoc(u).solves[PUZZLE].seconds, 5);
  assert.equal(store.maxEventSeq('nope'), 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('engine: remote cells leave the cursor alone and are tagged remote', () => {
  const record = newProgress(model, PUZZLE, 'sean');
  const engine = new SolveEngine(model, record, {});
  const before = { ...engine.sel };
  const seen = [];
  engine.on('cells', (idx, meta) => seen.push(meta.remote));
  engine.applyRemoteCells([{ i: open[5], fill: 'Z', marks: 0 }]);
  assert.deepEqual(engine.sel, before);
  assert.equal(record.fill[open[5]], 'Z');
  assert.deepEqual(seen, [true]);
});

test('engine: deferCompletion leaves solving to the server', () => {
  const record = newProgress(model, PUZZLE, 'sean');
  const engine = new SolveEngine(model, record, {});
  engine.deferCompletion = true;
  const full = [];
  engine.on('full', (e) => full.push(e));
  for (const i of open) engine.setCell(i, model.cells[i].solution.toUpperCase());
  engine.checkFull();
  assert.equal(record.completed, false);
  assert.deepEqual(full, []);
  engine.markCompleted({ solved_at: 'now', clean: true, elapsed: 9 });
  assert.equal(record.completed, true);
  assert.equal(full.length, 1);
});

// ---------- behind Cloudflare ----------

const { clientIp, originAllowed, secureCookiesFor } = await import('../server/api.mjs');
const fakeReq = (headers, remote = '192.168.1.20') => ({ headers, socket: { remoteAddress: remote } });
const proxied = { trustProxy: true, clientIpHeader: 'cf-connecting-ip', secureCookies: 'auto', publicUrl: 'https://cross.ho.house' };

test('proxy: visitor IP from CF-Connecting-IP, else X-Forwarded-For, else socket', () => {
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }), proxied), '203.0.113.9');
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': 'spoofed, 198.51.100.4' }), proxied), '198.51.100.4');
  assert.equal(clientIp(fakeReq({}), proxied), '192.168.1.20');
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.9' }), { ...proxied, trustProxy: false }), '192.168.1.20');
});

test('proxy: WebSocket origin accepted for publicUrl even when Host is rewritten', () => {
  const origin = 'https://cross.ho.house';
  assert.ok(originAllowed(fakeReq({ origin, host: '192.168.1.50:8080' }), proxied));
  assert.ok(originAllowed(fakeReq({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' }), proxied));
  assert.ok(!originAllowed(fakeReq({ origin: 'https://evil.example', host: '192.168.1.50:8080' }), proxied));
  assert.ok(!originAllowed(fakeReq({ host: '192.168.1.50:8080' }), proxied), 'no Origin, no entry');
  assert.ok(!originAllowed(fakeReq({ origin, host: '192.168.1.50:8080' }), { ...proxied, publicUrl: null }));
});

test('proxy: cookies are Secure when the public URL is https', () => {
  assert.equal(secureCookiesFor(fakeReq({}), proxied), true);
  assert.equal(secureCookiesFor(fakeReq({}), { ...proxied, publicUrl: null }), false);
  assert.equal(secureCookiesFor(fakeReq({ 'x-forwarded-proto': 'https' }), { ...proxied, publicUrl: null }), true);
});

// ---------- admin account management over HTTP ----------

test('stats api: one payload for everyone; logs of finished solves are open, unfinished ones members-only', async () => {
  const { createServer } = await import('../server/server.mjs');
  const { store, hub, users, tick } = setup();
  store.setPassword(users[0].id, hashPassword('sean-pass-1'));
  store.setPassword(users[1].id, hashPassword('devon-pass-1'));
  const cfg = {
    puzzlesDir: path.join(here, 'fixtures'), sessionDays: 30, trustProxy: false,
    clientIpHeader: null, secureCookies: false, publicUrl: null,
  };
  // sean solves solo (a check along the way); devon starts but doesn't finish
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE });
  await hub.handle(a.conn, { type: 'active', on: true });
  tick(30_000);
  await hub.handle(a.conn, { type: 'flags', used_check: true });
  await hub.handle(a.conn, { type: 'cells', opId: 1, changes: open.map((i) => ({ i, fill: answer(i), marks: 0 })) });
  const seanSolve = a.conn.room.id;
  const b = client(hub, users[1]);
  await hub.handle(b.conn, { type: 'join', puzzle: PUZZLE });
  await hub.handle(b.conn, { type: 'active', on: true });
  tick(5_000);
  await hub.handle(b.conn, { type: 'cells', opId: 1, changes: [{ i: open[0], fill: 'Q', marks: 0 }] });
  const devonSolve = b.conn.room.id;
  hub.disconnect(b.conn);

  const { server } = createServer(cfg, { store, puzzles: { model: async () => null }, hub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const login = async (name, password) => {
    const r = await fetch(base + 'login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const get = async (p, cookie) => {
    const r = await fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: r.status, json: await r.json() };
  };
  try {
    const kam = store.userByName('kam');
    store.setPassword(kam.id, hashPassword('kam-pass-11'));
    const kamCookie = await login('kam', 'kam-pass-11');
    const devonCookie = await login('devon', 'devon-pass-1');
    assert.equal((await get('stats-all')).status, 401);

    const all = (await get('stats-all', kamCookie)).json;
    assert.deepEqual(all.users.sean.solo[0].slice(0, 2), [PUZZLE, 30]);
    assert.equal(all.users.sean.solo[0][3], 2, 'not clean, check used');
    assert.equal(all.users.sean.solo[0][4], seanSolve);
    assert.deepEqual(all.users.devon.unfinished[0].slice(0, 3), [PUZZLE, 0, 5], 'one letter rounds to 0%, but 5 s were spent');
    assert.deepEqual(all.users.kam, { solo: [], unfinished: [] });
    assert.equal(all.summaries[seanSolve].ms, 30_000);

    const results = (await get(`puzzles/${PUZZLE}/results`, kamCookie)).json.results;
    assert.equal(results.length, 1);
    assert.equal(results[0].logged, true);
    assert.equal(results[0].summary.ms, 30_000);

    const log = (await get(`solves/${seanSolve}/events`, kamCookie)).json;
    assert.equal(log.solve.completed, true);
    assert.deepEqual(log.solve.members.map((m) => m.name), ['sean']);
    assert.equal(log.events.at(-1)[4], 'd');
    assert.equal(log.events.at(-1)[1], 30_000);
    assert.equal((await get(`solves/${devonSolve}/events`, kamCookie)).status, 404, 'unfinished: members only');
    assert.equal((await get(`solves/${devonSolve}/events`, devonCookie)).status, 200);

    const details = (await get('summaries/sean', kamCookie)).json.solves;
    assert.equal(details[seanSolve].puzzle_id, PUZZLE);
    assert.equal(details[seanSolve].detail.words.length, model.clueOrder.length);
    assert.equal((await get('summaries/nobody', kamCookie)).status, 404);
  } finally {
    server.close();
  }
});

test('admin api: admins reset passwords and add accounts; others cannot', async () => {
  const { createServer } = await import('../server/server.mjs');
  const store = new Store(':memory:');
  store.createUser({ name: 'sean', pwHash: hashPassword('sean-pass-1'), isAdmin: true });
  store.createUser({ name: 'devon', pwHash: hashPassword('devon-old-1') });
  const cfg = {
    puzzlesDir: path.join(here, 'fixtures'), sessionDays: 30, trustProxy: false,
    clientIpHeader: null, secureCookies: false, publicUrl: null,
  };
  const { server } = createServer(cfg, { store, puzzles: { model: async () => null }, hub: new Hub({ store, puzzles: {}, log: quiet }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const call = async (method, p, body, cookie) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = (name, password) => call('POST', 'login', { name, password });
  try {
    const admin = (await login('sean', 'sean-pass-1')).cookie;
    const devonOld = await login('devon', 'devon-old-1');
    assert.equal(devonOld.status, 200);

    // non-admins are refused
    assert.equal((await call('GET', 'admin/users', null, devonOld.cookie)).status, 403);
    assert.equal((await call('POST', 'admin/users/sean/password', {}, devonOld.cookie)).status, 403);

    // temporary password: returned once, old password and sessions gone
    const reset = await call('POST', 'admin/users/devon/password', {}, admin);
    assert.equal(reset.status, 200);
    assert.match(reset.json.password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    assert.equal((await login('devon', 'devon-old-1')).status, 401);
    assert.equal((await call('GET', 'me', null, devonOld.cookie)).status, 401, 'signed out everywhere');
    assert.equal((await login('devon', reset.json.password)).status, 200);

    // chosen password, validated
    assert.equal((await call('POST', 'admin/users/devon/password', { password: 'short' }, admin)).status, 400);
    const chosen = await call('POST', 'admin/users/devon/password', { password: 'devon-new-22' }, admin);
    assert.equal(chosen.json.password, undefined, 'a chosen password is not echoed back');
    assert.equal((await login('devon', 'devon-new-22')).status, 200);

    // own password goes through the account menu instead
    assert.equal((await call('POST', 'admin/users/sean/password', {}, admin)).status, 400);
    assert.equal((await call('POST', 'admin/users/nobody/password', {}, admin)).status, 404);

    // add an account
    const added = await call('POST', 'admin/users', { name: 'tom', display_name: 'Tom' }, admin);
    assert.equal(added.status, 201);
    assert.equal((await login('tom', added.json.password)).status, 200);
    assert.equal((await call('POST', 'admin/users', { name: 'tom' }, admin)).status, 409);
    assert.equal((await call('POST', 'admin/users', { name: 'Bad Name!' }, admin)).status, 400);
    const list = await call('GET', 'admin/users', null, admin);
    assert.deepEqual(list.json.users.map((u) => u.name), ['devon', 'sean', 'tom']);

    // grant and remove admin; takes effect on the next request
    const tom = (await login('tom', added.json.password)).cookie;
    assert.equal((await call('POST', 'admin/users/tom/admin', { is_admin: true }, devonOld.cookie)).status, 401);
    assert.equal((await call('POST', 'admin/users/tom/admin', { is_admin: 'yes' }, admin)).status, 400);
    const promoted = await call('POST', 'admin/users/tom/admin', { is_admin: true }, admin);
    assert.equal(promoted.status, 200);
    assert.equal(promoted.json.user.is_admin, true);
    assert.equal((await call('GET', 'admin/users', null, tom)).status, 200);
    assert.equal((await call('POST', 'admin/users/sean/admin', { is_admin: false }, admin)).status, 400, 'not your own');
    assert.equal((await call('POST', 'admin/users/tom/admin', { is_admin: false }, admin)).status, 200);
    assert.equal((await call('GET', 'admin/users', null, tom)).status, 403);
    assert.equal((await call('POST', 'admin/users/nobody/admin', { is_admin: true }, admin)).status, 404);

    // delete: non-admins refused, not yourself, and the account and its sessions are gone
    assert.equal((await call('DELETE', 'admin/users/devon', null, tom)).status, 403);
    assert.equal((await call('DELETE', 'admin/users/sean', null, admin)).status, 400);
    assert.equal((await call('DELETE', 'admin/users/nobody', null, admin)).status, 404);
    assert.equal((await call('DELETE', 'admin/users/tom', null, admin)).status, 200);
    assert.equal((await call('GET', 'me', null, tom)).status, 401, 'signed out');
    assert.equal((await login('tom', added.json.password)).status, 401);
    const after = await call('GET', 'admin/users', null, admin);
    assert.deepEqual(after.json.users.map((u) => u.name), ['devon', 'sean']);
  } finally {
    server.close();
  }
});

// ---------- two-way sync with the old GitHub data repo ----------

const { GitHubSync, ConflictError, progressPath } = await import('../server/github-sync.mjs');

/** In-memory stand-in for the GitHub data repo. */
class FakeRepo {
  constructor() {
    this.files = new Map(); // path -> {sha, obj}
    this.n = 0;
    this.puts = [];
  }
  write(path, obj) {
    const sha = `sha${++this.n}`;
    this.files.set(path, { sha, obj: structuredClone(obj) });
    return sha;
  }
  async tree() {
    return new Map([...this.files].map(([p, f]) => [p, f.sha]));
  }
  async readJson(sha) {
    return structuredClone([...this.files.values()].find((f) => f.sha === sha).obj);
  }
  async putJson(path, obj, sha) {
    if ((this.files.get(path)?.sha ?? null) !== sha) throw new ConflictError('stale sha');
    this.puts.push(path);
    return this.write(path, obj);
  }
}

function syncSetup() {
  const env = setup();
  const repo = new FakeRepo();
  const sync = new GitHubSync({ store: env.store, hub: env.hub, puzzles: { model: async (id) => (id === PUZZLE ? model : null) }, gh: repo, log: quiet });
  const path = progressPath('sean', PUZZLE);
  const remoteRecord = (fillIdx, updated_at, extra = {}) => {
    const r = newProgress(model, PUZZLE, 'sean');
    for (const i of fillIdx) r.fill[i] = 'A';
    return { ...r, updated_at, ...extra };
  };
  return { ...env, repo, sync, path, remoteRecord };
}

test('github sync: old-site progress is pulled in once and not echoed back', async () => {
  const { store, users, repo, sync, path, remoteRecord } = syncSetup();
  repo.write(path, remoteRecord([open[0]], '2026-09-20T10:00:00.000Z', { elapsed: 30 }));
  repo.write('users/devon/profile.json', { name: 'devon' });
  const first = await sync.cycle();
  assert.equal(first.pulled, 1);
  const solve = store.soloSolve(users[0].id, PUZZLE);
  assert.equal(solve.record.fill[open[0]], 'A');
  assert.equal(solve.record.elapsed, 30);
  const second = await sync.cycle();
  assert.deepEqual([second.pulled, second.pushed], [0, 0]);
  assert.deepEqual(repo.puts, []);
});

test('github sync: server progress is pushed; the newer side wins either way', async () => {
  const { store, users, repo, sync, path, remoteRecord } = syncSetup();
  repo.write(path, remoteRecord([open[0]], '2026-09-20T10:00:00.000Z'));
  await sync.cycle();
  const solve = store.soloSolve(users[0].id, PUZZLE);
  // played on the new site
  store.saveRecord(solve.id, { ...solve.record, fill: solve.record.fill.map((v, i) => (i === open[1] ? 'B' : v)), updated_at: '2026-09-21T10:00:00.000Z' });
  assert.equal((await sync.cycle()).pushed, 1);
  assert.equal(repo.files.get(path).obj.fill[open[1]], 'B');
  assert.equal((await sync.cycle()).pushed, 0);
  // then on the old site, later
  repo.write(path, remoteRecord([open[2]], '2026-09-22T10:00:00.000Z'));
  await sync.cycle();
  const after = store.soloSolve(users[0].id, PUZZLE).record;
  assert.equal(after.fill[open[2]], 'A');
  assert.equal(after.fill[open[1]], '', 'whole-record newest-wins, as the old site always did');
  assert.equal((await sync.cycle()).pushed, 0);
});

test('github sync: a solve open on the new site waits until it closes', async () => {
  const { store, hub, users, repo, sync, path, remoteRecord } = syncSetup();
  const a = client(hub, users[0]);
  await hub.handle(a.conn, { type: 'join', puzzle: PUZZLE }); // creates + opens the solo solve
  repo.write(path, remoteRecord([open[3]], '2026-09-25T10:00:00.000Z'));
  const busy = await sync.cycle();
  assert.equal(busy.pulled, 0);
  assert.equal(busy.pushed, 0, 'never overwrite remote without merging it first');
  hub.disconnect(a.conn);
  assert.equal((await sync.cycle()).pulled, 1);
  assert.equal(store.soloSolve(users[0].id, PUZZLE).record.fill[open[3]], 'A');
});

test('github sync: stats merge both ways; co-op and server-only users stay put', async () => {
  const { store, users, repo, sync } = syncSetup();
  const entry = (completed_at, seconds) => ({ seconds, completed_at, clean: true, used_check: false, used_reveal: false });
  repo.write('users/sean/stats.json', { schema: 1, user: 'sean', solves: { '2026-01-02': entry('2026-01-02T00:00:00Z', 100) } });
  store.recordSoloSolve(users[0].id, '2026-01-03', entry('2026-01-03T00:00:00Z', 200));
  // kam exists only on the server; a co-op solve exists too
  store.recordSoloSolve(users[2].id, '2026-01-04', entry('2026-01-04T00:00:00Z', 50));
  store.createSolve({ puzzleId: PUZZLE, kind: 'coop', createdBy: users[0].id, memberIds: [users[0].id, users[1].id],
    record: { ...newProgress(model, PUZZLE, 'coop'), updated_at: '2026-09-01T00:00:00Z' } });
  await sync.cycle();
  assert.ok(store.statsDoc(users[0]).solves['2026-01-02'], 'old-site solve pulled');
  assert.deepEqual(Object.keys(repo.files.get('users/sean/stats.json').obj.solves).sort(), ['2026-01-02', '2026-01-03']);
  assert.ok(![...repo.files.keys()].some((p) => p.startsWith('users/kam/')), 'server-only user not pushed');
  assert.ok(![...repo.files.keys()].some((p) => p.includes('/progress/')), 'co-op solve not pushed');
  assert.equal((await sync.cycle()).stats, 0);
});
