/*
 * stats-model.js — models over everyone's solo solves. Pure, no DOM.
 *
 * fitAdditive: log(seconds) = mu + weekday + solver + puzzle + noise.
 *   Solver effects give skill ratings that stay comparable between people
 *   who rarely solve the same puzzles (they're linked through everyone
 *   else); puzzle effects are difficulty relative to a typical puzzle of
 *   the same weekday. Both are shrunk toward 0 (ridge), so one solve can't
 *   make a puzzle "the hardest ever" or a newcomer a champion.
 * elo / bradleyTerry: ratings from who beat whom on shared puzzles.
 */

import { mean, sd } from './stats-math.js';

const groupOf = (row) => (row.weekday == null ? 'x' : String(row.weekday));

/**
 * @param {Array<{user:string, puzzleId:string, weekday:number|null, seconds:number}>} rows
 *   solo solves of ONE puzzle type
 * @returns {null | {mu, weekday: Map, user: Map, puzzle: Map, sigma, n,
 *   userN: Map, puzzleN: Map, userSe(u), fitted(row), constructor: Map}}
 */
export function fitAdditive(rows, { lambdaUser = 2, lambdaPuzzle = 1, iterations = 60 } = {}) {
  const data = rows.filter((r) => r.seconds > 0).map((r) => ({ ...r, y: Math.log(r.seconds), g: groupOf(r) }));
  if (data.length < 3) return null;
  const mu0 = mean(data.map((d) => d.y));
  let mu = mu0;
  const wk = new Map();
  const a = new Map();
  const b = new Map();
  const count = (key) => {
    const m = new Map();
    for (const d of data) m.set(d[key], (m.get(d[key]) ?? 0) + 1);
    return m;
  };
  const userN = count('user');
  const puzzleN = count('puzzleId');
  for (const u of userN.keys()) a.set(u, 0);
  for (const p of puzzleN.keys()) b.set(p, 0);
  for (const d of data) wk.set(d.g, 0);

  const pass = (keyFn, effects, others, lambda) => {
    const sums = new Map();
    const ns = new Map();
    for (const d of data) {
      const k = keyFn(d);
      sums.set(k, (sums.get(k) ?? 0) + d.y - mu - others(d));
      ns.set(k, (ns.get(k) ?? 0) + 1);
    }
    for (const [k, s] of sums) effects.set(k, s / (ns.get(k) + lambda));
  };

  for (let it = 0; it < iterations; it++) {
    pass((d) => d.g, wk, (d) => a.get(d.user) + b.get(d.puzzleId), 0);
    pass((d) => d.puzzleId, b, (d) => wk.get(d.g) + a.get(d.user), lambdaPuzzle);
    pass((d) => d.user, a, (d) => wk.get(d.g) + b.get(d.puzzleId), lambdaUser);
    // keep solver effects centred on the average solver
    const shift = mean([...a.values()]);
    for (const [k, v] of a) a.set(k, v - shift);
    mu += shift;
  }

  const fitted = (r) => mu + (wk.get(groupOf(r)) ?? 0) + (a.get(r.user) ?? 0) + (b.get(r.puzzleId) ?? 0);
  const resid = data.map((d) => d.y - fitted(d));
  const dof = Math.max(1, data.length - userN.size - Math.min(puzzleN.size, data.length / 2));
  const sigma = Math.sqrt(resid.reduce((s, x) => s + x * x, 0) / dof) || sd(data.map((d) => d.y)) || 0.3;

  return {
    mu,
    weekday: wk,
    user: a,
    puzzle: b,
    userN,
    puzzleN,
    sigma,
    n: data.length,
    /** Standard error of a solver's effect (log units). */
    userSe: (u) => sigma / Math.sqrt((userN.get(u) ?? 0) + lambdaUser),
    fitted,
  };
}

/**
 * Average puzzle effect per constructor, shrunk toward 0.
 * @returns {Map<string, {effect:number, n:number}>}
 */
export function constructorEffects(fit, puzzles, { lambda = 2 } = {}) {
  const acc = new Map();
  for (const [id, effect] of fit.puzzle) {
    for (const c of puzzles.get(id)?.constructors ?? []) {
      const e = acc.get(c) ?? { sum: 0, n: 0 };
      e.sum += effect;
      e.n++;
      acc.set(c, e);
    }
  }
  return new Map([...acc].map(([c, { sum, n }]) => [c, { effect: sum / (n + lambda), n }]));
}

/**
 * Predicted seconds for `user` on puzzle `p` (a puzzleInfo). Uses the
 * puzzle's own difficulty when anyone solved it, else its constructors'
 * (when they have 3+ puzzles here), else a typical same-weekday puzzle.
 * @returns {{seconds:number, lo:number, hi:number, basis:string}|null}
 */
export function predict(fit, user, p, constructors = null) {
  if (!fit || !fit.user.has(user)) return null;
  const g = p.weekday == null ? 'x' : String(p.weekday);
  if (!fit.weekday.has(g)) return null;
  let diff = 0;
  let basis = 'weekday';
  if (fit.puzzle.has(p.id)) {
    diff = fit.puzzle.get(p.id);
    basis = 'puzzle';
  } else if (constructors) {
    const known = (p.constructors ?? []).map((c) => constructors.get(c)).filter((c) => c && c.n >= 3);
    if (known.length) {
      diff = mean(known.map((c) => c.effect));
      basis = 'constructor';
    }
  }
  const y = fit.mu + fit.weekday.get(g) + fit.user.get(user) + diff;
  return { seconds: Math.exp(y), lo: Math.exp(y - 1.28 * fit.sigma), hi: Math.exp(y + 1.28 * fit.sigma), basis };
}

