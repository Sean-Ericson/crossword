/* Tests for custom puzzles on the server: the store, build rooms (authors
 * editing a working copy live), publishing, sharing, co-authors, and the
 * rules for solving them (authors never do; drafts, withdrawn and
 * restricted puzzles stay out of other people's reach). */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { LiveBuild } from '../js/net.js';
import { applyChange, emptyDoc, publishedCopy, puzzleFeatures, modelOf } from '../js/custom-puzzle.js';
import { Store } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { Hub } from '../server/rooms.mjs';
import { Puzzles } from '../server/puzzles.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const quiet = { info() {}, error() {} };

const ANSWERS = 'CATOREWEB';
const CLUES = { A0: 'Feline', A3: 'Mine find', A6: 'Spider’s work', D0: 'Bovine', D1: 'Exist', D2: 'Tee, oddly' };

/** A finished 3×3: every square filled, every entry clued. */
function readyDoc(answers = ANSWERS) {
  const doc = emptyDoc({ width: 3, height: 3, title: 'Tiny', byline: 'Sean' });
  for (const ch of readyChanges(answers)) applyChange(doc, ch);
  return doc;
}

function readyChanges(answers = ANSWERS) {
  return [
    ...answers.split('').map((v, i) => ({ k: `cell:${i}`, v })),
    ...Object.entries(CLUES).map(([key, v]) => ({ k: `clue:${key}`, v })),
  ];
}

function setup() {
  const store = new Store(':memory:');
  let clock = 1_000_000;
  const puzzles = new Puzzles({ puzzlesDir: path.join(here, 'fixtures') }, { store, log: quiet });
  const hub = new Hub({ store, puzzles, now: () => clock, flushMs: 60_000, log: quiet });
  const users = ['sean', 'devon', 'kam', 'lee'].map((name) => store.createUser({ name, pwHash: 'x' }));
  return { store, hub, puzzles, users, tick: (ms) => (clock += ms) };
}

/** What the publish route does, without HTTP. */
function publish(store, puzzles, id, doc) {
  const published = publishedCopy(doc);
  store.saveCustomDoc(id, doc);
  store.publishCustomPuzzle(id, { published, features: puzzleFeatures(modelOf(published)) });
  puzzles.forget(id);
}

/** A simulated builder tab: LiveBuild and a doc, with a manual network. */
function builder(hub, user, puzzleId) {
  const inbox = [];
  const outbox = [];
  const conn = hub.connect(user, (msg) => inbox.push(structuredClone(msg)));
  const live = new LiveBuild({ puzzleId });
  live.send = (msg) => {
    if (!live.connId) return false;
    outbox.push(structuredClone(msg));
    return true;
  };
  const state = { doc: null, puzzle: null, errors: [], statuses: [], authors: [] };
  live.on('snapshot', (msg, overlay) => {
    state.doc = structuredClone(msg.doc);
    state.puzzle = msg.puzzle;
    for (const ch of overlay) applyChange(state.doc, ch);
  });
  live.on('edit', (changes) => {
    for (const ch of changes) applyChange(state.doc, ch);
  });
  live.on('error', (msg) => state.errors.push(msg));
  live.on('puzzle-state', (msg) => state.statuses.push(msg));
  live.on('authors', (msg) => state.authors.push(msg));
  state.chat = [];
  live.on('snapshot', (msg) => (state.chat = msg.chat.slice()));
  live.on('chat', (m) => state.chat.push(m));
  return {
    conn,
    live,
    inbox,
    outbox,
    state,
    edit(changes) {
      for (const ch of changes) applyChange(state.doc, ch);
      live.sendEdit(changes);
    },
    recv() {
      if (inbox.length) live.receive(inbox.shift());
    },
    async sendOne() {
      if (outbox.length) await hub.handle(this.conn, outbox.shift());
    },
    async join() {
      await hub.handle(this.conn, { type: 'build', puzzle: puzzleId });
      this.recv();
    },
  };
}

