/*
 * stats/trends.js — how times change: every solve over time with a
 * rolling median, the improvement rate, per-weekday panels with personal
 * records, clean rate by month, and volume.
 */

import { el, WEEKDAY_NAMES } from '../util.js';
import { median, ols, rollingMedian, studentTCdf, wilson } from '../stats-math.js';
import { recordProgression, groupBy } from '../stats-data.js';
import { chartCard, xyChart, barChart, legend, fmt } from '../charts.js';
import { WEEKDAY_ORDER, sectionHead, sortableTable, puzzleName, breakdownHref, who, empty, chartGrid, pText } from './common.js';

const MONTH = 30.44 * 86400000;

/**
 * More than three people on a chart where any two can overlap: one person
 * in color, the rest gray; the legend picks who. Up to three: everyone.
 */
export function emphasis(ctx, people = ctx.users) {
  const many = people.length > 3;
  const state = { focus: people.includes(ctx.me) ? ctx.me : people[0] };
  const figs = new Set();
  const holders = new Set();
  const fill = (holder) => {
    holder.textContent = '';
    holder.append(
      legend(
        people.map((u) => ({ key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), kind: 'dot', muted: many && u !== state.focus })),
        many ? { active: state.focus, onPick: pick } : {}
      )
    );
  };
  function pick(k) {
    state.focus = k;
    for (const h of holders) fill(h);
    for (const f of figs) f.redraw();
  }
  return {
    many,
    /** A legend kept in step with every other one from this emphasis. */
    legendEl() {
      const h = el('div', { class: 'legend-holder' });
      holders.add(h);
      fill(h);
      return h;
    },
    attach(f) {
      figs.add(f);
      return f;
    },
    muted: (u) => many && u !== state.focus,
    /** Draw order: the highlighted person last, on top. */
    order: () => (many ? [...people.filter((u) => u !== state.focus), state.focus] : people),
  };
}

/** Change per month in log(relative time): OLS slope with a 95% interval. */
export function improvement(rows) {
  const pts = rows.filter((r) => r.relative > 0 && Number.isFinite(r.completedAt));
  if (pts.length < 6) return null;
  const t0 = Math.min(...pts.map((r) => r.completedAt));
  const xs = pts.map((r) => (r.completedAt - t0) / MONTH);
  const span = Math.max(...xs);
  if (span < 0.5) return null;
  const fit = ols(xs, pts.map((r) => Math.log(r.relative)));
  if (!fit?.se) return null;
  const tcrit = 1.96;
  const p = 2 * (1 - studentTCdf(Math.abs(fit.slope / fit.se), pts.length - 2));
  return {
    n: pts.length,
    perMonth: Math.exp(fit.slope) - 1,
    lo: Math.exp(fit.slope - tcrit * fit.se) - 1,
    hi: Math.exp(fit.slope + tcrit * fit.se) - 1,
    overall: Math.exp(fit.slope * span) - 1,
    span,
    p,
  };
}

const pctChange = (x) => (x == null ? '—' : Math.abs(x) < 0.0005 ? 'no change' : `${Math.abs(x * 100).toFixed(1)}% ${x < 0 ? 'faster' : 'slower'}`);

function solveTip(ctx, r) {
  return {
    title: `${puzzleName(r.puzzle)} · ${ctx.nameOf(r.user)}`,
    rows: [
      { value: fmt.time(r.seconds), label: r.clean ? '★ clean' : r.reveal ? 'revealed' : 'checked', color: ctx.colorOf(r.user) },
      { value: fmt.rel(r.relative), label: 'vs usual' },
      { value: fmt.date(r.completedAt), label: 'solved' },
    ],
  };
}

