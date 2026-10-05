#!/usr/bin/env node
/*
 * seed-demo.mjs — fill a scratch data dir with made-up solvers and a few
 * months of solves, for developing and screenshotting the stats pages.
 *
 * Solves are played through the real Hub on a simulated clock (thinking
 * per entry, typing, typos fixed by crossings or in a final hunt, pauses,
 * checks and reveals, co-op turn-taking), so they carry event logs and
 * summaries exactly like real ones. Solves before LOG_START are
 * summary-only, like solves from before logging began.
 *
 *   XWORD_DATA_DIR=<scratch dir> node server/tools/seed-demo.mjs [--seed N] [--force]
 *
 * It also makes a few custom puzzles (the builder's kind): one by two
 * co-authors for everyone, one shared with two people, and a draft, with
 * solves, ratings and notes.
 *
 * Every account's password is `test-pass-1`. Refuses to touch a database
 * that already has accounts (unless --force), and always refuses the
 * default server/data.
 */

import path from 'node:path';
import { Store, newId } from '../db.mjs';
import { Hub } from '../rooms.mjs';
import { Puzzles } from '../puzzles.mjs';
import { hashPassword } from '../auth.mjs';
import { SERVER_DIR, SITE_DIR } from '../config.mjs';
import { newProgress } from '../../js/state.js';
import { MARK_WRONG, MARK_REVEALED, MARK_PENCIL } from '../../js/engine.js';
import { parsePuzzleId, weekdayOf } from '../../js/util.js';
import { mulberry32 } from '../../js/stats-math.js';
import { CUSTOM_PREFIX, normalizeDoc, publishedCopy, puzzleFeatures, modelOf as customModel } from '../../js/custom-puzzle.js';
import { listNames } from '../../js/people.js';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 ? args[k + 1] : dflt;
};

const dataDir = process.env.XWORD_DATA_DIR;
if (!dataDir || path.resolve(dataDir) === path.resolve(SERVER_DIR, 'data')) {
  console.error('Set XWORD_DATA_DIR to a scratch directory (never the real server/data).');
  process.exit(2);
}

// ---------- a clock we control (nowIso() and the Hub both read it) ----------
const RealDate = Date;
let clock = RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(clock);
  }
  static now() {
    return clock;
  }
};
const REAL_NOW = RealDate.now();

const rand = mulberry32(Number(opt('seed', 11)));
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const weighted = (items, weight) => {
  const ws = items.map(weight);
  let r = rand() * ws.reduce((s, w) => s + w, 0);
  for (let k = 0; k < items.length; k++) if ((r -= ws[k]) <= 0) return items[k];
  return items[items.length - 1];
};

const DAY = 86400000;
const WINDOW_START = new RealDate(2026, 6, 1).getTime(); // July 1, local
const LOG_START = new RealDate(2026, 7, 22).getTime(); // solves before this have no log

// skill: time multiplier (lower is faster); trend: fraction faster per month
const PEOPLE = [
  { name: 'sean', display: 'Sean', admin: true, skill: 0.85, err: 0.03, hours: [21, 24], dayOf: 0.7, trend: 0.05, assists: 0.06, pencil: 0,
    types: { daily: 0.85, mini: 0.9, midi: 0.6, bonus: 0.5 } },
  { name: 'devon', display: 'Devon', skill: 0.62, err: 0.02, hours: [6, 9], dayOf: 0.85, trend: 0.01, assists: 0.02, pencil: 0,
    types: { daily: 0.95, mini: 0.95, midi: 0.8, bonus: 0.3 } },
  { name: 'kam', display: 'Kam', skill: 1.0, err: 0.045, hours: [12, 14], dayOf: 0.4, trend: 0.03, assists: 0.15, pencil: 0.02,
    types: { daily: 0.6, mini: 0.9, midi: 0.5, bonus: 0.15 } },
  { name: 'tom', display: 'Tom', skill: 1.35, err: 0.06, hours: [19, 24], dayOf: 0.3, trend: 0.12, assists: 0.3, pencil: 0,
    types: { daily: 0.45, mini: 0.7, midi: 0.35 } },
  { name: 'ctrekker', display: 'C. Trekker', skill: 0.75, err: 0.025, hours: [10, 17], dayOf: 0.6, trend: 0.02, assists: 0.04, pencil: 0,
    types: { daily: 0.7, mini: 0.5, midi: 0.7, bonus: 0.6 }, workdays: true },
  { name: 'maya', display: 'Maya', skill: 1.7, err: 0.07, hours: [8, 22], dayOf: 0.2, trend: 0.06, assists: 0.45, pencil: 0.12,
    types: { daily: 0.25, mini: 0.8, midi: 0.25 } },
];