/** A bare solver connection (the solve side has its own tests). */
async function solver(hub, user, msg) {
  const inbox = [];
  const conn = hub.connect(user, (m) => inbox.push(structuredClone(m)));
  await hub.handle(conn, msg);
  return { conn, inbox };
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

// ---------- store ----------

test('custom store: a version 3 database gains custom puzzles and keeps its rows', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xw-migrate-'));
  const file = path.join(dir, 'x.db');
  let store = new Store(file);
  const u = store.createUser({ name: 'sean', pwHash: 'x' });
  store.recordSoloSolve(u.id, '2026-01-01', { seconds: 5, completed_at: '2026-01-01T00:00:00Z', clean: true });
  store.db.exec(`DROP TABLE puzzle_feedback; DROP TABLE custom_puzzle_shares; DROP TABLE custom_puzzle_authors;
                 DROP TABLE custom_puzzles; PRAGMA user_version = 3;`);
  store.close();
  store = new Store(file);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(store.statsDoc(u).solves['2026-01-01'].seconds, 5);
  const p = store.createCustomPuzzle({ id: 'custom-mig00001', createdBy: u.id, doc: emptyDoc({ width: 3, height: 3 }) });
  assert.deepEqual(p.authors.map((a) => a.name), ['sean']);
  assert.equal(p.status, 'draft');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('custom store: deleting an account drops drafts nobody else can edit, keeps published puzzles', () => {
  const { store, puzzles, users } = setup();
  const [sean, devon] = users;
  store.createCustomPuzzle({ id: 'custom-draft001', createdBy: sean.id, doc: emptyDoc({ width: 3, height: 3 }) });
  store.createCustomPuzzle({ id: 'custom-shared01', createdBy: sean.id, doc: emptyDoc({ width: 3, height: 3 }) });
  store.addCustomAuthors('custom-shared01', [devon.id]);
  store.createCustomPuzzle({ id: 'custom-pub00001', createdBy: sean.id, doc: readyDoc() });
  publish(store, puzzles, 'custom-pub00001', readyDoc());
  store.deleteUser(sean.id);
  assert.equal(store.customPuzzle('custom-draft001'), null);
  const shared = store.customPuzzle('custom-shared01');
  assert.deepEqual(shared.authors.map((a) => a.name), ['devon']);
  assert.equal(shared.created_by, devon.id, 'the remaining author takes over');
  const published = store.customPuzzle('custom-pub00001');
  assert.equal(published.status, 'published');
  assert.deepEqual(published.authors, []);
  assert.equal(published.published.byline, 'Sean', 'the byline stays');
});

// ---------- build rooms ----------

test('build: only a puzzle’s authors can open it in the builder', async () => {
  const { store, hub, users } = setup();
  const p = store.createCustomPuzzle({ id: 'custom-auth0001', createdBy: users[0].id, doc: emptyDoc({ width: 5, height: 5 }) });
  const stranger = builder(hub, users[1], p.id);
  await stranger.join();
  assert.equal(stranger.conn.room, null);
  assert.equal(stranger.state.errors[0].code, 'not-author');
  const lost = builder(hub, users[0], 'custom-nope0000');
  await lost.join();
  assert.equal(lost.state.errors[0].code, 'not-author');
  const sean = builder(hub, users[0], p.id);
  await sean.join();
  assert.equal(sean.state.doc.width, 5);
  assert.equal(sean.state.puzzle.status, 'draft');
  assert.equal(sean.state.puzzle.shape_locked, false);
  assert.equal(sean.state.puzzle.created_by, 'sean');
  assert.deepEqual(sean.state.puzzle.authors.map((a) => a.name), ['sean']);
});

test('build: three authors editing at once converge', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { store, hub, users } = setup();
    const p = store.createCustomPuzzle({ id: `custom-fuzz000${seed}`, createdBy: users[0].id, doc: emptyDoc({ width: 5, height: 5 }) });
    store.addCustomAuthors(p.id, [users[1].id, users[2].id]);
    const clients = users.slice(0, 3).map((u) => builder(hub, u, p.id));
    for (const c of clients) await c.join();
    const rand = rng(seed);
    // few keys, many edits: plenty of collisions
    const keys = ['cell:0', 'cell:1', 'cell:6', 'cell:24', 'circle:0', 'clue:A0', 'clue:D1', 'title'];
    const values = { cell: ['A', 'B', '.', '', 'QU'], circle: [0, 1], clue: ['x', 'yy', ''], title: ['T1', 'T2'] };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    for (let step = 0; step < 600; step++) {
      const c = pick(clients);
      const r = rand();
      if (r < 0.45) {
        const change = () => {
          const k = pick(keys);
          return { k, v: pick(values[k.split(':')[0]]) };
        };
        c.edit(rand() < 0.2 ? [change(), change()] : [change()]); // sometimes two in one op
      } else if (r < 0.75) {
        await c.sendOne();
      } else {
        c.recv();
      }
    }
    await drain(clients, hub);
    const room = hub.buildRoom(p.id);
    for (const c of clients) {
      assert.deepEqual(c.state.doc, room.doc, `seed ${seed}: ${c.conn.user.name} diverged`);
      assert.equal(c.live.pending.length, 0);
    }
    for (const c of clients) hub.disconnect(c.conn);
    assert.deepEqual(store.customPuzzle(p.id).doc, room.doc, 'written when the last author left');
    assert.equal(hub.buildRoom(p.id), null);
  }
});

test('build: edits survive a dropped connection', async () => {
  const { store, hub, users } = setup();
  const p = store.createCustomPuzzle({ id: 'custom-drop0001', createdBy: users[0].id, doc: emptyDoc({ width: 3, height: 3 }) });
  const a = builder(hub, users[0], p.id);
  await a.join();
  a.edit([{ k: 'cell:3', v: 'Q' }, { k: 'clue:A3', v: 'Lost at first' }]);
  a.outbox.length = 0; // the connection drops before the edit gets there
  hub.disconnect(a.conn);
  a.live.connId = null;
  const again = hub.connect(users[0], (m) => a.inbox.push(structuredClone(m)));
  a.conn = again;
  await hub.handle(again, { type: 'build', puzzle: p.id });
  a.recv(); // snapshot -> overlay + resend
  assert.equal(a.state.doc.grid[3], 'Q', 'the local edit survives the snapshot');
  await drain([a], hub);
  assert.equal(hub.buildRoom(p.id).doc.grid[3], 'Q');
  assert.equal(hub.buildRoom(p.id).doc.clues.A3, 'Lost at first');
});

