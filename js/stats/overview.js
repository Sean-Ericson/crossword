/*
 * stats/overview.js — the headline numbers: tiles for one person, an
 * at-a-glance table for several, records per weekday, recent solves, and
 * a prediction for the newest puzzle.
 */

import { el, WEEKDAY_NAMES } from '../util.js';
import { median, quantile, wilson, sum } from '../stats-math.js';
import { streaks } from '../stats-data.js';
import { predict } from '../stats-model.js';
import { chartCard, barChart, dotPlot, heatmap, legend, fmt, scaleLegend } from '../charts.js';
import {
  WEEKDAY_ORDER, wd, tile, tiles, sectionHead, sortableTable, puzzleName, breakdownHref, playHref, link, who, empty, chartGrid,
} from './common.js';

const WEEK = 7 * 86400000;

export function render(host, ctx) {
  if (ctx.users.length === 1) single(host, ctx, ctx.users[0]);
  else several(host, ctx);
}

/** Solves per week for the last `n` weeks, oldest first. */
function weekly(rows, n = 12) {
  const now = Date.now();
  const counts = new Array(n).fill(0);
  for (const r of rows) {
    const k = Math.floor((now - r.completedAt) / WEEK);
    if (k >= 0 && k < n) counts[n - 1 - k]++;
  }
  return counts;
}

/** The solver's effect as "x% faster/slower than the average solver", with a 95% range. */
export function skillOf(ctx, user) {
  const { fit } = ctx.models();
  if (!fit || !fit.user.has(user) || (fit.userN.get(user) ?? 0) < 3) return null;
  const a = fit.user.get(user);
  const se = fit.userSe(user);
  return { factor: Math.exp(a), lo: Math.exp(a - 1.96 * se), hi: Math.exp(a + 1.96 * se), n: fit.userN.get(user) };
}

function prediction(ctx, user) {
  const p = ctx.latest;
  if (!p) return null;
  const { fit, constructors } = ctx.models();
  const done = ctx.inType.find((r) => r.user === user && r.puzzleId === p.id);
  const pred = predict(fit, user, p, constructors);
  return { p, done, pred };
}

function single(host, ctx, user) {
  const rows = ctx.byUser.get(user) ?? [];
  if (!rows.length) {
    host.append(empty(`No ${ctx.typeLabel.toLowerCase()} solves here yet for ${ctx.nameOf(user)}. Go solve one!`));
    return;
  }
  const secs = rows.map((r) => r.seconds);
  const best = rows.reduce((b, r) => (r.seconds < b.seconds ? r : b));
  const st = streaks(rows);
  const clean = rows.filter((r) => r.clean).length;
  const ci = wilson(clean, rows.length);
  const now = Date.now();
  const thisWeek = rows.filter((r) => now - r.completedAt < WEEK).length;
  const thisMonth = rows.filter((r) => now - r.completedAt < 30 * 86400000).length;
  const total = sum(secs);
  const byTime = [...rows].sort((a, b) => a.completedAt - b.completedAt);
  const rolling = byTime.map((_, k) => median(byTime.slice(Math.max(0, k - 9), k + 1).map((r) => r.seconds)));
  const skill = skillOf(ctx, user);
  const pr = prediction(ctx, user);

  host.append(
    tiles([
      tile({ label: 'Puzzles solved', value: fmt.int(rows.length), sub: `${thisWeek} this week · ${thisMonth} in 30 days`, spark: weekly(rows), sparkColor: ctx.colorOf(user) }),
      tile({
        label: '★ Clean solves',
        value: fmt.pct(clean / rows.length),
        sub: `${clean} of ${rows.length}${ci && rows.length >= 5 ? ` · likely ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}%` : ''}`,
        title: 'No check or reveal. The range is a 95% Wilson interval for your true clean rate.',
      }),
      tile({ label: 'Median time', value: fmt.time(median(secs)), sub: `middle half ${fmt.time(quantile(secs, 0.25))}–${fmt.time(quantile(secs, 0.75))}`, spark: rolling.slice(-30), sparkColor: ctx.colorOf(user) }),
      tile({ label: 'Best time', value: fmt.time(best.seconds), sub: link(breakdownHref(best.puzzleId, best.solveId), puzzleName(best.puzzle)) }),
      ctx.hasWeekdays ? tile({ label: 'Streak', value: String(st.current), sub: `longest ${st.longest} · consecutive puzzle dates` }) : null,
      ctx.hasWeekdays ? tile({ label: 'Day-of streak', value: String(st.dayOfCurrent), sub: `longest ${st.dayOfLongest} · solved on the day` }) : null,
      tile({ label: 'Time solving', value: total >= 36000 ? `${Math.round(total / 3600)} h` : `${(total / 3600).toFixed(1)} h`, sub: `${fmt.time(total / rows.length)} per puzzle on average` }),
      skill
        ? tile({
            label: 'Skill',
            value: fmt.rel(skill.factor).replace('as usual', 'average'),
            sub: `than the average solver here (95%: ${fmt.rel(skill.lo)} to ${fmt.rel(skill.hi)})`,
            title: 'From a model of everyone’s times: log time = weekday + solver + puzzle. The range is 95%.',
          })
        : null,
      pr ? predictionTile(ctx, pr) : null,
    ])
  );

  const cards = [];
  if (ctx.hasWeekdays) cards.push(weekdayCard(ctx, [user]));
  host.append(chartGrid(...cards));
  if (ctx.hasWeekdays) host.append(sectionHead('Records by weekday', 'Best, median and the middle half of your times for each day of the week.'), weekdayRecords(ctx, rows));
  host.append(sectionHead('Recent solves', 'Newest first. “vs usual” compares with your median for that weekday.'), recent(ctx, rows));
}