// typical seconds for an average solver, Sunday..Saturday
const BASE = {
  daily: [35, 7, 9, 12, 18, 21, 27].map((m) => m * 60),
  mini: [80, 45, 45, 50, 50, 55, 120],
  midi: [300, 210, 220, 240, 250, 260, 330],
  bonus: [1500, 1500, 1500, 1500, 1500, 1500, 1500],
};

// each puzzle has one difficulty everyone feels, so people's times correlate
const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const difficulty = (id) => Math.exp(0.22 * mulberry32Gauss(hash(id)));
function mulberry32Gauss(seed) {
  const r = mulberry32(seed);
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function targetSeconds(person, p, when) {
  const base = BASE[p.type]?.[p.weekday ?? 0] ?? 900;
  const months = Math.max(0, (when - WINDOW_START) / (30 * DAY));
  return base * person.skill * difficulty(p.id) * Math.exp(0.18 * gauss()) * Math.exp(-person.trend * months);
}

/** When `person` starts the puzzle dated `date` (or null: skip). */
function startTime(person, date) {
  const pubDay = date ? new RealDate(`${date}T00:00:00`).getTime() : null;
  let day;
  if (pubDay != null && pubDay >= WINDOW_START) {
    const lag = rand() < person.dayOf ? 0 : Math.min(40, Math.ceil(-Math.log(rand() + 1e-9) * 6));
    day = pubDay + lag * DAY;
  } else {
    day = WINDOW_START + Math.floor(rand() * ((REAL_NOW - WINDOW_START) / DAY)) * DAY; // an archive puzzle, any day
  }
  if (person.workdays) {
    while ([0, 6].includes(new RealDate(day).getDay())) day += DAY;
  }
  const [h0, h1] = person.hours;
  const at = day + (h0 + rand() * (h1 - h0)) * 3600_000;
  return at < REAL_NOW - 3600_000 ? at : null;
}

// ---------- the playing ----------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const otherLetter = (right) => {
  let c;
  do c = pick([...'EAIOTRSNLCUDPMHG'.repeat(2), ...LETTERS]);
  while (c === right[0]);
  return c;
};

/**
 * Play one solve through the hub. `members` are {user, person}. With
 * `stopAt` (0..1) the solver leaves once that much is filled.
 */
