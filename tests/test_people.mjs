/* Tests for showing many people: js/people.js (name lists, distinct
 * colors, picker order), account colors and co-op partners in the store,
 * per-solve colors in live rooms, and last_together in GET /api/users. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { USER_PALETTE, distinctColors, listNames, byDisplayName, pickerGroups } from '../js/people.js';
import { parsePuz } from '../js/puz.js';
import { PuzzleModel } from '../js/model.js';
import { newProgress } from '../js/state.js';
import { Store } from '../server/db.mjs';
import { hashPassword } from '../server/auth.mjs';
import { Hub } from '../server/rooms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const model = new PuzzleModel(parsePuz(readFileSync(path.join(here, 'fixtures', 'fixture15.puz'))));
const PUZZLE = '2026-01-01';
const quiet = { info() {}, error() {} };

test('people: listNames folds long lists into a count', () => {
  assert.equal(listNames([]), '');
  assert.equal(listNames(['Devon']), 'Devon');
  assert.equal(listNames(['Devon', 'Kam']), 'Devon and Kam');
  assert.equal(listNames(['Devon', 'Kam', 'Tom']), 'Devon, Kam and Tom');
  assert.equal(listNames(['A', 'B', 'C', 'D', 'E'], 3), 'A, B and 3 others');
  assert.equal(listNames(['A', 'B', 'C'], 2), 'A and 2 others');
  assert.equal(listNames(['A', 'B', 'C'], 3), 'A, B and C', 'fits: listed in full');
  assert.equal(listNames(['A', 'B', 'C', 'D'], 3), 'A, B and 2 others');
  assert.equal(listNames(['A', 'B'], 1), 'A and B', 'never "and 1 other"');
});

test('people: distinctColors keeps own colors and separates shared ones', () => {
  const [blue, orange, green, pink] = USER_PALETTE;
  const colors = distinctColors([
    { name: 'sean', color: blue },
    { name: 'zoe', color: blue }, // shares sean's
    { name: 'kam', color: orange },
    { name: 'amy', color: orange }, // shares kam's
  ]);
  assert.equal(colors.get('sean'), blue);
  assert.equal(colors.get('kam'), orange);
  assert.equal(colors.get('zoe'), green, 'first palette color nobody here uses');
  assert.equal(colors.get('amy'), pink);
  assert.equal(new Set(colors.values()).size, 4);
});

test('people: distinctColors with keep never repaints people already shown', () => {
  const people = Array.from({ length: 12 }, (_, k) => ({
    name: `p${k}`,
    color: USER_PALETTE[(k * 3) % 5], // lots of sharing
  }));
  const before = distinctColors(people.slice(0, 6));
  const after = distinctColors(people, { keep: before });
  for (const [name, color] of before) assert.equal(after.get(name), color, name);
  // up to the palette's size everyone differs; past it colors repeat
  assert.equal(new Set([...after.values()].slice(0, USER_PALETTE.length)).size, USER_PALETTE.length);
  assert.equal(after.size, 12);

  // someone leaving doesn't recolor the rest either
  const fewer = distinctColors(people.slice(1, 6), { keep: after });
  for (const [name, color] of fewer) assert.equal(color, after.get(name), name);
});

test('people: picker order puts recent co-op partners first, then A-Z', () => {
  const users = [
    { name: 'zed', display_name: 'Zed', last_together: null },
    { name: 'amy', display_name: 'amy', last_together: '2026-09-01T00:00:00Z' },
    { name: 'bob', display_name: 'Bob', last_together: '2026-09-20T00:00:00Z' },
    { name: 'cal', display_name: 'Cal', last_together: null },
    { name: 'dee', display_name: 'Dee', last_together: '2026-08-01T00:00:00Z' },
  ];
  const { recent, rest } = pickerGroups(users, 2);
  assert.deepEqual(recent.map((u) => u.name), ['bob', 'amy']);
  assert.deepEqual(rest.map((u) => u.name), ['cal', 'dee', 'zed'], 'older partners join the A-Z list');
  assert.deepEqual([...users].sort(byDisplayName).map((u) => u.name), ['amy', 'bob', 'cal', 'dee', 'zed'], 'case-insensitive');
});

test('store: new accounts get the least-used color', () => {
  const store = new Store(':memory:');
  const make = (name) => store.createUser({ name, pwHash: 'x' });
  const first = USER_PALETTE.map((_, k) => make(`u${k}`));
  assert.deepEqual(first.map((u) => u.color), USER_PALETTE, 'the palette in order');
  const ninth = make('u8');
  assert.equal(ninth.color, USER_PALETTE[0], 'then around again');
  store.deleteUser(first[3].id);
  assert.equal(make('u9').color, USER_PALETTE[3], 'a deleted account frees its color');
});

test('store: coopPartners says when you last solved with each person', () => {
  const store = new Store(':memory:');
  const [sean, devon, kam, tom] = ['sean', 'devon', 'kam', 'tom'].map((name) => store.createUser({ name, pwHash: 'x' }));
  const solve = (kind, members, at) => {
    const record = { ...newProgress(model, PUZZLE, 'coop'), updated_at: at };
    const s = store.createSolve({ puzzleId: PUZZLE, kind, createdBy: members[0].id, memberIds: members.map((m) => m.id), record, ownerId: kind === 'solo' ? members[0].id : null });
    store.saveRecord(s.id, record);
  };
  solve('coop', [sean, devon], '2026-09-01T00:00:00.000Z');
  solve('coop', [sean, devon, kam], '2026-09-10T00:00:00.000Z');
  solve('coop', [devon, tom], '2026-09-20T00:00:00.000Z'); // sean isn't in it
  solve('solo', [tom], '2026-09-25T00:00:00.000Z');
  const partners = store.coopPartners(sean.id);
  assert.equal(partners.get(devon.id), '2026-09-10T00:00:00.000Z', 'the most recent shared solve');
  assert.equal(partners.get(kam.id), '2026-09-10T00:00:00.000Z');
  assert.equal(partners.has(tom.id), false);
  assert.equal(partners.has(sean.id), false);
});

test('rooms: co-op members who share an account color get distinct ones', async () => {
  const store = new Store(':memory:');
  const hub = new Hub({ store, puzzles: { model: async () => model }, flushMs: 60_000, log: quiet });
  // ten accounts: the 9th and 10th (amy, bo) repeat the first two colors
  const names = ['zed', 'yan', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'amy', 'bo'];
  const u = Object.fromEntries(names.map((name) => [name, store.createUser({ name, pwHash: 'x' })]));
  assert.equal(u.amy.color, u.zed.color);
  assert.equal(u.bo.color, u.yan.color);
  const coop = store.createSolve({
    puzzleId: PUZZLE, kind: 'coop', createdBy: u.amy.id, memberIds: [u.amy.id, u.zed.id], record: newProgress(model, PUZZLE, 'coop'),
  });
  const inbox = [];
  const conn = hub.connect(u.amy, (msg) => inbox.push(structuredClone(msg)));
  await hub.handle(conn, { type: 'join', solve: coop.id });
  const snap = inbox.find((m) => m.type === 'snapshot');
  const color = new Map(snap.solve.members.map((m) => [m.name, m.color]));
  assert.equal(color.get('zed'), u.zed.color, 'the older account keeps the shared color');
  assert.notEqual(color.get('amy'), u.zed.color);
  assert.equal(snap.presence[0].color, color.get('amy'), 'cursors use the same color');

  // adding people never recolors the ones already there
  store.addMembers(coop.id, [u.yan.id, u.bo.id]);
  inbox.length = 0;
  hub.membersChanged(coop.id);
  const members = inbox.find((m) => m.type === 'members').members;
  const after = new Map(members.map((m) => [m.name, m.color]));
  assert.equal(after.get('zed'), color.get('zed'));
  assert.equal(after.get('amy'), color.get('amy'));
  assert.equal(new Set(after.values()).size, 4, 'all four differ');
  hub.disconnect(conn);
});

test('api: /api/users says when you last solved with each person', async () => {
  const { createServer } = await import('../server/server.mjs');
  const store = new Store(':memory:');
  const sean = store.createUser({ name: 'sean', pwHash: hashPassword('sean-pass-1') });
  const devon = store.createUser({ name: 'devon', pwHash: hashPassword('devon-pass-1') });
  store.createUser({ name: 'kam', pwHash: 'x' });
  const record = { ...newProgress(model, PUZZLE, 'coop'), updated_at: '2026-09-10T00:00:00.000Z' };
  const s = store.createSolve({ puzzleId: PUZZLE, kind: 'coop', createdBy: sean.id, memberIds: [sean.id, devon.id], record });
  store.saveRecord(s.id, record);
  const cfg = {
    puzzlesDir: path.join(here, 'fixtures'), sessionDays: 30, trustProxy: false,
    clientIpHeader: null, secureCookies: false, publicUrl: null,
  };
  const { server } = createServer(cfg, { store, puzzles: { model: async () => null }, hub: new Hub({ store, puzzles: {}, log: quiet }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  try {
    const login = await fetch(base + 'login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sean', password: 'sean-pass-1' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { users } = await (await fetch(base + 'users', { headers: { Cookie: cookie } })).json();
    const by = Object.fromEntries(users.map((u) => [u.name, u]));
    assert.equal(by.devon.last_together, '2026-09-10T00:00:00.000Z');
    assert.equal(by.kam.last_together, null);
    assert.equal(by.sean.last_together, null);
    assert.equal(by.devon.pw_hash, undefined, 'still only public fields');
  } finally {
    server.close();
  }
});