function predictionTile(ctx, { p, done, pred }) {
  const label = `Newest: ${puzzleName(p)}`;
  if (done) {
    const diff = pred ? done.seconds - pred.seconds : null;
    return tile({
      label,
      value: fmt.time(done.seconds),
      sub: pred ? `${diff < 0 ? 'beat' : 'over'} the prediction (${fmt.time(pred.seconds)}) by ${fmt.time(Math.abs(diff))}` : 'solved',
    });
  }
  if (!pred) return tile({ label, value: '—', sub: el('a', { href: playHref(p.id) }, 'Not solved yet: play it') });
  return tile({
    label,
    value: `~${fmt.time(pred.seconds)}`,
    sub: el('span', {}, [`expected (${fmt.time(pred.lo)}–${fmt.time(pred.hi)}, from ${pred.basis === 'puzzle' ? 'others’ times on it' : pred.basis === 'constructor' ? 'its constructor' : 'your usual'}) · `, el('a', { href: playHref(p.id) }, 'play')]),
    title: 'The model’s guess, with an 80% range.',
  });
}

/** Median by weekday: bars for up to three people, a colored table beyond. */
export function weekdayCard(ctx, people) {
  const med = (u, d) => {
    const v = (ctx.byUser.get(u) ?? []).filter((r) => r.weekday === d).map((r) => r.seconds);
    return v.length ? median(v) : null;
  };
  const cats = WEEKDAY_ORDER.map((d) => ({ key: d, label: wd(d) }));
  const table = {
    columns: [['Weekday', (r) => WEEKDAY_NAMES[r.d]], ...people.map((u) => [ctx.nameOf(u), (r) => med(u, r.d), (v) => fmt.time(v)])],
    rows: WEEKDAY_ORDER.map((d) => ({ d })),
  };
  if (people.length <= 3) {
    const series = ctx.series(people);
    return chartCard({
      title: 'Median time by weekday',
      sub: people.length > 1 ? null : 'Half your solves were faster, half slower.',
      legend: people.length > 1 ? legend(series) : null,
      table,
      draw: (w) =>
        barChart(w, {
          categories: cats,
          series,
          value: (d, u) => med(u, d),
          fmt: fmt.time,
          ticks: 'time',
          height: 220,
          valueLabels: people.length === 1,
          label: 'Median solve time by weekday',
        }),
    });
  }
  // many people: one colored cell per person and weekday, against the group's median that day
  const groupMed = new Map(WEEKDAY_ORDER.map((d) => [d, median(people.map((u) => med(u, d)).filter((v) => v != null)) ?? null]));
  const scale = { type: 'div', min: Math.log(0.5), mid: 0, max: Math.log(2) };
  return chartCard({
    title: 'Median time by weekday',
    sub: 'Each cell against the middle of the group that day: blue faster, red slower.',
    legend: scaleLegend(scale, { low: 'twice as fast', high: 'twice as slow' }),
    table,
    draw: (w) =>
      heatmap(w, {
        rows: people.map((u) => ({ key: u, label: ctx.nameOf(u) })),
        cols: cats,
        cell: (u, d) => {
          const v = med(u, d);
          if (v == null) return null;
          return {
            value: Math.log(v / groupMed.get(d)),
            text: fmt.time(v),
            tip: { title: `${ctx.nameOf(u)} · ${WEEKDAY_NAMES[d]}`, rows: [{ value: fmt.time(v), label: 'median' }, { value: fmt.rel(v / groupMed.get(d)), label: 'than the group' }] },
          };
        },
        scale,
        showValues: true,
        cellMax: 64,
        label: 'Median solve time by person and weekday',
      }),
  });
}