async function play(hub, model, { puzzleId, solveId = null, members, startAt, target, stopAt = null }) {
  clock = startAt;
  const cs = members.map((m) => ({ ...m, conn: hub.connect(m.user, () => {}), op: 1, letterMs: 220 + 300 * m.person.skill ** 0.5 }));
  for (const c of cs) await hub.handle(c.conn, solveId ? { type: 'join', solve: solveId } : { type: 'join', puzzle: puzzleId });
  const room = cs[0].conn.room;
  const rec = () => room.record;
  const sol = (i) => model.cells[i].solution.toUpperCase();
  const open = model.cells.filter((c) => !c.isBlack).map((c) => c.index);
  const send = (c, msg) => hub.handle(c.conn, msg);
  const typeCell = (c, i, fill, dir, marks = 0) => send(c, { type: 'cells', opId: c.op++, dir, changes: [{ i, fill, marks }] });
  const errors = new Set();
  const solveMs = () => room.elapsed() * 1000;

  for (const c of cs) {
    await send(c, { type: 'cursor', index: model.clueOrder[0].cells[0], dir: 'A' });
    await send(c, { type: 'active', on: true });
    clock += 500 + rand() * 4000;
  }

  const words = model.clueOrder;
  const think = new Map(words.map((w) => [w.id, (-Math.log(rand() + 1e-9) + 0.2) * (0.5 + w.cells.length / 7)]));
  const targetMs = target * 1000;
  const huntShare = 0.02 + rand() * 0.08;
  const pauseAt = rand() < 0.18 ? 0.2 + rand() * 0.6 : null;
  let paused = false;
  const revealOnce = rand() < members[0].person.assists * 0.4;
  // co-op: each person keeps to a neighbourhood of the grid
  const home = new Map(cs.map((c, k) => [c.user.name, k / cs.length]));

  const empty = () => open.filter((i) => rec().fill[i] === '');
  while (empty().length && !rec().completed) {
    const left = empty();
    if (stopAt != null && 1 - left.length / open.length >= stopAt) break;
    if (pauseAt != null && !paused && 1 - left.length / open.length >= pauseAt) {
      paused = true;
      for (const c of cs) await send(c, { type: 'active', on: false });
      clock += (5 + rand() * 240) * 60_000;
      for (const c of cs) await send(c, { type: 'active', on: true });
    }
    const c = cs.length > 1 ? weighted(cs, (x) => 1 / x.person.skill) : cs[0];
    const cands = words.filter((w) => w.cells.some((i) => rec().fill[i] === ''));
    // most people start at 1-Across (or 1-Down); after that, anywhere near what's filled
    const first = left.length === open.length && rand() < 0.75 ? cands.find((x) => x.num === 1) : null;
    const w = first ?? weighted(cands, (x) => {
      const crossing = x.cells.some((i) => rec().fill[i] !== '') ? 3 : 1;
      const where = cs.length > 1 ? 1 + 3 * (1 - Math.abs(x.cells[0] / model.cells.length - home.get(c.user.name))) : 1;
      return (crossing * where) / think.get(x.id);
    });
    await send(c, { type: 'cursor', index: w.cells.find((i) => rec().fill[i] === ''), dir: w.dir });
    // hunting time is only held back while there are typos to hunt
    const remainingThink = Math.max(0, targetMs * (1 - (errors.size ? huntShare : 0)) - solveMs() - left.length * c.letterMs);
    const pool = cands.reduce((s, x) => s + think.get(x.id), 0);
    clock += remainingThink * (think.get(w.id) / pool) * (cs.length > 1 ? 0.8 : 1);

    if (revealOnce && rand() < 0.05) {
      const i = w.cells.find((k) => rec().fill[k] === '');
      if (i != null) {
        await send(c, { type: 'assist', kind: 'reveal', scope: 'letter', index: i, dir: w.dir });
        await typeCell(c, i, sol(i), w.dir, MARK_REVEALED);
        clock += 1500;
      }
    }
    for (const i of w.cells) {
      const cur = rec().fill[i];
      if (cur === sol(i)) continue;
      if (cur !== '' && rand() < 0.2) continue; // didn't notice a wrong crossing letter
      const wrong = rand() < c.person.err;
      const v = wrong ? otherLetter(sol(i)) : sol(i);
      await typeCell(c, i, v, w.dir, rand() < c.person.pencil ? MARK_PENCIL : 0);
      await send(c, { type: 'cursor', index: i, dir: w.dir });
      clock += c.letterMs * (0.6 + rand() * 0.8);
      if (wrong) errors.add(i);
      else errors.delete(i);
    }
  }

  // the typo hunt: the grid is full but not right
  if (stopAt == null) {
    let guard = 0;
    while (!rec().completed && guard++ < 20) {
      const wrong = open.filter((i) => rec().fill[i] !== sol(i));
      const c = pick(cs);
      if (!wrong.length) break;
      if (rand() < c.person.assists) {
        await send(c, { type: 'assist', kind: 'check', scope: 'puzzle', index: wrong[0], dir: 'A' });
        for (const i of wrong) if (rec().fill[i]) await typeCell(c, i, rec().fill[i], 'A', MARK_WRONG);
        clock += 2000;
      }
      for (const i of wrong) {
        clock += (targetMs * huntShare) / wrong.length * (0.5 + rand());
        const dir = model.cells[i].across ? 'A' : 'D';
        await send(c, { type: 'cursor', index: i, dir });
        await typeCell(c, i, sol(i), dir);
      }
    }
  }
  for (const c of cs) hub.disconnect(c.conn);
  return room.record.completed;
}

// ---------- main ----------

