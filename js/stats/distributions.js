/*
 * stats/distributions.js — the shape of the times: histogram and density,
 * box or violin plots per weekday, a percentile table, consistency, the
 * outliers, and what assists cost.
 */

import { el, WEEKDAY_NAMES } from '../util.js';
import { describe, median, pearson, correlationP, tukeyFences } from '../stats-math.js';
import { chartCard, histogramChart, boxChart, dotPlot, legend, fmt } from '../charts.js';
import { WEEKDAY_ORDER, wd, sectionHead, sortableTable, puzzleName, breakdownHref, link, who, empty, chartGrid, pText } from './common.js';

export function render(host, ctx) {
  if (!ctx.rows.length) {
    host.append(empty('No solves in this selection yet.'));
    return;
  }
  const people = ctx.users;
  const rel = ctx.relative;
  const f = rel ? (v) => `${+v.toFixed(2)}×` : fmt.time;

  // ----- histogram / density -----
  const hist = chartCard({
    title: rel ? 'How your times spread, against your usual' : 'How your times spread',
    sub:
      people.length === 1
        ? `Bars count solves; the curve is a smoothed version of them. Log scale${rel ? ': 1× is your usual for that weekday' : ''}.`
        : 'Each curve is one person’s smoothed spread of times (share of their solves). Log scale.',
    legend: people.length > 1 ? legend(ctx.series().map((s) => ({ ...s, kind: 'line' }))) : null,
    table: {
      columns: [['Solver', (r) => ctx.nameOf(r.user)], ['Puzzle', (r) => r.puzzleId], [rel ? 'Relative' : 'Seconds', (r) => ctx.timeOf(r)]],
      rows: ctx.rows,
    },
    draw: (w) =>
      histogramChart(w, {
        series: people.map((u) => ({ key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), values: (ctx.byUser.get(u) ?? []).map(ctx.timeOf) })),
        fmt: f,
        ticks: rel ? 'number' : 'time',
        log: true,
        height: 220,
        label: 'Distribution of solve times',
      }),
  });

  // ----- box or violin per weekday -----
  const view = { violin: false };
  const controls = el('div', { class: 'chart-controls' });
  let boxFig = null;
  const drawControls = () => {
    controls.textContent = '';
    controls.append(
      ...[
      el(
        'div',
        { class: 'segmented small', role: 'group', 'aria-label': 'Shape' },
        [
          ['box', 'Box'],
          ['violin', 'Violin'],
        ].map(([k, label]) =>
          el(
            'button',
            {
              type: 'button',
              class: (k === 'violin') === view.violin ? 'active' : null,
              'aria-pressed': String((k === 'violin') === view.violin),
              onclick: () => {
                view.violin = k === 'violin';
                drawControls();
                boxFig?.redraw();
              },
            },
            label
          )
        )
      ),
      people.length > 1 ? legend(ctx.series()) : null,
      ].filter(Boolean)
    );
  };
  drawControls();
  const groups = ctx.hasWeekdays ? WEEKDAY_ORDER.map((d) => ({ key: d, label: wd(d) })) : [{ key: 'all', label: ctx.typeLabel }];
  const inGroup = (g) => (r) => g === 'all' || r.weekday === g;
  boxFig = chartCard({
    title: ctx.hasWeekdays ? 'Times by weekday' : 'Times',
    sub: 'Box: the middle half of solves, the line inside is the median, whiskers reach the furthest solve within 1.5 box-lengths; dots beyond are outliers. Actual times, log scale.',
    legend: controls,
    table: {
      columns: [
        ['Day', (r) => r.label],
        ['Solver', (r) => ctx.nameOf(r.u)],
        ['Solves', (r) => r.d.n],
        ['Median', (r) => r.d.median, fmt.time],
        ['25th pct', (r) => r.d.p25, fmt.time],
        ['75th pct', (r) => r.d.p75, fmt.time],
      ],
      rows: groups.flatMap((g) => people.map((u) => ({ label: g.label, u, d: describe((ctx.byUser.get(u) ?? []).filter(inGroup(g.key)).map((r) => r.seconds)) }))).filter((r) => r.d.n),
    },
    draw: (w) =>
      boxChart(w, {
        groups,
        series: ctx.series(),
        values: (g, u) => (ctx.byUser.get(u) ?? []).filter(inGroup(g)).map((r) => r.seconds),
        fmt: fmt.time,
        log: true,
        violin: view.violin,
        label: 'Solve times by weekday',
      }),
  });
  host.append(chartGrid(hist), chartGrid(boxFig));

  // ----- percentile table -----
  host.append(
    sectionHead('Percentiles', 'Actual times. p10 means 10% of solves were faster. CV (standard deviation ÷ mean) measures spread: lower is steadier.'),
    percentileTable(ctx, groups, inGroup)
  );

  // ----- consistency -----
  host.append(sectionHead('Consistency', 'On relative times, so the weekday mix doesn’t count as inconsistency. “Momentum” is the correlation between one solve and the next: above 0, good days tend to follow good days.'));
  host.append(consistency(ctx));

  // ----- assists -----
  const assist = assistCosts(ctx);
  if (assist) host.append(chartGrid(assist));

  // ----- outliers -----
  host.append(sectionHead('Outliers', 'Solves far from the person’s usual (beyond 1.5 box-lengths on relative times).'), outliers(ctx));
}