function weekdayRecords(ctx, rows) {
  const data = WEEKDAY_ORDER.map((d) => {
    const rs = rows.filter((r) => r.weekday === d);
    const secs = rs.map((r) => r.seconds);
    const best = rs.length ? rs.reduce((b, r) => (r.seconds < b.seconds ? r : b)) : null;
    return {
      d,
      n: rs.length,
      best,
      median: rs.length ? median(secs) : null,
      q1: rs.length ? quantile(secs, 0.25) : null,
      q3: rs.length ? quantile(secs, 0.75) : null,
      clean: rs.length ? rs.filter((r) => r.clean).length / rs.length : null,
    };
  });
  return sortableTable({
    columns: [
      { key: 'd', label: 'Day', value: (r) => (r.d + 6) % 7, show: (_, r) => WEEKDAY_NAMES[r.d] },
      { key: 'n', label: 'Solves', value: (r) => r.n, num: true, better: -1 },
      { key: 'best', label: 'Best', value: (r) => r.best?.seconds ?? null, show: (v, r) => link(breakdownHref(r.best.puzzleId, r.best.solveId), fmt.time(v), puzzleName(r.best.puzzle)), num: true },
      { key: 'median', label: 'Median', value: (r) => r.median, show: fmt.time, num: true },
      { key: 'iqr', label: 'Middle half', value: (r) => r.q1, show: (_, r) => `${fmt.time(r.q1)}–${fmt.time(r.q3)}`, num: true },
      { key: 'clean', label: '★ Clean', value: (r) => r.clean, show: fmt.pct, num: true, better: -1 },
    ],
    rows: data,
  });
}

function recent(ctx, rows) {
  const list = [...rows].sort((a, b) => b.completedAt - a.completedAt);
  return sortableTable({
    columns: [
      { key: 'when', label: 'Solved', value: (r) => r.completedAt, show: (v) => fmt.date(v), better: -1 },
      { key: 'puzzle', label: 'Puzzle', value: (r) => r.date ?? r.puzzleId, show: (_, r) => link(breakdownHref(r.puzzleId, r.solveId), puzzleName(r.puzzle), r.puzzle.constructors.join(', ')) },
      { key: 'time', label: 'Time', value: (r) => r.seconds, show: fmt.time, num: true },
      { key: 'rel', label: 'vs usual', value: (r) => r.relative, show: (v) => fmt.rel(v), num: true },
      { key: 'clean', label: '', value: (r) => (r.clean ? 1 : r.reveal ? -1 : 0), show: (_, r) => (r.clean ? el('span', { class: 'gold', title: 'Clean' }, '★') : r.reveal ? 'revealed' : 'checked') },
    ],
    rows: list,
    sort: { key: 'when', dir: -1 },
    limit: 12,
  });
}