async function main() {
  const store = new Store(path.join(dataDir, 'crossword.db'));
  if (store.listUsers().length && !flag('force')) {
    console.error(`${dataDir} already has accounts; use --force to add to it anyway.`);
    process.exit(2);
  }
  const puzzles = new Puzzles({ puzzlesDir: path.join(SITE_DIR, 'puzzles') }, { store, log: { info() {}, error: console.error } });
  const hub = new Hub({ store, puzzles, now: () => clock, flushMs: 1e8, log: { info() {}, error: console.error } });

  clock = WINDOW_START - 30 * DAY;
  const pw = hashPassword('test-pass-1');
  const users = new Map();
  for (const p of PEOPLE) {
    const u = store.userByName(p.name) ?? store.createUser({ name: p.name, displayName: p.display, pwHash: pw, isAdmin: !!p.admin });
    users.set(p.name, u);
  }

  const index = JSON.parse(readFileSync(path.join(SITE_DIR, 'puzzles', 'index.json'), 'utf8')).puzzles;
  const catalog = index
    .map((e) => ({ ...e, ...parsePuzzleId(e.id) }))
    .filter((e) => BASE[e.type])
    .map((e) => ({ ...e, weekday: e.date ? weekdayOf(e.date) : null }));

  // who solves what, and when
  const plan = [];
  for (const person of PEOPLE) {
    for (const p of catalog) {
      if (rand() > (person.types[p.type] ?? 0)) continue;
      const at = startTime(person, p.date);
      if (at == null) continue;
      plan.push({ person, p, at });
    }
  }
  plan.sort((a, b) => a.at - b.at);

  let logged = 0;
  let old = 0;
  let unfinished = 0;
  const models = new Map();
  const modelOf = async (id) => {
    if (!models.has(id)) models.set(id, await puzzles.model(id));
    return models.get(id);
  };
  for (const { person, p, at } of plan) {
    const user = users.get(person.name);
    const target = targetSeconds(person, p, at);
    if (at < LOG_START) {
      const checked = rand() < person.assists;
      const revealed = rand() < person.assists * 0.4;
      store.recordSoloSolve(user.id, p.id, {
        seconds: Math.round(target),
        completed_at: new RealDate(at + target * 1000 + rand() * 60_000).toISOString(),
        clean: !checked && !revealed,
        used_check: checked,
        used_reveal: revealed,
      });
      old++;
      continue;
    }
    const model = await modelOf(p.id);
    if (!model || model.puz.scrambled) continue;
    const stopAt = rand() < 0.05 ? 0.2 + rand() * 0.6 : null;
    await play(hub, model, { puzzleId: p.id, members: [{ user, person }], startAt: at, target, stopAt });
    if (stopAt != null) unfinished++;
    else logged++;
  }

  // co-op evenings
  let coop = 0;
  const coopPool = catalog.filter((p) => ['daily', 'midi'].includes(p.type) && p.date >= '2026-08-20');
  for (let k = 0; k < 22; k++) {
    const size = rand() < 0.7 ? 2 : 3;
    const people = [...PEOPLE].sort(() => rand() - 0.5).slice(0, size);
    const p = pick(coopPool);
    const model = await modelOf(p.id);
    if (!model) continue;
    const at = Math.min(REAL_NOW - 2 * 3600_000, new RealDate(`${p.date}T00:00:00`).getTime() + Math.floor(rand() * 5) * DAY + (19 + rand() * 3) * 3600_000);
    clock = at;
    const memberUsers = people.map((x) => users.get(x.name));
    const solve = store.createSolve({
      puzzleId: p.id,
      kind: 'coop',
      createdBy: memberUsers[0].id,
      memberIds: memberUsers.map((u) => u.id),
      record: newProgress(model, p.id, 'coop'),
    });
    const target = Math.min(...people.map((x) => targetSeconds(x, p, at))) * (0.55 + rand() * 0.35);
    await play(hub, model, { puzzleId: p.id, solveId: solve.id, members: people.map((x) => ({ user: users.get(x.name), person: x })), startAt: at, target });
    coop++;
  }

  const made = await seedCustom(store, hub, users, modelOf);

  hub.flushAll();
  store.close();
  console.log(`Seeded ${PEOPLE.length} people: ${logged} logged solo solves, ${old} older summary-only, ${unfinished} unfinished, ${coop} co-op.`);
  console.log(`Custom puzzles: ${made}.`);
  console.log('Password for every account: test-pass-1');
}