test('build: once published the shape is locked; letters and clues are not', async () => {
  const { store, hub, puzzles, users } = setup();
  const p = store.createCustomPuzzle({ id: 'custom-lock0001', createdBy: users[0].id, doc: readyDoc() });
  publish(store, puzzles, p.id, readyDoc());
  const a = builder(hub, users[0], p.id);
  await a.join();
  assert.equal(a.state.puzzle.shape_locked, true);
  assert.equal(a.state.puzzle.changed, false);
  a.edit([{ k: 'cell:4', v: '.' }, { k: 'cell:0', v: 'B' }]);
  await drain([a], hub);
  assert.equal(a.state.doc.grid[4], 'R', 'the flip came back');
  assert.equal(a.state.doc.grid[0], 'B');
  assert.equal(a.state.statuses.at(-1).changed, true, 'the working copy differs from what solvers have');
  a.edit([{ k: 'cell:0', v: 'C' }]);
  await drain([a], hub);
  assert.equal(a.state.statuses.at(-1).changed, false, 'undone');
});

test('build: removed co-authors are sent away; a new one is announced', async () => {
  const { store, hub, users } = setup();
  const [sean, devon, kam] = users;
  const p = store.createCustomPuzzle({ id: 'custom-coau0001', createdBy: sean.id, doc: emptyDoc({ width: 3, height: 3 }) });
  store.addCustomAuthors(p.id, [devon.id]);
  const a = builder(hub, sean, p.id);
  const b = builder(hub, devon, p.id);
  await a.join();
  await b.join();
  store.addCustomAuthors(p.id, [kam.id]);
  hub.buildRoom(p.id).refreshAuthors();
  await drain([a, b], hub);
  assert.deepEqual(a.state.authors.at(-1).authors.map((x) => x.name), ['sean', 'devon', 'kam']);
  store.removeCustomAuthor(p.id, devon.id);
  hub.buildRoom(p.id).refreshAuthors();
  await drain([a, b], hub);
  assert.equal(b.state.errors.at(-1).code, 'not-author');
  assert.equal(b.conn.room, null);
  // deleting the creator's account: kam carries on
  hub.dropUser(sean.id, () => store.deleteUser(sean.id));
  assert.deepEqual(store.customPuzzle(p.id).authors.map((x) => x.name), ['kam']);
});

test('build: authors message each other; the conversation goes when the puzzle does', async () => {
  const { store, hub, users } = setup();
  const [sean, devon, kam] = users;
  const p = store.createCustomPuzzle({ id: 'custom-chat0001', createdBy: sean.id, doc: emptyDoc({ width: 3, height: 3 }) });
  store.addCustomAuthors(p.id, [devon.id]);
  const a = builder(hub, sean, p.id);
  const b = builder(hub, devon, p.id);
  await a.join();
  await b.join();
  a.live.sendChat('Can you clue 1A?');
  await drain([a, b], hub);
  b.live.sendChat('On it');
  await drain([a, b], hub);
  for (const c of [a, b]) assert.deepEqual(c.state.chat.map((m) => `${m.user}: ${m.text}`), ['sean: Can you clue 1A?', 'devon: On it']);

  // a new co-author sees what was said
  store.addCustomAuthors(p.id, [kam.id]);
  hub.buildRoom(p.id).refreshAuthors();
  const k = builder(hub, kam, p.id);
  await k.join();
  assert.equal(k.state.chat.length, 2);
  // nobody else hears it, and it isn't solvers' business
  assert.ok(!(await solver(hub, users[3], { type: 'chat', cid: 'x1', text: 'hi' })).inbox.some((m) => m.type === 'chat'));

  for (const c of [a, b, k]) hub.disconnect(c.conn);
  assert.equal(store.chatMessages({ puzzleId: p.id }).length, 2);
  store.deleteCustomPuzzle(p.id);
  assert.equal(store.chatMessages({ puzzleId: p.id }).length, 0);
});

// ---------- solving custom puzzles ----------

test('custom solves: drafts, their authors and withdrawn puzzles take no new solves', async () => {
  const { store, hub, puzzles, users, tick } = setup();
  const [sean, devon, kam] = users;
  const id = 'custom-solv0001';
  store.createCustomPuzzle({ id, createdBy: sean.id, doc: readyDoc() });
  let r = await solver(hub, devon, { type: 'join', puzzle: id });
  assert.equal(r.inbox[0].code, 'no-puzzle', 'a draft');
  publish(store, puzzles, id, readyDoc());
  r = await solver(hub, sean, { type: 'join', puzzle: id });
  assert.equal(r.inbox[0].code, 'own-puzzle');
  r = await solver(hub, devon, { type: 'join', puzzle: id });
  assert.equal(r.inbox[0].type, 'snapshot');
  await hub.handle(r.conn, { type: 'active', on: true });
  tick(20_000);
  await hub.handle(r.conn, { type: 'cells', opId: 1, changes: ANSWERS.split('').map((fill, i) => ({ i, fill, marks: 0 })) });
  assert.ok(r.inbox.some((m) => m.type === 'completed'), 'the server checks the answers');
  assert.equal(store.statsDoc(devon).solves[id].seconds, 20);
  hub.disconnect(r.conn);
  store.withdrawCustomPuzzle(id);
  r = await solver(hub, devon, { type: 'join', puzzle: id });
  assert.equal(r.inbox[0].type, 'snapshot', 'people keep the solves they have');
  r = await solver(hub, kam, { type: 'join', puzzle: id });
  assert.equal(r.inbox[0].code, 'no-puzzle', 'nobody new');
});

