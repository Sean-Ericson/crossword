/*
 * api.mjs — JSON REST endpoints under /api. Everything except login needs
 * a session. State-changing calls must send Content-Type: application/json,
 * which a cross-site form can't do without a CORS preflight we never grant;
 * together with SameSite=Lax cookies that keeps CSRF out.
 */

import {
  verifyPassword,
  hashPassword,
  validatePassword,
  tempPassword,
  startSession,
  sessionCookie,
  clearedCookie,
  userFromRequest,
  publicUser,
  parseCookies,
  hashToken,
  SESSION_COOKIE,
} from './auth.mjs';
import { PUZZLE_ID_RE } from './puzzles.mjs';
import { newId } from './db.mjs';
import { mergeProgress, newProgress, recordFitsModel } from '../js/state.js';
import { listNames } from '../js/people.js';
import {
  CUSTOM_PREFIX,
  isCustomId,
  isValidSize,
  emptyDoc,
  normalizeDoc,
  modelOf,
  problems,
  publishedCopy,
  puzzleFeatures,
  sameShape,
} from '../js/custom-puzzle.js';
import { normalizeWord, parseWordList, cleanEntries, clampScore } from '../js/words.js';
import { MAX_PATCH } from './words.mjs';

const MAX_DRAFTS = 50; // per person
const PATTERN_RE = /^[A-Z?]{2,25}$/; // a word's squares: letters, ? for blanks
const MAX_WORD_LISTS = 30; // per person
const MAX_LIST_WORDS = 1_000_000; // per list (Peter Broda's list is about 600,000)
const MAX_OWN_WORDS = 2_000_000; // per person, all their lists together
const MAX_LIST_UPLOAD = 32_000_000; // bytes of JSON carrying a list file

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

async function readJson(req, limit = 2_000_000) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Bad JSON.');
  }
}

/** The visitor's address (for the login limiter), as the proxy reports it. */
export function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const direct = cfg.clientIpHeader && req.headers[cfg.clientIpHeader.toLowerCase()];
    if (direct) return String(direct).trim();
    const fwd = req.headers['x-forwarded-for'];
    // the proxy appends the address it saw; earlier entries are client-supplied
    if (fwd) return fwd.split(',').at(-1).trim();
  }
  return req.socket.remoteAddress || '';
}

export function isHttps(req, cfg) {
  return cfg.trustProxy ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted;
}

export function secureCookiesFor(req, cfg) {
  if (cfg.secureCookies !== 'auto') return !!cfg.secureCookies;
  if (cfg.publicUrl?.startsWith('https:')) return true;
  return isHttps(req, cfg);
}

/**
 * Is a WebSocket upgrade coming from one of our own pages? Browsers always
 * send Origin on WebSocket requests; refusing other sites keeps a page
 * elsewhere from riding a visitor's session cookie. Accepted: the Host the
 * request arrived with, the proxy's X-Forwarded-Host, and publicUrl.
 */
export function originAllowed(req, cfg) {
  let host;
  try {
    host = new URL(req.headers.origin).host;
  } catch {
    return false;
  }
  const allowed = [req.headers.host];
  if (cfg.trustProxy && req.headers['x-forwarded-host']) allowed.push(req.headers['x-forwarded-host']);
  if (cfg.publicUrl) allowed.push(new URL(cfg.publicUrl).host);
  return allowed.includes(host);
}

/**
 * @param {{cfg, store, hub, puzzles, limiter, log}} ctx
 */