export function render(host, ctx) {
  if (!ctx.rows.length) {
    host.append(empty('No solves in this selection yet.'));
    return;
  }
  const people = ctx.users;
  const rel = ctx.relative;
  const yFmt = rel ? (v) => `${+v.toFixed(2)}×` : fmt.time;

  // ----- every solve over time -----
  const emph = emphasis(ctx);
  const series = new Map(people.map((u) => [u, [...(ctx.byUser.get(u) ?? [])].sort((a, b) => a.completedAt - b.completedAt)]));
  const main = emph.attach(
    chartCard({
      title: rel ? 'Every solve, against your usual' : 'Every solve',
      sub: rel
        ? 'Each dot is a solve divided by that person’s median for the weekday (below 1× is faster than usual). The line is the median of the last 10.'
        : 'Each dot is a solve; the line is the median of the last 10. Mixed weekdays make this bumpy: try Relative, or pick one weekday above.',
      legend: people.length > 1 ? emph.legendEl() : null,
      table: {
        columns: [
          ['Solver', (r) => ctx.nameOf(r.user)],
          ['Puzzle', (r) => r.puzzleId],
          ['Solved', (r) => new Date(r.completedAt).toISOString().slice(0, 10)],
          ['Seconds', (r) => r.seconds],
          ['Relative', (r) => r.relative?.toFixed(3)],
        ],
        rows: ctx.rows,
      },
      draw: (w) =>
        xyChart(w, {
          height: 280,
          label: 'Solve times over time',
          x: { type: 'time' },
          y: { type: 'log', ticks: rel ? 'number' : 'time', fmt: yFmt },
          layers: [
            ...(rel ? [{ type: 'rule', y: 1, label: 'usual' }] : []),
            ...emph.order().flatMap((u) => {
              const rs = series.get(u);
              const vals = rs.map((r) => ctx.timeOf(r));
              const roll = rollingMedian(vals, 10);
              return [
                { type: 'dots', key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), muted: emph.muted(u), r: rs.length > 150 ? 3 : 4, points: rs.map((r, k) => ({ x: r.completedAt, y: vals[k], tip: solveTip(ctx, r), href: breakdownHref(r.puzzleId, r.solveId) })) },
                { type: 'line', key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), muted: emph.muted(u), hover: false, points: rs.map((r, k) => ({ x: r.completedAt, y: roll[k] })) },
              ];
            }),
          ],
        }),
    })
  );
  host.append(main);

  // ----- improvement -----
  const imp = people.map((u) => ({ user: u, ...(improvement(series.get(u)) ?? {}) }));
  host.append(
    sectionHead('Getting faster?', 'The trend in each person’s relative times (so easy and hard days don’t skew it): a least-squares line through log time against months, with its 95% range and how sure we can be it isn’t noise.'),
    sortableTable({
      columns: [
        { key: 'user', label: 'Solver', value: (r) => ctx.nameOf(r.user), show: (_, r) => who(ctx, r.user) },
        { key: 'n', label: 'Solves', value: (r) => r.n ?? null, num: true, better: -1 },
        { key: 'm', label: 'Per month', value: (r) => r.perMonth ?? null, show: pctChange, num: true },
        { key: 'ci', label: '95% range', value: (r) => r.lo ?? null, show: (_, r) => `${pctChange(r.lo)} to ${pctChange(r.hi)}`, num: true },
        { key: 'all', label: 'Over the whole span', value: (r) => r.overall ?? null, show: (v, r) => `${pctChange(v)} in ${r.span.toFixed(1)} mo`, num: true },
        { key: 'p', label: 'Signal?', value: (r) => r.p ?? null, show: (v) => `${pText(v)}${v < 0.05 ? ' ✓' : ''}`, num: true, title: 'p < 0.05 means a trend this steep would rarely come from noise alone' },
      ],
      rows: imp,
      sort: { key: 'm', dir: 1 },
    })
  );
  if (imp.every((r) => r.n == null)) host.append(el('p', { class: 'stats-note' }, 'Needs at least six solves spread over two weeks or more.'));

  // ----- per weekday: times, rolling median, personal records -----
  if (ctx.hasWeekdays) {
    host.append(sectionHead('By weekday', 'Actual times for each day of the week. Dots are solves, the line is the rolling median of 5, and the faint step line is the personal record so far.'));
    if (people.length > 1) host.append(emph.legendEl());
    const panels = WEEKDAY_ORDER.map((d) => weekdayPanel(ctx, d, emph)).filter(Boolean);
    host.append(el('div', { class: 'chart-grid small' }, panels));
  } else {
    host.append(chartGrid(weekdayPanel(ctx, null, emph)));
  }

  // ----- clean rate and volume -----
  host.append(chartGrid(cleanByMonth(ctx), volume(ctx)));
  host.append(chartGrid(cumulative(ctx)));
}

function weekdayPanel(ctx, d, emph) {
  const rows = ctx.rows.filter((r) => d == null || r.weekday === d);
  if (!rows.length) return null;
  const title = d == null ? 'Times and personal records' : WEEKDAY_NAMES[d];
  return emph.attach(
    chartCard({
      title,
      sub: `${rows.length} solve${rows.length === 1 ? '' : 's'} · median ${fmt.time(median(rows.map((r) => r.seconds)))}`,
      table: {
        columns: [
          ['Solver', (r) => ctx.nameOf(r.user)],
          ['Puzzle', (r) => r.puzzleId],
          ['Seconds', (r) => r.seconds],
        ],
        rows,
      },
      draw: (w) =>
        xyChart(w, {
          height: 170,
          label: `${title} solve times`,
          x: { type: 'time' },
          y: { type: 'log', ticks: 'time', fmt: fmt.time },
          layers: emph.order().flatMap((u) => {
            const rs = rows.filter((r) => r.user === u).sort((a, b) => a.completedAt - b.completedAt);
            if (!rs.length) return [];
            const color = ctx.colorOf(u);
            const muted = emph.muted(u);
            const roll = rollingMedian(rs.map((r) => r.seconds), 5);
            const prs = recordProgression(rs);
            return [
              { type: 'line', key: u, label: `${ctx.nameOf(u)} record`, color, muted, step: true, extend: true, width: 1.5, opacity: 0.45, hover: false, points: prs.map((r) => ({ x: r.completedAt, y: r.seconds })) },
              { type: 'line', key: u, label: ctx.nameOf(u), color, muted, width: 1.5, hover: false, points: rs.map((r, k) => ({ x: r.completedAt, y: roll[k] })) },
              { type: 'dots', key: u, label: ctx.nameOf(u), color, muted, points: rs.map((r) => ({ x: r.completedAt, y: r.seconds, tip: solveTip(ctx, r), href: breakdownHref(r.puzzleId, r.solveId) })) },
            ];
          }),
        }),
    })
  );
}