test('custom solves: a restricted puzzle stays with the people it is shared with', async () => {
  const { store, hub, puzzles, users } = setup();
  const [sean, devon, kam] = users;
  const id = 'custom-priv0001';
  store.createCustomPuzzle({ id, createdBy: sean.id, doc: readyDoc() });
  publish(store, puzzles, id, readyDoc());
  store.setCustomSharing(id, 'people', [devon.id]);
  assert.ok(store.canSeePuzzle(devon.id, id));
  assert.ok(store.canSeePuzzle(sean.id, id), 'its authors');
  assert.ok(!store.canSeePuzzle(kam.id, id));
  assert.ok(store.canSeePuzzle(kam.id, '2026-01-01'), 'every other puzzle');
  assert.equal((await solver(hub, kam, { type: 'join', puzzle: id })).inbox[0].code, 'no-puzzle');
  const r = await solver(hub, devon, { type: 'join', puzzle: id });
  await hub.handle(r.conn, { type: 'cells', opId: 1, changes: ANSWERS.split('').map((fill, i) => ({ i, fill, marks: 0 })) });
  hub.disconnect(r.conn);
  assert.equal(store.statsAll(devon.id).users.devon.solo.length, 1);
  assert.equal(store.statsAll(kam.id).users.devon.solo.length, 0, 'kam doesn’t see it in the stats');
  assert.equal(Object.keys(store.summaryDetails(devon.id, kam.id)).length, 0);
  assert.equal(Object.keys(store.summaryDetails(devon.id, devon.id)).length, 1);
  // narrowing the share later never takes a solve away
  store.setCustomSharing(id, 'people', []);
  assert.ok(store.canSeePuzzle(devon.id, id));
});

test('custom solves: an update switches open solves to the new copy', async () => {
  const { store, hub, puzzles, users } = setup();
  const [sean, devon] = users;
  const id = 'custom-upd00001';
  store.createCustomPuzzle({ id, createdBy: sean.id, doc: readyDoc('CATOREWEX') });
  publish(store, puzzles, id, readyDoc('CATOREWEX')); // a typo in the last answer
  const r = await solver(hub, devon, { type: 'join', puzzle: id });
  await hub.handle(r.conn, { type: 'cells', opId: 1, changes: ANSWERS.split('').map((fill, i) => ({ i, fill, marks: 0 })) });
  assert.ok(!r.inbox.some((m) => m.type === 'completed'), 'WEB isn’t WEX');
  publish(store, puzzles, id, readyDoc());
  await hub.puzzleChanged(id);
  assert.ok(r.inbox.some((m) => m.type === 'puzzle-updated'));
  assert.ok(r.inbox.some((m) => m.type === 'completed'), 'the fixed answer completes the grid');
});

// ---------- over HTTP ----------