function percentileTable(ctx, groups, inGroup) {
  const rows = [];
  for (const g of groups) {
    for (const u of ctx.users) {
      const d = describe((ctx.byUser.get(u) ?? []).filter(inGroup(g.key)).map((r) => r.seconds));
      if (d.n) rows.push({ g, u, d });
    }
  }
  const t = (key) => ({ key, label: key === 'median' ? 'Median' : key, value: (r) => r.d[key], show: fmt.time, num: true });
  return sortableTable({
    columns: [
      { key: 'g', label: 'Day', value: (r) => (typeof r.g.key === 'number' ? (r.g.key + 6) % 7 : 0), show: (_, r) => r.g.label },
      ...(ctx.users.length > 1 ? [{ key: 'u', label: 'Solver', value: (r) => ctx.nameOf(r.u), show: (_, r) => who(ctx, r.u) }] : []),
      { key: 'n', label: 'n', value: (r) => r.d.n, num: true, better: -1 },
      t('min'),
      t('p10'),
      t('p25'),
      t('median'),
      t('p75'),
      t('p90'),
      t('max'),
      { key: 'mean', label: 'Mean', value: (r) => r.d.mean, show: fmt.time, num: true },
      { key: 'sd', label: 'SD', value: (r) => r.d.sd, show: (v) => fmt.time(v), num: true },
      { key: 'cv', label: 'CV', value: (r) => r.d.cv, show: (v) => v.toFixed(2), num: true },
    ],
    rows,
  });
}