/**
 * Pairwise results on puzzles two or more people solved, oldest first.
 * @returns {Array<{puzzleId, at:number, times: Map<string, number>}>}
 */
export function sharedPuzzles(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.puzzleId)) by.set(r.puzzleId, []);
    by.get(r.puzzleId).push(r);
  }
  return [...by]
    .filter(([, rs]) => rs.length > 1)
    .map(([puzzleId, rs]) => ({
      puzzleId,
      at: Math.max(...rs.map((r) => r.completedAt)), // the result is known once the last one finishes
      times: new Map(rs.map((r) => [r.user, r.seconds])),
    }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Elo over shared puzzles in the order results became known. On a puzzle
 * with k solvers each pair is a game, weighted 1/(k-1) so a big field
 * doesn't swing ratings more than a duel.
 * @returns {{ratings: Map<string, number>, history: Map<string, Array<{at, rating, puzzleId}>>}}
 */
export function elo(rows, { k = 24, start = 1500 } = {}) {
  const ratings = new Map();
  const history = new Map();
  const get = (u) => ratings.get(u) ?? start;
  for (const game of sharedPuzzles(rows)) {
    const people = [...game.times.keys()];
    const w = 1 / (people.length - 1);
    const delta = new Map(people.map((u) => [u, 0]));
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const [u, v] = [people[i], people[j]];
        const tu = game.times.get(u);
        const tv = game.times.get(v);
        const score = tu < tv ? 1 : tu > tv ? 0 : 0.5;
        const expected = 1 / (1 + 10 ** ((get(v) - get(u)) / 400));
        delta.set(u, delta.get(u) + k * w * (score - expected));
        delta.set(v, delta.get(v) - k * w * (score - expected));
      }
    }
    for (const u of people) {
      ratings.set(u, get(u) + delta.get(u));
      if (!history.has(u)) history.set(u, [{ at: game.at, rating: start, puzzleId: null }]);
      history.get(u).push({ at: game.at, rating: ratings.get(u), puzzleId: game.puzzleId });
    }
  }
  return { ratings, history };
}

/**
 * Head-to-head counts: wins.get(u).get(v) = puzzles u solved faster than v.
 * @returns {{wins: Map<string, Map<string, number>>, games: Map<string, Map<string, number>>}}
 */
export function pairwise(rows) {
  const wins = new Map();
  const games = new Map();
  const bump = (m, u, v) => {
    if (!m.has(u)) m.set(u, new Map());
    m.get(u).set(v, (m.get(u).get(v) ?? 0) + 1);
  };
  for (const game of sharedPuzzles(rows)) {
    const people = [...game.times.keys()];
    for (const u of people) {
      for (const v of people) {
        if (u === v) continue;
        bump(games, u, v);
        if (game.times.get(u) < game.times.get(v)) bump(wins, u, v);
      }
    }
  }
  return { wins, games };
}

/**
 * Bradley–Terry strengths from pairwise wins (MM algorithm; ties count as
 * half a win each way), on an Elo-like scale centred at 1500.
 * @returns {Map<string, number>}
 */
export function bradleyTerry(rows, { iterations = 200 } = {}) {
  const { wins, games } = pairwise(rows);
  const people = [...games.keys()];
  if (people.length < 2) return new Map();
  const w = (u, v) => {
    const g = games.get(u)?.get(v) ?? 0;
    const won = wins.get(u)?.get(v) ?? 0;
    const lost = wins.get(v)?.get(u) ?? 0;
    return won + (g - won - lost) / 2; // ties split
  };
  let p = new Map(people.map((u) => [u, 1]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map();
    for (const u of people) {
      let totalWins = 0;
      let denom = 0;
      for (const v of people) {
        if (u === v) continue;
        const n = games.get(u)?.get(v) ?? 0;
        if (!n) continue;
        totalWins += w(u, v);
        denom += n / (p.get(u) + p.get(v));
      }
      // +0.5 pseudo-win keeps someone who never won off zero
      next.set(u, (totalWins + 0.5) / (denom + 1 / (p.get(u) + 1)));
    }
    const g = Math.exp(mean([...next.values()].map(Math.log)));
    for (const [u, v] of next) next.set(u, v / g);
    p = next;
  }
  return new Map([...p].map(([u, v]) => [u, 1500 + 400 * Math.log10(v)]));
}

/**
 * How a co-op solve compares with what its members would do alone:
 * `vsBest` > 1 means the team beat its fastest member's predicted solo
 * time; `vsSplit` compares with a perfect division of labour (the members'
 * solo speeds added together).
 */
export function coopSynergy(fit, coop, puzzles, constructors = null) {
  const p = puzzles.get(coop.puzzleId);
  if (!fit || !p) return null;
  const preds = coop.members.map((u) => predict(fit, u, p, constructors)?.seconds).filter((x) => x != null);
  if (preds.length < 2 || preds.length < coop.members.length) return null;
  const best = Math.min(...preds);
  const split = 1 / preds.reduce((s, t) => s + 1 / t, 0);
  return { predictedBest: best, predictedSplit: split, vsBest: best / coop.seconds, vsSplit: split / coop.seconds };
}

/** Rank of each person on each shared puzzle: Map(user -> [count of 1st, 2nd, ...]). */
export function rankCounts(rows, people) {
  const out = new Map(people.map((u) => [u, new Array(people.length).fill(0)]));
  for (const game of sharedPuzzles(rows.filter((r) => people.includes(r.user)))) {
    const sorted = [...game.times].sort((a, b) => a[1] - b[1]);
    sorted.forEach(([u], k) => out.get(u)[k]++);
  }
  return out;
}