test('custom api: drafts, publishing, sharing, co-authors, delete and withdraw', async () => {
  const { createServer } = await import('../server/server.mjs');
  const { store, hub, puzzles, users } = setup();
  for (const u of users) store.setPassword(u.id, hashPassword(`${u.name}-pass-1`));
  const cfg = {
    puzzlesDir: path.join(here, 'fixtures'), sessionDays: 30, trustProxy: false,
    clientIpHeader: null, secureCookies: false, publicUrl: null,
  };
  const { server } = createServer(cfg, { store, puzzles, hub });
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
  const login = async (name) => (await call('POST', 'login', { name, password: `${name}-pass-1` })).cookie;
  try {
    const [sean, devon, kam, lee] = [await login('sean'), await login('devon'), await login('kam'), await login('lee')];

    // a draft, private to its author
    assert.equal((await call('POST', 'custom-puzzles', { width: 2, height: 3 }, sean)).status, 400);
    const made = await call('POST', 'custom-puzzles', { width: 3, height: 3, title: 'Tiny' }, sean);
    assert.equal(made.status, 201);
    const id = made.json.puzzle.id;
    assert.match(id, /^custom-[A-Za-z0-9_-]{8}$/);
    assert.equal(made.json.puzzle.status, 'draft');
    assert.equal(made.json.puzzle.title, 'Tiny');
    assert.equal(made.json.puzzle.author, 'sean', 'the byline starts as your name');
    assert.equal((await call('GET', `custom-puzzles/${id}`, null, devon)).status, 404);
    assert.deepEqual((await call('GET', 'custom-puzzles', null, devon)).json.puzzles, []);
    assert.equal((await call('GET', `custom-puzzles/${id}`, null, sean)).json.doc, null, 'no published copy yet');

    // nothing to publish yet
    const early = await call('POST', `custom-puzzles/${id}/publish`, {}, sean);
    assert.equal(early.status, 400);
    assert.match(early.json.error, /need a letter/);

    // fill it in live, then publish it to devon only
    const b = builder(hub, users[0], id);
    await b.join();
    b.edit(readyChanges());
    await drain([b], hub);
    const working = await call('GET', `custom-puzzles/${id}?working=1`, null, sean);
    assert.equal(working.json.doc.grid.join(''), ANSWERS);
    assert.equal((await call('GET', `custom-puzzles/${id}?working=1`, null, devon)).status, 404);
    const pub = await call('POST', `custom-puzzles/${id}/publish`, { visibility: 'people', people: ['devon'] }, sean);
    assert.equal(pub.status, 200, pub.json.error);
    assert.equal(pub.json.puzzle.status, 'published');
    assert.deepEqual(pub.json.puzzle.shared_with, ['devon']);
    assert.equal(pub.json.puzzle.words, 6);
    await drain([b], hub);
    assert.equal(b.state.statuses.at(-1).status, 'published');
    assert.equal(b.state.statuses.at(-1).shape_locked, true);

    // devon sees it; kam doesn't
    const forDevon = (await call('GET', 'custom-puzzles', null, devon)).json.puzzles;
    assert.deepEqual(forDevon.map((p) => p.id), [id]);
    assert.equal(forDevon[0].mine, false);
    assert.equal(forDevon[0].updated_at, undefined, 'authors-only fields stay with the authors');
    const got = await call('GET', `custom-puzzles/${id}`, null, devon);
    assert.equal(got.json.doc.grid.join(''), ANSWERS);
    assert.deepEqual(got.json.puzzle.audience, ['devon']);
    assert.deepEqual((await call('GET', 'custom-puzzles', null, kam)).json.puzzles, []);
    assert.equal((await call('GET', `custom-puzzles/${id}`, null, kam)).status, 404);

    // devon solves it; its results and log stay out of kam's reach
    const r = await solver(hub, users[1], { type: 'join', puzzle: id });
    const solveId = r.conn.room.id;
    await hub.handle(r.conn, { type: 'cells', opId: 1, changes: ANSWERS.split('').map((fill, i) => ({ i, fill, marks: 0 })) });
    hub.disconnect(r.conn);
    assert.equal((await call('GET', `puzzles/${id}/results`, null, devon)).json.results.length, 1);
    assert.equal((await call('GET', `puzzles/${id}/results`, null, kam)).status, 404);
    assert.equal((await call('GET', `solves/${solveId}/events`, null, kam)).status, 404);
    assert.equal((await call('GET', `solves/${solveId}/events`, null, sean)).status, 200, 'its authors may look');
    assert.equal((await call('GET', 'stats-all', null, kam)).json.users.devon.solo.length, 0);
    const listed = (await call('GET', 'custom-puzzles', null, sean)).json.puzzles[0];
    assert.equal(listed.solved, 1);

    // co-ops: never with an author, never with someone it isn't shared with
    assert.equal((await call('POST', 'solves', { puzzle_id: id, members: ['sean'] }, devon)).status, 400);
    assert.equal((await call('POST', 'solves', { puzzle_id: id, members: ['kam'] }, devon)).status, 403);
    assert.equal((await call('POST', `custom-puzzles/${id}/sharing`, { visibility: 'everyone' }, devon)).status, 404);
    assert.equal((await call('POST', `custom-puzzles/${id}/sharing`, { visibility: 'everyone' }, sean)).status, 200);
    assert.equal((await call('POST', 'solves', { puzzle_id: id, members: ['kam'] }, devon)).status, 201);

    // co-authors: not someone who has played it
    const refused = await call('POST', `custom-puzzles/${id}/authors`, { add: ['kam'] }, sean);
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /already has a solve/);
    assert.deepEqual((await call('POST', `custom-puzzles/${id}/authors`, { add: ['lee'] }, sean)).json.authors, ['sean', 'lee']);
    assert.equal((await call('GET', `custom-puzzles/${id}?working=1`, null, lee)).status, 200);
    assert.equal((await call('DELETE', `custom-puzzles/${id}`, null, lee)).status, 403, 'only its creator deletes it');
    assert.equal((await call('DELETE', `custom-puzzles/${id}/authors/sean`, null, lee)).status, 403);
    assert.deepEqual((await call('DELETE', `custom-puzzles/${id}/authors/lee`, null, lee)).json.authors, ['sean'], 'anyone can leave');
    assert.equal((await call('DELETE', `custom-puzzles/${id}/authors/sean`, null, sean)).status, 400, 'someone has to stay');

    // updating: open solves hear about it
    b.edit([{ k: 'clue:A0', v: 'Kitty' }]);
    await drain([b], hub);
    const solving = await solver(hub, users[2], { type: 'join', puzzle: id });
    assert.equal((await call('POST', `custom-puzzles/${id}/publish`, {}, sean)).status, 200);
    assert.ok(solving.inbox.some((m) => m.type === 'puzzle-updated'));
    assert.equal((await call('GET', `custom-puzzles/${id}`, null, kam)).json.doc.clues.A0, 'Kitty');
    hub.disconnect(solving.conn);

    // feedback: from people who finished it; notes only for them and the authors
    assert.equal((await call('POST', `custom-puzzles/${id}/feedback`, { stars: 5 }, kam)).status, 403, 'kam hasn’t finished it');
    assert.equal((await call('POST', `custom-puzzles/${id}/feedback`, { stars: 5 }, sean)).status, 400, 'nor do authors rate');
    assert.equal((await call('POST', `custom-puzzles/${id}/feedback`, { stars: 6 }, devon)).status, 400);
    assert.equal((await call('POST', `custom-puzzles/${id}/feedback`, { stars: 4, comment: '  Loved 1-Across!  ' }, devon)).status, 200);
    const asAuthor = (await call('GET', `custom-puzzles/${id}/feedback`, null, sean)).json;
    assert.deepEqual(asAuthor.stars, { avg: 4, n: 1 });
    assert.equal(asAuthor.notes[0].comment, 'Loved 1-Across!');
    assert.equal(asAuthor.can_rate, false);
    const asKam = (await call('GET', `custom-puzzles/${id}/feedback`, null, kam)).json;
    assert.equal(asKam.notes, null, 'notes can give answers away');
    assert.deepEqual(asKam.stars, { avg: 4, n: 1 });
    const asDevon = (await call('GET', `custom-puzzles/${id}/feedback`, null, devon)).json;
    assert.equal(asDevon.can_rate, true);
    assert.equal(asDevon.mine.stars, 4);
    assert.deepEqual((await call('GET', 'custom-puzzles', null, kam)).json.puzzles[0].stars, { avg: 4, n: 1 });

    // deleting something people have played withdraws it instead
    assert.deepEqual((await call('DELETE', `custom-puzzles/${id}`, null, sean)).json, { withdrawn: true });
    await drain([b], hub);
    assert.equal(b.state.statuses.at(-1).status, 'withdrawn');
    assert.deepEqual((await call('GET', 'custom-puzzles', null, lee)).json.puzzles, [], 'unlisted for people without a solve');
    assert.equal((await call('GET', 'custom-puzzles', null, devon)).json.puzzles.length, 1, 'still there for those with one');

    // an upload, then a draft that goes away for good
    const upload = await call('POST', 'custom-puzzles', { doc: { width: 3, height: 3, grid: [...ANSWERS], clues: CLUES } }, devon);
    assert.equal(upload.status, 201);
    assert.equal(store.customPuzzle(upload.json.puzzle.id).doc.grid.join(''), ANSWERS);
    assert.equal(upload.json.puzzle.author, 'devon');
    assert.deepEqual((await call('DELETE', `custom-puzzles/${upload.json.puzzle.id}`, null, devon)).json, { deleted: true });
    assert.equal(store.customPuzzle(upload.json.puzzle.id), null);
  } finally {
    server.close();
  }
});