// ---------- several people ----------

function several(host, ctx) {
  const people = ctx.users;
  const stats = people.map((u) => {
    const rows = ctx.byUser.get(u) ?? [];
    const secs = rows.map((r) => r.seconds);
    const st = streaks(rows);
    return {
      user: u,
      n: rows.length,
      clean: rows.length ? rows.filter((r) => r.clean).length / rows.length : null,
      median: secs.length ? median(secs) : null,
      best: secs.length ? Math.min(...secs) : null,
      streak: st.current,
      dayOf: st.dayOfCurrent,
      hours: sum(secs) / 3600,
      skill: skillOf(ctx, u),
    };
  });
  host.append(
    sectionHead('At a glance', 'Click a heading to sort. Skill comes from everyone’s solves of this type, all time.'),
    sortableTable({
      columns: [
        { key: 'user', label: 'Solver', value: (r) => ctx.nameOf(r.user), show: (_, r) => who(ctx, r.user) },
        { key: 'n', label: 'Solved', value: (r) => r.n, num: true, better: -1 },
        { key: 'clean', label: '★ Clean', value: (r) => r.clean, show: fmt.pct, num: true, better: -1 },
        { key: 'median', label: 'Median', value: (r) => r.median, show: fmt.time, num: true },
        { key: 'best', label: 'Best', value: (r) => r.best, show: fmt.time, num: true },
        ...(ctx.hasWeekdays
          ? [
              { key: 'streak', label: 'Streak', value: (r) => r.streak, num: true, better: -1 },
              { key: 'dayOf', label: 'Day-of', value: (r) => r.dayOf, num: true, better: -1, title: 'Current streak of puzzles solved on their own day' },
            ]
          : []),
        { key: 'hours', label: 'Hours', value: (r) => r.hours, show: (v) => v.toFixed(1), num: true, better: -1 },
        { key: 'skill', label: 'Skill', value: (r) => r.skill?.factor ?? null, show: (v) => fmt.rel(v), num: true, title: 'Speed against the average solver, from the model' },
      ],
      rows: stats,
      sort: { key: 'n', dir: -1 },
      rowClass: (r) => (r.user === ctx.me ? 'you' : null),
    })
  );

  const cards = [];
  if (ctx.hasWeekdays) cards.push(weekdayCard(ctx, people));
  const pr = people.map((u) => ({ u, ...(prediction(ctx, u) ?? {}) })).filter((x) => x.p);
  if (pr.length) {
    const p = pr[0].p;
    cards.push(
      chartCard({
        title: `Newest puzzle: ${puzzleName(p)}`,
        sub: 'A solid dot is a real time; a faint one is the model’s guess for someone who hasn’t solved it yet.',
        table: {
          columns: [
            ['Solver', (r) => ctx.nameOf(r.u)],
            ['Time', (r) => r.done?.seconds ?? null, fmt.time],
            ['Predicted', (r) => r.pred?.seconds ?? null, fmt.time],
          ],
          rows: pr,
        },
        draw: (w) =>
          dotPlot(w, {
            rows: pr.map((x) => ({
              key: x.u,
              label: ctx.nameOf(x.u),
              color: ctx.colorOf(x.u),
              value: x.done?.seconds ?? null,
              values: x.done || !x.pred ? [] : [x.pred.seconds],
              href: x.done ? breakdownHref(p.id, x.done.solveId) : null,
              tip: {
                title: ctx.nameOf(x.u),
                rows: [
                  x.done ? { value: fmt.time(x.done.seconds), label: 'solved', color: ctx.colorOf(x.u) } : { value: 'not solved yet' },
                  x.pred ? { value: `${fmt.time(x.pred.seconds)} (${fmt.time(x.pred.lo)}–${fmt.time(x.pred.hi)})`, label: 'predicted' } : null,
                ].filter(Boolean),
              },
            })),
            fmt: fmt.time,
            log: true,
            label: 'Times and predictions for the newest puzzle',
          }),
      })
    );
  }
  host.append(chartGrid(...cards));
}
