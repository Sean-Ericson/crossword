/* Tests for the self-hosted server: auth, the SQLite store, live rooms
 * (convergence of concurrent edits, the shared timer, completion), and the
 * browser-side LiveSolve bookkeeping that pairs with them. */
import { readFileSync } from 'node:fs';
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
const proxied = { trustProxy: true, clientIpHeader: 'cf-connecting-ip', secureCookies: 'auto', publicUrl: 'https://crossword.ho.house' };

test('proxy: visitor IP from CF-Connecting-IP, else X-Forwarded-For, else socket', () => {
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }), proxied), '203.0.113.9');
  assert.equal(clientIp(fakeReq({ 'x-forwarded-for': 'spoofed, 198.51.100.4' }), proxied), '198.51.100.4');
  assert.equal(clientIp(fakeReq({}), proxied), '192.168.1.20');
  assert.equal(clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.9' }), { ...proxied, trustProxy: false }), '192.168.1.20');
});

test('proxy: WebSocket origin accepted for publicUrl even when Host is rewritten', () => {
  const origin = 'https://crossword.ho.house';
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