const monthKey = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};

function cleanByMonth(ctx) {
  const people = ctx.users;
  const data = people.map((u) => {
    const byMonth = groupBy(ctx.byUser.get(u) ?? [], (r) => monthKey(r.completedAt));
    return {
      u,
      pts: [...byMonth]
        .sort((a, b) => a[0] - b[0])
        .map(([m, rs]) => {
          const k = rs.filter((r) => r.clean).length;
          const ci = wilson(k, rs.length);
          return { x: m, y: k / rs.length, lo: ci.lo, hi: ci.hi, n: rs.length, k };
        }),
    };
  });
  const flat = data.flatMap(({ u, pts }) => pts.map((p) => ({ u, ...p })));
  if (flat.length < 2) return null;
  return chartCard({
    title: 'Clean solves by month',
    sub: people.length === 1 ? 'Share with no check or reveal; the band is the 95% range for a month with that many solves.' : 'Share of each month’s solves with no check or reveal.',
    legend: people.length > 1 ? legend(ctx.series().map((s) => ({ ...s, kind: 'line' }))) : null,
    table: {
      columns: [
        ['Solver', (r) => ctx.nameOf(r.u)],
        ['Month', (r) => new Date(r.x).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })],
        ['Clean', (r) => r.k],
        ['Solves', (r) => r.n],
        ['Share', (r) => r.y, fmt.pct],
      ],
      rows: flat,
    },
    draw: (w) =>
      xyChart(w, {
        height: 200,
        label: 'Clean solve share by month',
        x: { type: 'time' },
        y: { min: 0, max: 1, fmt: fmt.pct },
        hover: 'x',
        layers: data.flatMap(({ u, pts }) => [
          ...(people.length === 1 ? [{ type: 'band', color: ctx.colorOf(u), points: pts.map((p) => ({ x: p.x, lo: p.lo, hi: p.hi })) }] : []),
          { type: 'line', key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), points: pts },
        ]),
      }),
  });
}

const weekStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};

function volume(ctx) {
  const weeks = [...new Set(ctx.rows.map((r) => weekStart(r.completedAt)))].sort((a, b) => a - b);
  if (!weeks.length) return null;
  const all = [];
  for (let w = weeks[0]; w <= weeks.at(-1); w += 7 * 86400000) all.push(weekStart(w + 3600_000 * 12));
  const uniq = [...new Set(all)];
  const counts = new Map();
  for (const r of ctx.rows) {
    const k = `${weekStart(r.completedAt)}|${r.user}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const cats = uniq.map((w) => ({ key: w, label: new Date(w).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }));
  return chartCard({
    title: 'Solves per week',
    sub: 'Weeks start on Monday.',
    legend: ctx.users.length > 1 ? legend(ctx.series()) : null,
    table: {
      columns: [['Week of', (r) => new Date(r.key).toISOString().slice(0, 10)], ...ctx.users.map((u) => [ctx.nameOf(u), (r) => counts.get(`${r.key}|${u}`) ?? 0])],
      rows: cats,
    },
    draw: (w) =>
      barChart(w, {
        categories: cats,
        series: ctx.series(),
        value: (wk, u) => counts.get(`${wk}|${u}`) ?? null,
        stacked: true,
        fmt: (v) => fmt.int(v),
        height: 200,
        valueLabels: cats.length <= 16,
        label: 'Solves per week',
      }),
  });
}

function cumulative(ctx) {
  const data = ctx.users.map((u) => {
    const rs = [...(ctx.byUser.get(u) ?? [])].sort((a, b) => a.completedAt - b.completedAt);
    return { u, pts: rs.map((r, k) => ({ x: r.completedAt, y: k + 1 })) };
  });
  if (!data.some((d) => d.pts.length)) return null;
  return chartCard({
    title: 'Total solved',
    sub: 'Running count in this selection.',
    legend: ctx.users.length > 1 ? legend(ctx.series().map((s) => ({ ...s, kind: 'line' }))) : null,
    table: {
      columns: [['Solver', (r) => ctx.nameOf(r.u)], ['Solved', (r) => r.pts.length]],
      rows: data,
    },
    draw: (w) =>
      xyChart(w, {
        height: 200,
        label: 'Running total of solves',
        x: { type: 'time' },
        y: { zero: true, fmt: (v) => fmt.int(v) },
        hover: 'x',
        layers: data.map(({ u, pts }) => ({ type: 'line', key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), step: true, points: pts })),
      }),
  });
}