test('words api: the archive’s answers, published puzzles’ and a list file', async () => {
  const { createServer } = await import('../server/server.mjs');
  const { store, hub, puzzles, users } = setup();
  store.setPassword(users[0].id, hashPassword('sean-pass-1'));
  const dir = mkdtempSync(path.join(tmpdir(), 'xw-words-'));
  writeFileSync(path.join(dir, 'list.txt'), 'CRANE;90\nCRATE;40\n# a comment\n');
  // published for everyone: its answers count; a restricted one's don't
  store.createCustomPuzzle({ id: 'custom-words001', createdBy: users[0].id, doc: readyDoc() });
  publish(store, puzzles, 'custom-words001', readyDoc());
  store.createCustomPuzzle({ id: 'custom-words002', createdBy: users[0].id, doc: readyDoc('CATOREWEX') });
  publish(store, puzzles, 'custom-words002', readyDoc('CATOREWEX'));
  store.setCustomSharing('custom-words002', 'people', [users[1].id]);
  const cfg = {
    puzzlesDir: path.join(here, 'fixtures'), wordList: path.join(dir, 'list.txt'), sessionDays: 30,
    trustProxy: false, clientIpHeader: null, secureCookies: false, publicUrl: null,
  };
  const { server, words } = createServer(cfg, { store, puzzles, hub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const post = async (p, body, cookie) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  try {
    const login = await fetch(base + 'login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sean', password: 'sean-pass-1' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await words.build();
    const crane = await post('words/suggest', { pattern: 'cra?e' }, cookie);
    assert.equal(crane.json.ready, true);
    assert.deepEqual(crane.json.words, [['CRANE', 90], ['CRATE', 40]], 'best first');
    const web = await post('words/suggest', { pattern: 'WE?' }, cookie);
    assert.deepEqual(web.json.words, [['WEB', 60]], 'a published puzzle’s answer, used once');
    const counts = await post('words/counts', { patterns: ['CRA?E', 'QQQ', 'BAD!', 'DKRY', 'WEX'] }, cookie);
    assert.deepEqual(counts.json.counts, [2, 0, null, 1, 0], 'fixture answers count; a restricted puzzle’s don’t');
    // a blank whose crossing nothing fits leaves no suggestions
    const crossed = await post('words/suggest', { pattern: 'CRA?E', cross: [null, null, null, { pattern: '?Q', at: 0 }] }, cookie);
    assert.equal(crossed.json.total, 0);
    assert.equal(crossed.json.loose, 2);
    assert.equal((await post('words/suggest', { pattern: 'C' }, cookie)).status, 400);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('word lists api: upload, edit, search, download; each person sees their own', async () => {
  const { createServer } = await import('../server/server.mjs');
  const { store, hub, puzzles, users } = setup();
  for (const u of users) store.setPassword(u.id, hashPassword(`${u.name}-pass-1`));
  const dir = mkdtempSync(path.join(tmpdir(), 'xw-lists-'));
  writeFileSync(path.join(dir, 'list.txt'), 'CRANE;90\nCRATE;40\n');
  const cfg = {
    puzzlesDir: path.join(here, 'fixtures'), wordList: path.join(dir, 'list.txt'), sessionDays: 30,
    trustProxy: false, clientIpHeader: null, secureCookies: false, publicUrl: null,
  };
  const { server, words } = createServer(cfg, { store, puzzles, hub });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const call = async (method, p, body, cookie) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };
  const login = async (name) => {
    const r = await fetch(base + 'login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password: `${name}-pass-1` }),
    });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const suggest = async (pattern, cookie) => (await call('POST', 'words/suggest', { pattern }, cookie)).json.words;
  try {
    const [sean, devon] = [await login('sean'), await login('devon')];
    await words.build();
    assert.deepEqual(await suggest('CRA?E', sean), [['CRANE', 90], ['CRATE', 40]]);
    const empty = (await call('GET', 'word-lists', null, sean)).json;
    assert.deepEqual(empty, { use_site: true, site: { size: words.current().size }, lists: [] });

    // an upload: odd lines are skipped, scores kept to 0-100, a 0 hides a word
    const made = await call('POST', 'word-lists', { name: '  Broda  list ', text: 'crate;95\nCRANE;0\nR2D2;50\nplate\nzebra crossing;150\n' }, sean);
    assert.equal(made.status, 201);
    assert.deepEqual([made.json.list.name, made.json.list.count, made.json.added, made.json.skipped], ['Broda list', 4, 4, 1]);
    const id = made.json.list.id;
    assert.deepEqual(await suggest('CRA?E', sean), [['CRATE', 95]], 'their score replaces the site’s; CRANE is hidden');
    assert.deepEqual(await suggest('CRA?E', devon), [['CRANE', 90], ['CRATE', 40]], 'nobody else’s suggestions change');
    assert.deepEqual(await suggest('?LATE', sean), [['PLATE', 50]]);
    const counts = await call('POST', 'words/counts', { patterns: ['CRA?E', 'ZEBRACROSSIN?'] }, sean);
    assert.deepEqual(counts.json.counts, [1, 1]);

    // someone else's list is nowhere to be found
    for (const [method, p, body] of [
      ['GET', `word-lists/${id}/words`], ['POST', `word-lists/${id}`, { enabled: false }],
      ['POST', `word-lists/${id}/words`, { set: [['EVIL', 99]] }], ['GET', `word-lists/${id}/file`], ['DELETE', `word-lists/${id}`],
    ]) {
      assert.equal((await call(method, p, body, devon)).status, 404, `${method} ${p}`);
    }
    assert.deepEqual((await call('GET', 'word-lists', null, devon)).json.lists, []);
    assert.equal((await call('GET', `word-lists/${id}/words`, null, null)).status, 401);

    // editing: add, rescore, remove; typed lines take the default score
    const edit = await call('POST', `word-lists/${id}/words`, { text: 'Ice-cream\nplate;70', score: 65, set: [['CRANE', 80]], remove: ['zebra crossing', 'NOPE'] }, sean);
    assert.equal(edit.status, 200);
    assert.deepEqual([edit.json.added, edit.json.updated, edit.json.removed, edit.json.list.count], [1, 2, 1, 4]);
    assert.deepEqual(await suggest('CRA?E', sean), [['CRATE', 95], ['CRANE', 80]]);
    assert.deepEqual(await suggest('ICECREA?', sean), [['ICECREAM', 65]]);

    // pages: plain letters find words containing them; ? and * are patterns
    const page = async (q) => (await call('GET', `word-lists/${id}/words?${q}`, null, sean)).json;
    assert.deepEqual((await page('')).words, [['CRANE', 80], ['CRATE', 95], ['ICECREAM', 65], ['PLATE', 70]]);
    assert.deepEqual((await page('match=ra')).words.map(([w]) => w), ['CRANE', 'CRATE']);
    assert.deepEqual((await page('match=%3FLATE')).words, [['PLATE', 70]]);
    assert.deepEqual((await page('match=C*E')).words.map(([w]) => w), ['CRANE', 'CRATE']);
    const best = await page('sort=best&limit=2&offset=1');
    assert.deepEqual([best.total, best.words], [4, [['CRANE', 80], ['PLATE', 70]]]);

    // the file other programs read
    const file = await call('GET', `word-lists/${id}/file`, null, sean);
    assert.equal(file.text, 'CRANE;80\nCRATE;95\nICECREAM;65\nPLATE;70\n');
    assert.match(file.headers.get('content-disposition'), /attachment; filename="Broda list.txt"/);

    // one word, everywhere it is
    const look = (await call('GET', 'word-lists/lookup?word=crate', null, sean)).json;
    assert.deepEqual([look.word, look.score, look.site, look.lists.map((l) => [l.name, l.score])], ['CRATE', 95, 40, [['Broda list', 95]]]);
    assert.equal((await call('GET', 'word-lists/lookup?word=x', null, sean)).status, 400);

    // turned off, the list stops counting; renaming keeps it
    const off = await call('POST', `word-lists/${id}`, { enabled: false, name: 'Broda' }, sean);
    assert.deepEqual([off.json.list.enabled, off.json.list.name], [false, 'Broda']);
    assert.deepEqual(await suggest('CRA?E', sean), [['CRANE', 90], ['CRATE', 40]]);
    await call('POST', `word-lists/${id}`, { enabled: true }, sean);

    // without the site's list: only their own words
    assert.equal((await call('POST', 'word-lists/prefs', { use_site: 'no' }, sean)).status, 400);
    assert.deepEqual((await call('POST', 'word-lists/prefs', { use_site: false }, sean)).json, { use_site: false });
    assert.deepEqual(await suggest('????E', sean), [['CRATE', 95], ['CRANE', 80], ['PLATE', 70]]);
    assert.equal((await call('POST', 'words/counts', { patterns: ['DKRY'] }, sean)).json.counts[0], 0, 'the fixtures’ answers are gone');
    await call('POST', 'word-lists/prefs', { use_site: true }, sean);
    assert.equal((await call('POST', 'words/counts', { patterns: ['DKRY'] }, sean)).json.counts[0], 1);

    // a second list hides what the first scores; deleting it brings it back
    const second = await call('POST', 'word-lists', { name: 'Nope', set: ['plate', ['crane', 0]], score: 0 }, sean);
    assert.equal(second.json.list.count, 2);
    assert.deepEqual(await suggest('CRA?E', sean), [['CRATE', 95]]);
    assert.deepEqual(await suggest('?LATE', sean), []);
    assert.equal((await call('POST', 'word-lists', { name: ' ', text: '' }, sean)).json.list.name, 'My words', 'a name by default');
    assert.equal((await call('POST', `word-lists/${id}`, { name: '   ' }, sean)).status, 400);
    assert.deepEqual((await call('DELETE', `word-lists/${second.json.list.id}`, null, sean)).json, { deleted: true });
    assert.deepEqual(await suggest('CRA?E', sean), [['CRATE', 95], ['CRANE', 80]]);
    assert.deepEqual(await suggest('?LATE', sean), [['PLATE', 70]]);
    assert.deepEqual((await call('GET', 'word-lists', null, sean)).json.lists.map((l) => [l.name, l.count]), [['Broda', 4], ['My words', 0]]);

    // a big file (more lines than a function call takes arguments)
    const letters = (k) => [...k.toString(26)].map((c) => String.fromCharCode(65 + parseInt(c, 26))).join('');
    const big = Array.from({ length: 200_000 }, (_, k) => `QZX${letters(k)};${k % 61}`);
    const bigList = await call('POST', 'word-lists', { name: 'Big', text: big.join('\n') }, devon);
    assert.equal(bigList.status, 201);
    assert.equal(bigList.json.list.count, 200_000);
    assert.equal((await call('POST', 'words/counts', { patterns: ['QZXBAAA'] }, devon)).json.counts[0], 1);

    // a site list rebuilt under them keeps their words on top
    await words.build();
    assert.deepEqual(await suggest('CRA?E', sean), [['CRATE', 95], ['CRANE', 80]]);

    // after all those edits patched into sean's view, it's what a fresh build gives
    const patterns = ['?????', '????', '???', 'C????', '?????E?', 'ICECREAM', 'ZEBRACROSSIN?'];
    const before = await Promise.all(patterns.map((p) => call('POST', 'words/suggest', { pattern: p, limit: 200 }, sean)));
    assert.ok(store.wordLists(users[0].id).length && words.views.get(users[0].id).index.patch.size, 'the view was patched');
    words.wordsChanged(users[0].id, null);
    const after = await Promise.all(patterns.map((p) => call('POST', 'words/suggest', { pattern: p, limit: 200 }, sean)));
    assert.equal(words.views.get(users[0].id).index.patch.size, 0, 'and now built afresh');
    assert.deepEqual(after.map((r) => r.json), before.map((r) => r.json));
    // the sizes kept with each list are the real counts
    for (const l of store.db.prepare('SELECT id, size FROM word_lists').all()) {
      assert.equal(l.size, store.db.prepare('SELECT COUNT(*) AS n FROM word_list_entries WHERE list_id = ?').get(l.id).n);
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('word lists store: sizes stay exact, and an edit past the limit changes nothing', () => {
  const { store, users } = setup();
  const list = store.createWordList(users[0].id, 'Mine', new Map([['CAT', 50], ['DOG', 0]]));
  assert.equal(list.count, 2);
  const r = store.editWordList(list.id, { set: new Map([['CAT', 70], ['EMU', 10], ['GNU', 20]]), remove: ['DOG', 'YAK'] });
  assert.deepEqual(r, { added: 2, removed: 1, size: 3, tooBig: false });
  const before = store.wordList(list.id);
  const over = store.editWordList(list.id, { set: new Map([['OWL', 5], ['CAT', 1]]), maxSize: 3 });
  assert.equal(over.tooBig, true);
  assert.equal(over.size, 4);
  assert.deepEqual(store.wordList(list.id), before, 'rolled back, edit time and all');
  assert.deepEqual([...store.wordListEntries(list.id)], [['CAT', 70], ['EMU', 10], ['GNU', 20]]);
  // a rescore at the limit is fine: it adds nothing
  assert.equal(store.editWordList(list.id, { set: new Map([['CAT', 1]]), maxSize: 3 }).tooBig, false);
  assert.equal(store.ownWordCount(users[0].id), 3);
  store.createWordList(users[0].id, 'Off', new Map([['CAT', 0], ['OWL', 9]]));
  store.updateWordList(store.wordLists(users[0].id)[1].id, { enabled: false });
  assert.equal(store.ownWordCount(users[0].id), 5, 'lists that are off count toward the limit too');
  assert.deepEqual([...store.ownWords(users[0].id)], [['CAT', 1], ['EMU', 10], ['GNU', 20]], 'but not toward suggestions');
  assert.deepEqual([...store.ownScores(users[0].id, ['CAT', 'OWL', 'ZZZ'])], [['CAT', 1], ['OWL', null], ['ZZZ', null]]);
  assert.deepEqual([...store.ownWords(users[1].id)], [], 'nobody else’s');
});