export function makeApi(ctx) {
  const { cfg, store, hub, puzzles, words, limiter } = ctx;
  const secureFor = (req) => secureCookiesFor(req, cfg);

  const requireAdmin = (user) => {
    if (!user?.is_admin) throw new HttpError(403, 'Only admins can do that.');
  };

  /** A chosen password (validated) or a fresh temporary one. */
  const passwordFromBody = (body) => {
    if (body.password == null || body.password === '') return { password: tempPassword(), generated: true };
    const problem = validatePassword(body.password);
    if (problem) throw new HttpError(400, problem);
    return { password: body.password, generated: false };
  };

  const adminView = (u) => ({ ...publicUser(u), created_at: u.created_at });

  const userByNameOr404 = (name) => {
    const u = store.userByName(String(name || ''));
    if (!u) throw new HttpError(404, `No user “${name}”.`);
    return u;
  };

  const displayOf = (u) => u.display_name || u.name;

  // ----- custom puzzles -----

  /** The puzzle, if this person may see it (its authors: even a draft). */
  const customFor = (id, user, { author = false } = {}) => {
    const p = isCustomId(id) ? store.customPuzzle(id) : null;
    const mine = !!p?.authors.some((a) => a.id === user.id);
    if (!p || (author ? !mine : !mine && !store.canSeePuzzle(user.id, id))) throw new HttpError(404, 'No such puzzle.');
    return { p, mine };
  };

  const namesOf = (ids) => ids.map((id) => store.userById(id)?.name).filter(Boolean);

  /**
   * What lists, the stats page and the breakdown page need about a custom
   * puzzle: an index.json-shaped entry (of the published copy; a draft's
   * working copy for its authors) plus its status, authors and counts.
   */
  const customEntry = (p, user, counts = store.customCounts()) => {
    const mine = p.authors.some((a) => a.id === user.id);
    const doc = p.published ?? p.doc;
    const c = counts[p.id] ?? { solved: 0, solving: 0, stars: null, notes: 0 };
    return {
      id: p.id,
      type: 'custom',
      date: null,
      title: (doc.title ?? '').trim(),
      author: (doc.byline ?? '').trim(),
      width: doc.width,
      height: doc.height,
      ...(p.features ?? {}),
      status: p.status,
      visibility: p.visibility,
      authors: p.authors.map((a) => a.name),
      created_by: p.authors.find((a) => a.id === p.created_by)?.name ?? null,
      mine,
      published_at: p.published_at,
      revised_at: p.revised_at,
      solved: c.solved,
      solving: c.solving,
      stars: c.stars,
      ...(mine
        ? {
            updated_at: p.updated_at,
            changed: p.status !== 'draft' && p.updated_at > (p.revised_at ?? ''),
            notes: c.notes,
            shared_with: p.visibility === 'people' ? namesOf(p.shares) : [],
          }
        : {}),
    };
  };

  /** {visibility: 'everyone'} or {visibility: 'people', people: [names]} */
  const setSharing = (p, body) => {
    const { visibility } = body;
    if (visibility !== 'everyone' && visibility !== 'people') {
      throw new HttpError(400, 'visibility must be "everyone" or "people".');
    }
    const ids =
      visibility === 'people'
        ? [...new Set((body.people || []).map(String))]
            .map((n) => userByNameOr404(n).id)
            .filter((uid) => !p.authors.some((a) => a.id === uid))
        : [];
    store.setCustomSharing(p.id, visibility, ids);
  };

  /**
   * Co-op solves of a custom puzzle: never its authors, never people it
   * isn't shared with, and only while it's published.
   */
  const checkCustomSolvers = (puzzleId, user, people) => {
    if (!isCustomId(puzzleId)) return;
    if (store.customState(puzzleId)?.status !== 'published') {
      throw new HttpError(400, 'That puzzle isn’t taking new solves.');
    }
    if (people.some((u) => u.id === user.id) && store.isCustomAuthor(puzzleId, user.id)) {
      throw new HttpError(400, 'You made this puzzle, so you can’t solve it. Try Test solve in the builder.');
    }
    const authors = people.filter((u) => store.isCustomAuthor(puzzleId, u.id));
    if (authors.length) {
      throw new HttpError(400, `${listNames(authors.map(displayOf))} helped make this puzzle, so they can’t solve it.`);
    }
    const blind = people.filter((u) => !store.canSeePuzzle(u.id, puzzleId));
    if (blind.length) throw new HttpError(403, `This puzzle isn’t shared with ${listNames(blind.map(displayOf))}.`);
  };

  // ----- word lists -----

  /** One of this person's own lists (nobody else's, not even an admin's). */
  const ownList = (id, user) => {
    const l = store.wordList(Number(id));
    if (!l || l.owner_id !== user.id) throw new HttpError(404, 'No such word list.');
    return l;
  };

  const listView = (l) => ({
    id: l.id,
    name: l.name,
    enabled: l.enabled,
    count: l.count,
    created_at: l.created_at,
    updated_at: l.updated_at,
  });

  const listName = (raw, fallback = null) => {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name && !fallback) throw new HttpError(400, 'Give the list a name.');
    return name || fallback;
  };

  /** A list's words, to patch its owner's view with; null when there are too many to bother. */
  const wordsOf = (l) => (l.count <= MAX_PATCH ? [...store.wordListEntries(l.id)].map(([w]) => w) : null);

  const tooMany = (held) =>
    new HttpError(
      413,
      `That would make ${held.toLocaleString('en-US')} words in your lists, and ${MAX_OWN_WORDS.toLocaleString('en-US')} is the most one person can keep. Delete a list you don’t use first.`
    );

  /**
   * Words sent to add to a list: {text} (a list file, or lines typed in;
   * `score` for lines without one) and/or {set: [[word, score], ...]}.
   * @returns {{words: Map<string, number>, skipped: number}}
   */
  const entriesFrom = (body) => {
    const fallback = clampScore(body.score);
    // (no push(...list): a big file is more arguments than a call can take)
    const raw = body.text != null ? parseWordList(String(body.text), { defaultScore: fallback }) : [];
    if (Array.isArray(body.set)) {
      for (const e of body.set) raw.push(Array.isArray(e) ? [e[0], e[1] ?? fallback] : [e, fallback]);
    }
    const out = cleanEntries(raw);
    if (out.words.size > MAX_LIST_WORDS) {
      throw new HttpError(413, `That’s ${out.words.size.toLocaleString('en-US')} words; a list holds up to ${MAX_LIST_WORDS.toLocaleString('en-US')}.`);
    }
    return out;
  };

  const solveSummary = (s) => ({
    id: s.id,
    puzzle_id: s.puzzle_id,
    kind: s.kind,
    members: s.members,
    completed: s.completed,
    clean: s.clean,
    pct: s.pct,
    elapsed: s.elapsed,
    updated_at: s.updated_at,
    created_at: s.created_at,
  });

  // [method, pattern, handler(req, res, params, user), {auth}]
  const routes = [
    ['POST', /^\/api\/login$/, async (req, res) => {
      const body = await readJson(req, 10_000);
      const name = String(body.name || '').trim().toLowerCase();
      const password = String(body.password || '');
      const keys = [`ip:${clientIp(req, cfg)}`, `user:${name}`];
      if (limiter.blocked(keys)) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      const user = store.userByName(name);
      if (!user || !verifyPassword(password, user.pw_hash)) {
        limiter.fail(keys);
        throw new HttpError(401, 'Wrong name or password.');
      }
      limiter.succeed(keys);
      const token = startSession(store, user, cfg.sessionDays);
      send(res, 200, { user: publicUser(user) }, {
        'Set-Cookie': sessionCookie(token, { maxAgeDays: cfg.sessionDays, secure: secureFor(req) }),
      });
    }, { auth: false }],

    ['POST', /^\/api\/logout$/, async (req, res) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) store.deleteSession(hashToken(token));
      send(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie({ secure: secureFor(req) }) });
    }, { auth: false }],

    // ?optional=1 answers {user: null} instead of 401 (the login page asks)
    ['GET', /^\/api\/me$/, async (req, res, _p, _u, url) => {
      const user = userFromRequest(store, req);
      if (!user && !url.searchParams.has('optional')) throw new HttpError(401, 'Please log in.');
      send(res, 200, { user: publicUser(user) });
    }, { auth: false }],

    ['POST', /^\/api\/me\/password$/, async (req, res, _p, user) => {
      const body = await readJson(req, 10_000);
      if (!verifyPassword(String(body.current || ''), user.pw_hash)) {
        throw new HttpError(403, 'Your current password is wrong.');
      }
      const problem = validatePassword(body.next);
      if (problem) throw new HttpError(400, problem);
      store.setPassword(user.id, hashPassword(body.next));
      const token = startSession(store, user, cfg.sessionDays);
      send(res, 200, { ok: true }, {
        'Set-Cookie': sessionCookie(token, { maxAgeDays: cfg.sessionDays, secure: secureFor(req) }),
      });
    }],

    // last_together: when you last shared a co-op solve with them (or null),
    // so pickers can list your usual partners first
    ['GET', /^\/api\/users$/, async (req, res, _p, user) => {
      const partners = store.coopPartners(user.id);
      send(res, 200, {
        users: store.listUsers().map((u) => ({ ...publicUser(u), last_together: partners.get(u.id) ?? null })),
      });
    }],

    // Everything the archive needs to draw status icons, in one call.
    ['GET', /^\/api\/progress$/, async (req, res, _p, user) => {
      const solo = {};
      const coop = {};
      for (const s of store.solvesForUser(user.id)) {
        if (s.kind === 'solo') {
          solo[s.puzzle_id] = { completed: s.completed, clean: s.clean, elapsed: s.elapsed, pct: s.pct };
        } else {
          (coop[s.puzzle_id] ??= []).push(solveSummary(s));
        }
      }
      // Imported stats can hold solves with no grid (older solves); they
      // still count as solved in the archive.
      for (const [id, entry] of Object.entries(store.statsDoc(user).solves)) {
        if (!solo[id]?.completed) solo[id] = { completed: true, clean: entry.clean, elapsed: entry.seconds, pct: 100 };
      }
      send(res, 200, { solo, coop });
    }],

    ['GET', /^\/api\/stats\/([a-z0-9-]+)$/, async (req, res, [name], user) => {
      const doc = store.statsDoc(userByNameOr404(name));
      const shown = store.puzzleFilter(user.id);
      doc.solves = Object.fromEntries(Object.entries(doc.solves).filter(([id]) => shown(id)));
      send(res, 200, doc);
    }],

    ['GET', /^\/api\/coop-stats\/([a-z0-9-]+)$/, async (req, res, [name], user) => {
      const shown = store.puzzleFilter(user.id);
      send(res, 200, { solves: store.coopStats(userByNameOr404(name).id).filter((s) => shown(s.puzzle_id)) });
    }],

    // Everything the stats page aggregates, for every account at once
    // (anyone signed in can already see anyone's stats). Tuples; see
    // Store.statsAll.
    ['GET', /^\/api\/stats-all$/, async (req, res, _p, user) => {
      send(res, 200, store.statsAll(user.id));
    }],

    // Per-entry times, progress curves and letter confusions from one
    // person's logged solves (solo and co-op), fetched when a tab needs them.
    ['GET', /^\/api\/summaries\/([a-z0-9-]+)$/, async (req, res, [name], user) => {
      send(res, 200, { solves: store.summaryDetails(userByNameOr404(name).id, user.id) });
    }],

    // Every finished solve of one puzzle, for its breakdown page.
    ['GET', /^\/api\/puzzles\/([A-Za-z0-9_-]+)\/results$/, async (req, res, [puzzleId], user) => {
      if (!store.canSeePuzzle(user.id, puzzleId)) throw new HttpError(404, 'No such puzzle.');
      send(res, 200, { results: store.puzzleResults(puzzleId) });
    }],

    // A solve's event log, for replays and the breakdown page. Finished
    // solves are open to everyone (the page hides answers from people who
    // haven't solved the puzzle); unfinished ones only to their members.
    ['GET', /^\/api\/solves\/([A-Za-z0-9_-]+)\/events$/, async (req, res, [solveId], user) => {
      const solve = store.solveById(solveId);
      const member = solve && store.isMember(solveId, user.id);
      if (!solve || (!solve.record?.completed && !hub.liveRecord(solveId)?.completed && !member)) {
        throw new HttpError(404, 'No such solve.');
      }
      // a restricted custom puzzle's answers stay with the people it's shared with
      if (!member && !store.canSeePuzzle(user.id, solve.puzzle_id)) throw new HttpError(404, 'No such solve.');
      hub.rooms.get(solveId)?.flush(); // include what the room hasn't written yet
      send(res, 200, {
        solve: {
          id: solve.id,
          puzzle_id: solve.puzzle_id,
          kind: solve.kind,
          members: solve.members.map((m) => ({ name: m.name, display_name: m.display_name, color: m.color })),
          completed: !!(hub.liveRecord(solveId) ?? solve.record)?.completed,
          elapsed: (hub.liveRecord(solveId) ?? solve.record)?.elapsed ?? 0,
        },
        // [seq, t, at, user, kind, cell, value, marks, dir]
        events: store.events(solveId).map((e) => [e.seq, e.t, e.at, e.user, e.kind, e.cell, e.value, e.marks, e.dir]),
      });
    }],

    ['GET', /^\/api\/solves$/, async (req, res, _p, user, url) => {
      const puzzle = url.searchParams.get('puzzle');
      if (puzzle && !PUZZLE_ID_RE.test(puzzle)) throw new HttpError(400, 'Bad puzzle id.');
      send(res, 200, { solves: store.solvesForUser(user.id, puzzle || null).map(solveSummary) });
    }],

    ['POST', /^\/api\/solves$/, async (req, res, _p, user) => {
      const body = await readJson(req, 10_000);
      const puzzleId = String(body.puzzle_id || '');
      if (!PUZZLE_ID_RE.test(puzzleId)) throw new HttpError(400, 'Bad puzzle id.');
      const model = await puzzles.model(puzzleId);
      if (!model) throw new HttpError(404, 'That puzzle is not in the archive.');
      const others = [...new Set((body.members || []).map(String))].filter((n) => n !== user.name);
      if (!others.length) throw new HttpError(400, 'Pick at least one person to solve with.');
      const people = others.map((n) => userByNameOr404(n));
      checkCustomSolvers(puzzleId, user, [user, ...people]);
      const memberIds = [user.id, ...people.map((u) => u.id)];
      const record = newProgress(model, puzzleId, 'coop');
      const solve = store.createSolve({ puzzleId, kind: 'coop', createdBy: user.id, memberIds, record });
      send(res, 201, { solve: { id: solve.id, puzzle_id: puzzleId, members: solve.members.map((m) => m.name) } });
    }],

    ['POST', /^\/api\/solves\/([A-Za-z0-9_-]+)\/members$/, async (req, res, [solveId], user) => {
      const body = await readJson(req, 10_000);
      const solve = store.solveById(solveId);
      if (!solve || !store.isMember(solveId, user.id)) throw new HttpError(404, 'No such solve.');
      if (solve.kind !== 'coop') throw new HttpError(400, 'Solo solves stay solo — start a co-op instead.');
      const people = [...new Set((body.add || []).map(String))].map((n) => userByNameOr404(n));
      checkCustomSolvers(solve.puzzle_id, user, people);
      const ids = people.map((u) => u.id);
      const members = store.addMembers(solveId, ids);
      hub.membersChanged(solveId);
      send(res, 200, { members: members.map((m) => m.name) });
    }],

    // On-demand download of a puzzle that isn't in the archive yet.
    ['POST', /^\/api\/puzzles\/([A-Za-z0-9_-]+)\/fetch$/, async (req, res, [puzzleId]) => {
      if (await puzzles.model(puzzleId)) {
        send(res, 200, { status: 'done', id: puzzleId });
        return;
      }
      const result = await puzzles.fetch(puzzleId);
      if (result.status === 'done') words?.rebuildSoon(60_000);
      send(res, 200, result);
    }],

    // ----- the builder's word list (server/words.mjs), as each person sees
    // it: the site's with their own lists over it -----

    // Words that fit an entry, best first, keeping only those that leave
    // every crossing something to fit: {pattern: 'C?T', cross: [{pattern,
    // at} | null per square], limit}. ready is false until the list is built.
    ['POST', /^\/api\/words\/suggest$/, async (req, res, _p, user) => {
      const body = await readJson(req, 50_000);
      const pattern = String(body.pattern ?? '').toUpperCase();
      if (!PATTERN_RE.test(pattern)) throw new HttpError(400, 'A pattern is 2-25 letters, with ? for blanks.');
      const cross = (Array.isArray(body.cross) ? body.cross : []).slice(0, pattern.length).map((c) => {
        const p = String(c?.pattern ?? '').toUpperCase();
        return PATTERN_RE.test(p) && Number.isInteger(c.at) && c.at >= 0 && c.at < p.length ? { pattern: p, at: c.at } : null;
      });
      const index = words?.forUser(user.id);
      if (!index) {
        send(res, 200, { ready: false, words: [], total: 0, loose: 0 });
        return;
      }
      const limit = Math.min(200, Math.max(1, Number(body.limit) || 100));
      send(res, 200, { ready: true, size: index.size, ...index.suggest(pattern, cross, limit) });
    }],

    // How many words fit each pattern ({patterns: [...]}; null where it isn't one).
    ['POST', /^\/api\/words\/counts$/, async (req, res, _p, user) => {
      const body = await readJson(req, 100_000);
      const patterns = (Array.isArray(body.patterns) ? body.patterns : []).slice(0, 1000).map((p) => String(p ?? '').toUpperCase());
      const index = words?.forUser(user.id);
      if (!index) {
        send(res, 200, { ready: false, counts: patterns.map(() => null) });
        return;
      }
      send(res, 200, { ready: true, size: index.size, counts: patterns.map((p) => (PATTERN_RE.test(p) ? index.count(p) : null)) });
    }],

    // ----- people's own word lists (wordlists.html). Each person's lists
    // are theirs alone: every route below checks the owner. -----

    // Your lists, and whether the site's list counts for you (site: its
    // size, null while it builds).
    ['GET', /^\/api\/word-lists$/, async (req, res, _p, user) => {
      const site = words?.current();
      send(res, 200, {
        use_site: store.wordListPrefs(user.id).use_site,
        site: site ? { size: site.size } : null,
        lists: store.wordLists(user.id).map(listView),
      });
    }],

    // A new list: {name, text?, score?, set?} (see entriesFrom).
    ['POST', /^\/api\/word-lists$/, async (req, res, _p, user) => {
      const body = await readJson(req, MAX_LIST_UPLOAD);
      if (store.wordLists(user.id).length >= MAX_WORD_LISTS) {
        throw new HttpError(400, `You have ${MAX_WORD_LISTS} word lists already. Delete one first.`);
      }
      const name = listName(body.name, 'My words');
      const { words: entries, skipped } = entriesFrom(body);
      const held = store.ownWordCount(user.id) + entries.size;
      if (held > MAX_OWN_WORDS) throw tooMany(held);
      const list = store.createWordList(user.id, name, entries);
      words?.wordsChanged(user.id, entries.size <= MAX_PATCH ? [...entries.keys()] : null);
      ctx.log.info?.(`${user.name} made word list ${list.id} (${entries.size} words)`);
      send(res, 201, { list: listView(list), added: entries.size, skipped });
    }],

    // Whether the site's own list counts for you: {use_site}.
    ['POST', /^\/api\/word-lists\/prefs$/, async (req, res, _p, user) => {
      const body = await readJson(req, 10_000);
      if (typeof body.use_site !== 'boolean') throw new HttpError(400, 'use_site must be true or false.');
      store.setWordListPrefs(user.id, { use_site: body.use_site }); // forUser lays their words over it (or not)
      send(res, 200, store.wordListPrefs(user.id));
    }],

    // One word: the score your suggestions give it (null: left out), the
    // site's, and your lists that have it. ?word=
    ['GET', /^\/api\/word-lists\/lookup$/, async (req, res, _p, user, url) => {
      const word = normalizeWord(url.searchParams.get('word'));
      if (!word) throw new HttpError(400, 'A word is 2-25 letters.');
      const index = words?.forUser(user.id);
      send(res, 200, {
        word,
        ready: !!index,
        score: index?.scoreOf(word) ?? null,
        site: words?.current()?.scoreOf(word) ?? null,
        use_site: store.wordListPrefs(user.id).use_site,
        lists: store.wordInLists(user.id, word),
      });
    }],

    // Rename it or turn it on or off: {name?, enabled?}.
    ['POST', /^\/api\/word-lists\/(\d+)$/, async (req, res, [id], user) => {
      const l = ownList(id, user);
      const body = await readJson(req, 10_000);
      if (body.enabled != null && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.');
      store.updateWordList(l.id, { name: body.name == null ? null : listName(body.name), enabled: body.enabled });
      if (body.enabled != null && body.enabled !== l.enabled) words?.wordsChanged(user.id, wordsOf(l));
      send(res, 200, { list: listView(store.wordList(l.id)) });
    }],

    ['DELETE', /^\/api\/word-lists\/(\d+)$/, async (req, res, [id], user) => {
      const l = ownList(id, user);
      const gone = l.enabled ? wordsOf(l) : [];
      store.deleteWordList(l.id);
      words?.wordsChanged(user.id, gone);
      ctx.log.info?.(`${user.name} deleted word list ${l.id} (${l.count} words)`);
      send(res, 200, { deleted: true });
    }],

    // A page of its words: ?match= (letters it contains, or a pattern with
    // ? for one letter and * for any run) &sort=word|best|worst &offset= &limit=
    ['GET', /^\/api\/word-lists\/(\d+)\/words$/, async (req, res, [id], user, url) => {
      const l = ownList(id, user);
      const q = url.searchParams;
      const match = String(q.get('match') ?? '').toUpperCase().replace(/[^A-Z?*]/g, '').slice(0, 40);
      const page = store.wordListPage(l.id, {
        match,
        sort: q.get('sort'),
        offset: Math.max(0, Math.floor(Number(q.get('offset')) || 0)),
        limit: Math.min(500, Math.max(1, Math.floor(Number(q.get('limit')) || 100))),
      });
      send(res, 200, { list: listView(l), match, ...page });
    }],

    // Add or rescore words, and remove others: {text?, score?, set?,
    // remove?: [words]} (see entriesFrom). A word's new score replaces its old.
    ['POST', /^\/api\/word-lists\/(\d+)\/words$/, async (req, res, [id], user) => {
      const l = ownList(id, user);
      const body = await readJson(req, MAX_LIST_UPLOAD);
      const { words: entries, skipped } = entriesFrom(body);
      const remove = (Array.isArray(body.remove) ? body.remove : []).map(normalizeWord).filter(Boolean);
      if (!entries.size && !remove.length) {
        send(res, 200, { list: listView(l), added: 0, updated: 0, removed: 0, skipped });
        return;
      }
      const others = store.ownWordCount(user.id) - l.count; // in their other lists
      const maxSize = Math.min(MAX_LIST_WORDS, MAX_OWN_WORDS - others);
      const { added, removed, size, tooBig } = store.editWordList(l.id, { set: entries, remove, maxSize });
      if (tooBig && size > MAX_LIST_WORDS) {
        throw new HttpError(413, `A list holds up to ${MAX_LIST_WORDS.toLocaleString('en-US')} words. Start another list for these.`);
      }
      if (tooBig) throw tooMany(others + size);
      if (l.enabled) {
        const changed = entries.size + remove.length;
        words?.wordsChanged(user.id, changed <= MAX_PATCH ? [...entries.keys(), ...remove] : null);
      }
      send(res, 200, { list: listView(store.wordList(l.id)), added, updated: entries.size - added, removed, skipped });
    }],

    // The whole list as a file other programs read: WORD;SCORE, A-Z.
    ['GET', /^\/api\/word-lists\/(\d+)\/file$/, async (req, res, [id], user) => {
      const l = ownList(id, user);
      const file = `${l.name}.txt`;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${file.replace(/[^\w .-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file)}`,
      });
      let lines = [];
      for (const [word, score] of store.wordListEntries(l.id)) {
        lines.push(`${word};${score}\n`);
        if (lines.length === 10_000) {
          res.write(lines.join(''));
          lines = [];
        }
      }
      res.end(lines.join(''));
    }],

    // ----- custom puzzles (js/custom-puzzle.js; editing is live, in
    // server/build-rooms.mjs) -----

    // Every custom puzzle you can see, and your drafts, newest first.
    ['GET', /^\/api\/custom-puzzles$/, async (req, res, _p, user) => {
      const counts = store.customCounts();
      const puzzles = [...store.visibleCustomIds(user.id)]
        .map((id) => store.customPuzzle(id))
        .filter(Boolean)
        .map((p) => customEntry(p, user, counts))
        .sort((a, b) => (b.published_at ?? b.updated_at ?? '').localeCompare(a.published_at ?? a.updated_at ?? ''));
      send(res, 200, { puzzles });
    }],

    // A new draft: {width, height, symmetry?, title?} for a blank grid, or
    // {doc} (an uploaded .puz, converted in the browser).
    ['POST', /^\/api\/custom-puzzles$/, async (req, res, _p, user) => {
      const body = await readJson(req, 500_000);
      if (store.draftCount(user.id) >= MAX_DRAFTS) {
        throw new HttpError(400, `You have ${MAX_DRAFTS} drafts already. Publish or delete some first.`);
      }
      let doc;
      try {
        if (body.doc) {
          doc = normalizeDoc(body.doc);
        } else {
          const width = Number(body.width);
          const height = Number(body.height);
          if (!isValidSize(width, height)) normalizeDoc({ width, height }); // throws the size message
          doc = emptyDoc({ width, height, symmetry: body.symmetry, title: String(body.title ?? '').trim() });
        }
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      if (!doc.byline.trim()) doc.byline = displayOf(user);
      const p = store.createCustomPuzzle({ id: CUSTOM_PREFIX + newId(6), createdBy: user.id, doc });
      ctx.log.info?.(`${user.name} started custom puzzle ${p.id} (${doc.width}×${doc.height})`);
      send(res, 201, { puzzle: customEntry(p, user) });
    }],

    // One puzzle: solvers get the published copy. Its authors get a draft's
    // entry with doc null, and ?working=1 gives them the working copy (test
    // solving, downloading).
    ['GET', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)$/, async (req, res, [id], user, url) => {
      const { p, mine } = customFor(id, user);
      let doc = p.published;
      if (url.searchParams.has('working')) {
        if (!mine) throw new HttpError(404, 'No such puzzle.');
        doc = hub.liveDoc(id) ?? p.doc;
      }
      const puzzle = customEntry(p, user);
      if (p.visibility === 'people') puzzle.audience = namesOf(p.shares);
      send(res, 200, { puzzle, doc: doc ?? null });
    }],

    // Publish the working copy (or update what solvers have) once nothing
    // blocks it. A published puzzle's shape never changes, so every solve
    // still fits; open solves switch to the new copy.
    ['POST', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)\/publish$/, async (req, res, [id], user) => {
      const { p } = customFor(id, user, { author: true });
      const body = await readJson(req, 50_000);
      hub.flushBuild(id);
      const doc = hub.liveDoc(id) ?? p.doc;
      const { blockers } = problems(doc);
      if (blockers.length) throw new HttpError(400, `Not ready yet. ${blockers.map((b) => b.message).join(' ')}`);
      if (p.published && !sameShape(p.published, doc)) {
        throw new HttpError(409, 'The grid’s shape changed since it was published, so it can’t replace it.');
      }
      if (body.visibility != null) setSharing(p, body);
      const published = publishedCopy(doc);
      store.publishCustomPuzzle(id, { published, features: puzzleFeatures(modelOf(published)) });
      puzzles.forget(id);
      const after = store.customPuzzle(id);
      hub.buildRoom(id)?.setState({ status: 'published', visibility: after.visibility, published }, user.name);
      if (p.published) await hub.puzzleChanged(id);
      ctx.onPublished?.(after);
      ctx.log.info?.(`${user.name} ${p.published ? 'updated' : 'published'} custom puzzle ${id}`);
      send(res, 200, { puzzle: customEntry(after, user) });
    }],

    // Who can see it: {visibility: 'everyone'} or {visibility: 'people',
    // people: [names]}. Nobody loses a solve they already have.
    ['POST', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)\/sharing$/, async (req, res, [id], user) => {
      const { p } = customFor(id, user, { author: true });
      setSharing(p, await readJson(req, 50_000));
      const after = store.customPuzzle(id);
      hub.buildRoom(id)?.setState({ visibility: after.visibility }, user.name);
      send(res, 200, { puzzle: customEntry(after, user) });
    }],

    // Co-authors edit the working copy live with you. Someone who already
    // has a solve of the puzzle can't become one.
    ['POST', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)\/authors$/, async (req, res, [id], user) => {
      const { p } = customFor(id, user, { author: true });
      const body = await readJson(req, 10_000);
      const people = [...new Set((body.add || []).map(String))]
        .map((n) => userByNameOr404(n))
        .filter((u) => !p.authors.some((a) => a.id === u.id));
      const played = people.filter((u) => store.hasSolves(id, u.id));
      if (played.length) {
        throw new HttpError(
          400,
          `${listNames(played.map(displayOf))} already ${played.length === 1 ? 'has' : 'have'} a solve of this puzzle, so they can’t help write it.`
        );
      }
      const authors = store.addCustomAuthors(id, people.map((u) => u.id));
      hub.buildRoom(id)?.refreshAuthors();
      send(res, 200, { authors: authors.map((a) => a.name) });
    }],

    // The creator removes a co-author; anyone can leave.
    ['DELETE', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)\/authors\/([a-z0-9-]+)$/, async (req, res, [id, name], user) => {
      const { p } = customFor(id, user, { author: true });
      const target = userByNameOr404(name);
      if (!p.authors.some((a) => a.id === target.id)) throw new HttpError(404, `${displayOf(target)} isn’t one of its authors.`);
      if (target.id !== user.id && p.created_by !== user.id) {
        throw new HttpError(403, 'Only the person who started the puzzle can remove its co-authors.');
      }
      if (p.authors.length === 1) throw new HttpError(400, 'A puzzle needs at least one author. Delete it instead.');
      hub.flushBuild(id);
      const authors = store.removeCustomAuthor(id, target.id);
      hub.buildRoom(id)?.refreshAuthors();
      send(res, 200, { authors: authors.map((a) => a.name) });
    }],

    // What solvers thought. Everyone who can see the puzzle gets the
    // average; its authors and the people who finished it also get the
    // notes (they can give away answers).
    ['GET', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)\/feedback$/, async (req, res, [id], user) => {
      const { mine } = customFor(id, user);
      const all = store.feedbackFor(id);
      const finished = store.finishedPuzzle(id, user.id);
      const rated = all.filter((f) => f.stars != null);
      const avg = rated.reduce((a, f) => a + f.stars, 0) / (rated.length || 1);
      send(res, 200, {
        mine: all.find((f) => f.user === user.name) ?? null,
        can_rate: !mine && finished,
        stars: rated.length ? { avg: Math.round(avg * 10) / 10, n: rated.length } : null,
        notes: mine || finished ? all.filter((f) => f.comment) : null,
      });
    }],

    // Rate it (1-5 stars) and/or leave a note for its authors, once you've
    // finished it. Sending again replaces yours.
    ['POST', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)\/feedback$/, async (req, res, [id], user) => {
      const { mine } = customFor(id, user);
      if (mine) throw new HttpError(400, 'Authors don’t rate their own puzzle.');
      if (!store.finishedPuzzle(id, user.id)) throw new HttpError(403, 'Finish the puzzle first.');
      const body = await readJson(req, 10_000);
      const stars = body.stars == null || body.stars === '' ? null : Number(body.stars);
      if (stars != null && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) {
        throw new HttpError(400, 'Stars are a whole number from 1 to 5.');
      }
      const comment = String(body.comment ?? '').trim().slice(0, 1000);
      store.saveFeedback(id, user.id, { stars, comment });
      send(res, 200, { ok: true });
    }],

    // The creator (or an admin) deletes a puzzle. One that anybody has opened
    // to solve is withdrawn instead: unlisted and closed to new solves, while
    // their solves and stats stay.
    ['DELETE', /^\/api\/custom-puzzles\/([A-Za-z0-9_-]+)$/, async (req, res, [id], user) => {
      const p = isCustomId(id) ? store.customPuzzle(id) : null;
      const mine = !!p?.authors.some((a) => a.id === user.id);
      if (!p || (!mine && !(user.is_admin && store.canSeePuzzle(user.id, id)))) throw new HttpError(404, 'No such puzzle.');
      if (p.created_by !== user.id && !user.is_admin) {
        throw new HttpError(403, 'Only the person who started the puzzle can delete it.');
      }
      if (store.hasSolves(id)) {
        hub.flushBuild(id);
        store.withdrawCustomPuzzle(id);
        hub.buildRoom(id)?.setState({ status: 'withdrawn' }, user.name);
        ctx.log.info?.(`${user.name} withdrew custom puzzle ${id}`);
        send(res, 200, { withdrawn: true });
        return;
      }
      hub.buildRoom(id)?.deleted(user.name);
      store.deleteCustomPuzzle(id);
      puzzles.forget(id);
      ctx.log.info?.(`${user.name} deleted custom puzzle ${id}`);
      send(res, 200, { deleted: true });
    }],

    // ----- admin: manage accounts from the website -----

    ['GET', /^\/api\/admin\/users$/, async (req, res, _p, user) => {
      requireAdmin(user);
      send(res, 200, { users: store.listUsers().map(adminView) });
    }],

    ['POST', /^\/api\/admin\/users$/, async (req, res, _p, user) => {
      requireAdmin(user);
      const body = await readJson(req, 10_000);
      const name = String(body.name || '').trim().toLowerCase();
      if (store.userByName(name)) throw new HttpError(409, `“${name}” already exists.`);
      const { password, generated } = passwordFromBody(body);
      let created;
      try {
        created = store.createUser({
          name,
          displayName: String(body.display_name || '').trim() || name,
          pwHash: hashPassword(password),
          isAdmin: !!body.is_admin,
        });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      ctx.log.info?.(`admin ${user.name} created account ${name}`);
      send(res, 201, { user: adminView(created), ...(generated ? { password } : {}) });
    }],

    ['POST', /^\/api\/admin\/users\/([a-z0-9-]+)\/password$/, async (req, res, [name], user) => {
      requireAdmin(user);
      const target = userByNameOr404(name);
      if (target.id === user.id) throw new HttpError(400, 'Use “Change password” in your account menu for your own.');
      const body = await readJson(req, 10_000);
      const { password, generated } = passwordFromBody(body);
      store.setPassword(target.id, hashPassword(password)); // also signs them out everywhere
      limiter.succeed([`user:${target.name}`]); // a fresh password gets a fresh set of tries
      ctx.log.info?.(`admin ${user.name} reset the password for ${target.name}`);
      send(res, 200, { ok: true, ...(generated ? { password } : {}) });
    }],

    // Admins can't change or delete their own account here, which also
    // means there is always at least one admin left.
    ['POST', /^\/api\/admin\/users\/([a-z0-9-]+)\/admin$/, async (req, res, [name], user) => {
      requireAdmin(user);
      const target = userByNameOr404(name);
      if (target.id === user.id) throw new HttpError(400, 'You can’t change your own admin status.');
      const body = await readJson(req, 10_000);
      if (typeof body.is_admin !== 'boolean') throw new HttpError(400, 'is_admin must be true or false.');
      store.updateUser(target.id, { isAdmin: body.is_admin });
      ctx.log.info?.(`admin ${user.name} ${body.is_admin ? 'made' : 'removed'} ${target.name} ${body.is_admin ? 'an admin' : 'as admin'}`);
      send(res, 200, { user: adminView(store.userById(target.id)) });
    }],

    ['DELETE', /^\/api\/admin\/users\/([a-z0-9-]+)$/, async (req, res, [name], user) => {
      requireAdmin(user);
      const target = userByNameOr404(name);
      if (target.id === user.id) throw new HttpError(400, 'You can’t delete your own account.');
      hub.dropUser(target.id, () => store.deleteUser(target.id));
      ctx.log.info?.(`admin ${user.name} deleted account ${target.name}`);
      send(res, 200, { ok: true });
    }],

    // One-time upload of progress saved in this browser before the move to
    // the server. Merged with the same rules devices always used.
    ['POST', /^\/api\/import-local$/, async (req, res, _p, user) => {
      const body = await readJson(req, 20_000_000);
      let imported = 0;
      let skipped = 0;
      for (const rec of Array.isArray(body.records) ? body.records : []) {
        const puzzleId = String(rec?.puzzle_id || '');
        const model = PUZZLE_ID_RE.test(puzzleId) && !isCustomId(puzzleId) ? await puzzles.model(puzzleId) : null;
        if (!model || !recordFitsModel(rec, model)) {
          skipped++;
          continue;
        }
        const clean = { ...rec, user: user.name };
        const existing = store.soloSolve(user.id, puzzleId);
        if (existing && hub.isLive(existing.id)) {
          skipped++; // someone has it open right now; leave it alone
          continue;
        }
        if (!existing) {
          store.createSolve({ puzzleId, kind: 'solo', ownerId: user.id, createdBy: user.id, memberIds: [user.id], record: clean });
        } else {
          const winner = recordFitsModel(existing.record, model) ? mergeProgress(existing.record, clean) : clean;
          if (winner !== existing.record) store.saveRecord(existing.id, winner);
        }
        imported++;
      }
      let solves = 0;
      for (const [puzzleId, entry] of Object.entries(body.stats?.solves ?? {})) {
        if (!PUZZLE_ID_RE.test(puzzleId) || isCustomId(puzzleId) || !entry?.completed_at) continue;
        if (store.recordSoloSolve(user.id, puzzleId, entry)) solves++;
      }
      send(res, 200, { imported, skipped, solves });
    }],
  ];

  /** @returns {Promise<boolean>} whether the request was an API call */
  return async function handleApi(req, res, url) {
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      for (const [method, pattern, handler, opts = {}] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m) continue;
        if (req.method !== method) continue;
        let user = null;
        if (opts.auth !== false) {
          user = userFromRequest(store, req);
          if (!user) throw new HttpError(401, 'Please log in.');
        }
        await handler(req, res, m.slice(1), user, url);
        return true;
      }
      throw new HttpError(404, 'No such endpoint.');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) ctx.log.error?.(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error.' : err.message });
      return true;
    }
  };
}
