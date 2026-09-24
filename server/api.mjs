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
import { mergeProgress, newProgress, recordFitsModel } from '../js/state.js';

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
  const { cfg, store, hub, puzzles, limiter } = ctx;
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

    ['GET', /^\/api\/users$/, async (req, res) => {
      send(res, 200, { users: store.listUsers().map(publicUser) });
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

    ['GET', /^\/api\/stats\/([a-z0-9-]+)$/, async (req, res, [name]) => {
      send(res, 200, store.statsDoc(userByNameOr404(name)));
    }],

    ['GET', /^\/api\/coop-stats\/([a-z0-9-]+)$/, async (req, res, [name]) => {
      send(res, 200, { solves: store.coopStats(userByNameOr404(name).id) });
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
      const memberIds = [user.id, ...others.map((n) => userByNameOr404(n).id)];
      const record = newProgress(model, puzzleId, 'coop');
      const solve = store.createSolve({ puzzleId, kind: 'coop', createdBy: user.id, memberIds, record });
      send(res, 201, { solve: { id: solve.id, puzzle_id: puzzleId, members: solve.members.map((m) => m.name) } });
    }],

    ['POST', /^\/api\/solves\/([A-Za-z0-9_-]+)\/members$/, async (req, res, [solveId], user) => {
      const body = await readJson(req, 10_000);
      const solve = store.solveById(solveId);
      if (!solve || !store.isMember(solveId, user.id)) throw new HttpError(404, 'No such solve.');
      if (solve.kind !== 'coop') throw new HttpError(400, 'Solo solves stay solo — start a co-op instead.');
      const ids = [...new Set((body.add || []).map(String))].map((n) => userByNameOr404(n).id);
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
      send(res, 200, result);
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

    // One-time upload of progress saved in this browser before the move to
    // the server. Merged with the same rules devices always used.
    ['POST', /^\/api\/import-local$/, async (req, res, _p, user) => {
      const body = await readJson(req, 20_000_000);
      let imported = 0;
      let skipped = 0;
      for (const rec of Array.isArray(body.records) ? body.records : []) {
        const puzzleId = String(rec?.puzzle_id || '');
        const model = PUZZLE_ID_RE.test(puzzleId) ? await puzzles.model(puzzleId) : null;
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
        if (!PUZZLE_ID_RE.test(puzzleId) || !entry?.completed_at) continue;
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