// ---------- puzzles people made here ----------

const CUSTOM = [
  {
    title: 'Heart to Heart',
    authors: ['devon', 'kam'],
    rows: ['HEART', 'EMBER', 'ABUSE', 'RESIN', 'TREND'],
    clues: {
      A0: 'Ticker', A5: 'Glowing bit of a campfire', A10: 'Misuse', A15: 'Sticky stuff from a pine', A20: 'Fashion direction',
      D0: 'Valentine shape', D1: 'Fireplace leftover', D2: 'Mistreat', D3: 'Amber, once', D4: 'What’s hot',
    },
    notes: 'A word square: the Downs are the Acrosses.',
    daysAgo: 12,
    reviews: [[5, 'A word square! Took me a minute to notice.'], [4, ''], [4, 'Cute theme.']],
  },
  {
    title: 'Inside Jokes',
    authors: ['sean'],
    rows: ['CARD', 'AREA', 'REAR', 'DART'],
    clues: {
      A0: 'Birthday greeting', A4: 'Zone', A8: 'Back', A12: 'Pub missile',
      D0: 'Deck member', D1: 'Region', D2: 'Hind', D3: 'Bullseye seeker',
    },
    share: ['devon', 'maya'],
    daysAgo: 4,
    reviews: [[5, 'Ha, the pub one.']],
  },
];

/** A few custom puzzles, published and played through the Hub like everything else. */
async function seedCustom(store, hub, users, modelOf) {
  const nameOf = (n) => users.get(n).display_name;
  let published = 0;
  for (const c of CUSTOM) {
    clock = REAL_NOW - (c.daysAgo + 3) * DAY;
    const [first, ...others] = c.authors.map((n) => users.get(n));
    const doc = normalizeDoc({
      width: c.rows[0].length,
      height: c.rows.length,
      grid: c.rows.join('').split(''),
      clues: c.clues,
      title: c.title,
      byline: listNames(c.authors.map(nameOf)),
      notes: c.notes ?? '',
      symmetry: 'none',
    });
    const id = CUSTOM_PREFIX + newId(6);
    store.createCustomPuzzle({ id, createdBy: first.id, doc });
    store.addCustomAuthors(id, others.map((u) => u.id));
    clock = REAL_NOW - c.daysAgo * DAY;
    const copy = publishedCopy(doc);
    store.publishCustomPuzzle(id, { published: copy, features: puzzleFeatures(customModel(copy)) });
    if (c.share) store.setCustomSharing(id, 'people', c.share.map((n) => users.get(n).id));
    published++;

    // everyone it's out to has a go over the next few days; some say what they thought
    const model = await modelOf(id);
    const solvers = PEOPLE.filter((p) => !c.authors.includes(p.name) && (!c.share || c.share.includes(p.name)));
    const reviews = [...c.reviews];
    for (const person of solvers) {
      if (rand() < 0.2) continue;
      const at = REAL_NOW - c.daysAgo * DAY + rand() * (c.daysAgo - 0.5) * DAY;
      const target = 25 * c.rows.length * person.skill * Math.exp(0.25 * gauss());
      const user = users.get(person.name);
      await play(hub, model, { puzzleId: id, members: [{ user, person }], startAt: at, target });
      const review = reviews.shift();
      if (review) {
        clock += 60_000;
        store.saveFeedback(id, user.id, { stars: review[0], comment: review[1] });
      }
    }
  }

  // a draft, half done
  clock = REAL_NOW - 2 * DAY;
  const tom = users.get('tom');
  const draft = normalizeDoc({
    width: 5,
    height: 5,
    grid: ['S', 'T', 'A', 'R', '.', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '.', '', '', '', ''],
    clues: { A0: 'Twinkler' },
    title: 'Work in progress',
    byline: nameOf('tom'),
  });
  store.createCustomPuzzle({ id: CUSTOM_PREFIX + newId(6), createdBy: tom.id, doc: draft });
  return `${published} published, 1 draft`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