function consistency(ctx) {
  const rows = ctx.users.map((u) => {
    const rs = [...(ctx.byUser.get(u) ?? [])].sort((a, b) => a.completedAt - b.completedAt);
    const logs = rs.map((r) => Math.log(r.relative)).filter(Number.isFinite);
    const d = describe(rs.map((r) => r.relative));
    const r1 = logs.length >= 8 ? pearson(logs.slice(0, -1), logs.slice(1)) : null;
    return {
      u,
      n: rs.length,
      spread: d.n ? d.p75 / d.p25 : null,
      cv: d.cv ?? null,
      within10: rs.length ? rs.filter((r) => Math.abs(r.relative - 1) <= 0.1).length / rs.length : null,
      momentum: r1,
      p: r1 == null ? null : correlationP(r1, logs.length - 1),
    };
  });
  return sortableTable({
    columns: [
      { key: 'u', label: 'Solver', value: (r) => ctx.nameOf(r.u), show: (_, r) => who(ctx, r.u) },
      { key: 'n', label: 'Solves', value: (r) => r.n, num: true, better: -1 },
      { key: 'spread', label: 'p75 ÷ p25', value: (r) => r.spread, show: (v) => `${v.toFixed(2)}×`, num: true, title: 'How much slower your slower-typical solves are than your faster-typical ones' },
      { key: 'cv', label: 'CV', value: (r) => r.cv, show: (v) => v.toFixed(2), num: true },
      { key: 'w10', label: 'Within 10% of usual', value: (r) => r.within10, show: fmt.pct, num: true, better: -1 },
      { key: 'mom', label: 'Momentum', value: (r) => r.momentum, show: (v, r) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} (${pText(r.p)})`, num: true, better: -1 },
    ],
    rows,
  });
}

/** Median relative time for clean, checked and revealed solves. */
function assistCosts(ctx) {
  const kinds = [
    ['clean', 'Clean', (r) => r.clean],
    ['checked', 'Checked (no reveal)', (r) => r.check && !r.reveal],
    ['revealed', 'Revealed', (r) => r.reveal],
  ];
  const rows = [];
  for (const u of ctx.users) {
    for (const [k, label, test] of kinds) {
      const v = (ctx.byUser.get(u) ?? []).filter(test).map((r) => r.relative);
      if (v.length) rows.push({ key: `${u}|${k}`, u, k, label: ctx.users.length > 1 ? `${ctx.nameOf(u)} · ${label}` : label, color: ctx.colorOf(u), value: median(v), values: v, n: v.length });
    }
  }
  if (rows.filter((r) => r.k !== 'clean').length === 0) return null;
  return chartCard({
    title: 'What assists cost',
    sub: 'Median relative time (1× = usual) for clean solves and for those with a check or a reveal. Faint dots are the single solves.',
    table: {
      columns: [
        ['Group', (r) => r.label],
        ['Solves', (r) => r.n],
        ['Median relative', (r) => r.value, (v) => `${v.toFixed(2)}×`],
      ],
      rows,
    },
    draw: (w) =>
      dotPlot(w, {
        rows: rows.map((r) => ({ ...r, tip: { title: r.label, rows: [{ value: `${r.value.toFixed(2)}×`, label: `median of ${r.n}`, color: r.color }, { value: fmt.rel(r.value) }] } })),
        fmt: (v) => `${+v.toFixed(2)}×`,
        ticks: 'number',
        log: true,
        label: 'Median relative time by assist use',
      }),
  });
}

function outliers(ctx) {
  const rows = [];
  for (const u of ctx.users) {
    const rs = ctx.byUser.get(u) ?? [];
    if (rs.length < 8) continue;
    const { lo, hi } = tukeyFences(rs.map((r) => Math.log(r.relative)));
    for (const r of rs) {
      const x = Math.log(r.relative);
      if (x < lo || x > hi) rows.push({ ...r, kind: x < lo ? 'fast' : 'slow' });
    }
  }
  if (!rows.length) return el('p', { class: 'stats-note' }, 'Nothing unusual (it takes 8+ solves per person to call anything an outlier).');
  return sortableTable({
    columns: [
      { key: 'kind', label: '', value: (r) => r.kind, show: (v) => (v === 'fast' ? '⚡ fast' : '🐢 slow') },
      ...(ctx.users.length > 1 ? [{ key: 'u', label: 'Solver', value: (r) => ctx.nameOf(r.user), show: (_, r) => who(ctx, r.user) }] : []),
      { key: 'p', label: 'Puzzle', value: (r) => r.date ?? r.puzzleId, show: (_, r) => link(breakdownHref(r.puzzleId, r.solveId), puzzleName(r.puzzle)) },
      { key: 'wd', label: 'Day', value: (r) => r.weekday, show: (v) => (v == null ? '—' : WEEKDAY_NAMES[v].slice(0, 3)) },
      { key: 't', label: 'Time', value: (r) => r.seconds, show: fmt.time, num: true },
      { key: 'rel', label: 'vs usual', value: (r) => r.relative, show: fmt.rel, num: true },
      { key: 'c', label: 'Assists', value: (r) => (r.clean ? 0 : 1), show: (_, r) => (r.clean ? '★' : r.reveal ? 'revealed' : 'checked') },
    ],
    rows,
    sort: { key: 'rel', dir: 1 },
  });
}
