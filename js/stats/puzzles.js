/*
 * stats/puzzles.js — the puzzles behind the times: every solve with its
 * grid's features, constructors and editors, what correlates with a slow
 * solve, and the hardest and easiest puzzles by everyone's times.
 */

import { el, WEEKDAY_NAMES } from '../util.js';
import { median, spearman, pearson, correlationP, theilSen } from '../stats-math.js';
import { toCsv, groupBy } from '../stats-data.js';
import { chartCard, heatmap, xyChart, dotPlot, scaleLegend, downloadText, fmt } from '../charts.js';
import { sectionHead, sortableTable, puzzleName, breakdownHref, link, who, empty, chartGrid, tiles, tile, pText } from './common.js';

const diffText = (b) => (b == null ? '—' : fmt.rel(Math.exp(b)).replace('faster', 'easier').replace('slower', 'harder').replace('as usual', 'typical'));

export function render(host, ctx) {
  if (!ctx.rows.length) {
    host.append(empty('No solves in this selection yet.'));
    return;
  }
  const { fit, constructors } = ctx.models();
  host.append(...solvesTable(ctx, fit));
  host.append(...constructorSection(ctx, fit, constructors));
  host.append(...correlations(ctx));
  host.append(...difficulty(ctx, fit));
}

// ----- every puzzle solved -----

function solvesTable(ctx, fit) {
  const people = ctx.users;
  const byPuzzle = groupBy(ctx.rows, (r) => r.puzzleId);
  const allByPuzzle = groupBy(ctx.inType, (r) => r.puzzleId);
  const rows = [...byPuzzle].map(([id, rs]) => {
    const p = ctx.puzzles.get(id);
    const times = new Map(rs.map((r) => [r.user, r]));
    const field = (allByPuzzle.get(id) ?? []).map((r) => r.seconds).sort((a, b) => a - b);
    return { id, p, times, field, difficulty: fit?.puzzle.get(id) ?? null };
  });
  const single = people.length === 1 ? people[0] : null;
  const rankOf = (r, u) => {
    const t = r.times.get(u)?.seconds;
    if (t == null || r.field.length < 2) return null;
    return r.field.filter((x) => x < t).length + 1;
  };
  const columns = [
    { key: 'p', label: 'Puzzle', value: (r) => r.p?.date ?? r.id, show: (_, r) => link(breakdownHref(r.id, single ? r.times.get(single)?.solveId : null), puzzleName(r.p), r.p?.title || null) },
    { key: 'c', label: 'Constructor', value: (r) => r.p?.constructors.join(', ') ?? '', show: (v) => el('span', { class: 'clip', title: v }, v) },
    { key: 'size', label: 'Size', value: (r) => r.p?.size ?? null, show: (_, r) => `${r.p.width}×${r.p.height}`, num: true },
    { key: 'words', label: 'Words', value: (r) => r.p?.words ?? null, num: true },
    { key: 'blocks', label: 'Blocks', value: (r) => r.p?.blocks ?? null, num: true },
    { key: 'len', label: 'Avg len', value: (r) => r.p?.avgLen ?? null, show: (v) => v.toFixed(1), num: true },
    ...people.map((u) => ({
      key: `t:${u}`,
      label: single ? 'Time' : ctx.nameOf(u),
      value: (r) => r.times.get(u)?.seconds ?? null,
      show: (v, r) => {
        const fastest = Math.min(...[...r.times.values()].map((x) => x.seconds));
        const s = r.times.get(u);
        return el('span', { class: people.length > 1 && v === fastest ? 'fastest' : null }, [fmt.time(v), s.clean ? '' : el('span', { class: 'muted', title: s.reveal ? 'revealed' : 'checked' }, ' ·')]);
      },
      num: true,
    })),
    ...(single
      ? [
          { key: 'rel', label: 'vs usual', value: (r) => r.times.get(single)?.relative ?? null, show: fmt.rel, num: true },
          { key: 'rank', label: 'Rank', value: (r) => rankOf(r, single), show: (v, r) => `${v} of ${r.field.length}`, num: true, title: 'Among everyone here who solved it' },
        ]
      : []),
    { key: 'n', label: 'Solvers', value: (r) => r.field.length, num: true, better: -1 },
    { key: 'd', label: 'Difficulty', value: (r) => r.difficulty, show: diffText, num: true, better: -1, title: 'From everyone’s times: how much slower than a typical puzzle of the same weekday' },
  ];
  const csv = el(
    'button',
    {
      class: 'link-btn',
      type: 'button',
      onclick: () =>
        downloadText(
          `puzzles-${ctx.type}.csv`,
          toCsv(rows, [
            ['puzzle', (r) => r.id],
            ['date', (r) => r.p?.date],
            ['constructors', (r) => r.p?.constructors.join('; ')],
            ['width', (r) => r.p?.width],
            ['height', (r) => r.p?.height],
            ['words', (r) => r.p?.words],
            ['blocks', (r) => r.p?.blocks],
            ['avg_len', (r) => r.p?.avgLen],
            ['rebus', (r) => r.p?.rebus],
            ...people.map((u) => [`${u}_seconds`, (r) => r.times.get(u)?.seconds]),
            ['solvers', (r) => r.field.length],
            ['difficulty_log', (r) => r.difficulty?.toFixed(4)],
          ])
        ),
    },
    'Download CSV'
  );
  return [
    el('div', { class: 'section-head row' }, [
      el('div', {}, [el('h2', {}, 'Every puzzle'), el('p', { class: 'chart-sub' }, `${rows.length} puzzles. A dot after a time means a check or reveal. Click a heading to sort.`)]),
      csv,
    ]),
    sortableTable({ columns, rows, sort: { key: 'p', dir: -1 }, limit: 25 }),
  ];
}

// ----- constructors and editors -----

function constructorSection(ctx, fit, effects) {
  const byC = new Map();
  for (const r of ctx.rows) {
    for (const c of r.puzzle.constructors) {
      if (!byC.has(c)) byC.set(c, []);
      byC.get(c).push(r);
    }
  }
  if (!byC.size) return [];
  const rows = [...byC].map(([c, rs]) => ({
    c,
    n: new Set(rs.map((r) => r.puzzleId)).size,
    rel: median(rs.map((r) => r.relative)),
    best: rs.reduce((b, r) => (r.relative < b.relative ? r : b)),
    effect: effects.get(c) ?? null,
  }));
  const seasoned = rows.filter((r) => r.n >= 2);
  const nemesis = [...seasoned].sort((a, b) => b.rel - a.rel)[0];
  const favorite = [...seasoned].sort((a, b) => a.rel - b.rel)[0];
  const editors = [...groupBy(ctx.rows, (r) => r.puzzle.editor ?? '—')].map(([e, rs]) => ({ e, n: rs.length, rel: median(rs.map((r) => r.relative)) }));
  const out = [sectionHead('Constructors', 'Relative times (1× = the solver’s usual for that weekday), so a Saturday constructor isn’t “hard” just for making Saturdays. Difficulty uses everyone’s solves.')];
  if (nemesis && favorite && nemesis !== favorite) {
    out.push(
      tiles([
        tile({ label: 'Nemesis', value: nemesis.c, sub: `${fmt.rel(nemesis.rel)} than usual over ${nemesis.n} puzzles` }),
        tile({ label: 'Favorite', value: favorite.c, sub: `${fmt.rel(favorite.rel)} than usual over ${favorite.n} puzzles` }),
      ])
    );
  }
  out.push(
    sortableTable({
      columns: [
        { key: 'c', label: 'Constructor', value: (r) => r.c },
        { key: 'n', label: 'Puzzles', value: (r) => r.n, num: true, better: -1 },
        { key: 'rel', label: ctx.users.length > 1 ? 'Your group vs usual' : 'You vs usual', value: (r) => r.rel, show: fmt.rel, num: true },
        { key: 'best', label: 'Best', value: (r) => r.best.relative, show: (_, r) => link(breakdownHref(r.best.puzzleId, r.best.solveId), `${fmt.time(r.best.seconds)} (${puzzleName(r.best.puzzle)})`), num: true },
        { key: 'e', label: 'Difficulty (everyone)', value: (r) => r.effect?.effect ?? null, show: (v, r) => `${diffText(v)}${r.effect.n < 3 ? ' ?' : ''}`, num: true, better: -1, title: 'Average puzzle difficulty, shrunk toward typical when there are few puzzles (? = under 3)' },
      ],
      rows,
      sort: { key: 'n', dir: -1 },
      limit: 12,
    })
  );
  if (editors.length > 1) {
    out.push(
      sectionHead('Editors'),
      sortableTable({
        columns: [
          { key: 'e', label: 'Editor', value: (r) => r.e },
          { key: 'n', label: 'Solves', value: (r) => r.n, num: true, better: -1 },
          { key: 'rel', label: 'vs usual', value: (r) => r.rel, show: fmt.rel, num: true },
        ],
        rows: editors,
        sort: { key: 'n', dir: -1 },
      })
    );
  }
  return out;
}

// ----- correlations -----

const FEATURES = [
  ['log time', 'Time (log)', (r) => r.logT],
  ['relative', 'vs usual (log)', (r) => (r.relative > 0 ? Math.log(r.relative) : null)],
  ['words', 'Words', (r) => r.puzzle.words],
  ['blocks', 'Black squares', (r) => r.puzzle.blocks],
  ['avgLen', 'Avg word length', (r) => r.puzzle.avgLen],
  ['squares', 'White squares', (r) => r.puzzle.squares],
  ['rebus', 'Rebus squares', (r) => r.puzzle.rebus],
  ['circles', 'Circled squares', (r) => r.puzzle.circles],
  ['titled', 'Has a title', (r) => (r.puzzle.titled ? 1 : 0)],
  ['lag', 'Days after release', (r) => r.lagDays],
  ['hour', 'Hour solved', (r) => r.solveHour],
  ['first', 'First letter (s)', (r) => (r.summary?.first_ms != null ? r.summary.first_ms / 1000 : null)],
  ['errors', 'Wrong letters', (r) => r.summary?.wrong ?? null],
];

function correlations(ctx) {
  const rows = ctx.rows;
  // only features that vary here
  const feats = FEATURES.filter(([, , get]) => {
    const v = rows.map(get).filter((x) => x != null && Number.isFinite(x));
    return v.length >= 8 && new Set(v).size > 1;
  });
  if (feats.length < 3) return [];
  const pair = (fa, fb) => {
    const xs = [];
    const ys = [];
    for (const r of rows) {
      const a = fa[2](r);
      const b = fb[2](r);
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      xs.push(a);
      ys.push(b);
    }
    const rho = xs.length >= 8 ? spearman(xs, ys) : null;
    return { rho, n: xs.length, p: correlationP(rho, xs.length), r: xs.length >= 8 ? pearson(xs, ys) : null };
  };
  const target = FEATURES[1];
  const vsTarget = feats.filter((f) => f !== target && f !== FEATURES[0]).map((f) => ({ f, ...pair(f, target) })).filter((x) => x.rho != null);
  vsTarget.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  const scale = { type: 'div', min: -1, mid: 0, max: 1 };
  const matrix = chartCard({
    title: 'What goes with what',
    sub: 'Spearman rank correlation between every pair (−1 to 1) over this selection’s solves. Red: rise together; blue: one rises as the other falls. Time is also shown relative to usual, which takes the weekday out.',
    legend: scaleLegend(scale, { low: '−1', high: '+1' }),
    table: {
      columns: [['', (r) => r.f[1]], ...feats.map((g) => [g[1], (r) => pair(r.f, g).rho?.toFixed(2)])],
      rows: feats.map((f) => ({ f })),
    },
    draw: (w) =>
      heatmap(w, {
        rows: feats.map(([k, label]) => ({ key: k, label })),
        cols: feats.map(([k, label]) => ({ key: k, label })),
        scale,
        showValues: true,
        cellMax: 46,
        label: 'Correlation matrix',
        cell: (a, b) => {
          const fa = feats.find(([k]) => k === a);
          const fb = feats.find(([k]) => k === b);
          const c = pair(fa, fb);
          if (c.rho == null) return null;
          return {
            value: c.rho,
            text: a === b ? '' : c.rho.toFixed(1).replace('0.', '.').replace('-.', '−.'),
            tip: { title: `${fa[1]} × ${fb[1]}`, rows: [{ value: `ρ = ${c.rho.toFixed(2)}`, label: `${pText(c.p)}, n = ${c.n}` }, { value: `r = ${c.r?.toFixed(2) ?? '—'}`, label: 'Pearson' }] },
          };
        },
      }),
  });
  const top = vsTarget.slice(0, 4).map(({ f, rho, p, n }) => {
    const pts = rows.map((r) => ({ r, x: f[2](r), y: r.relative })).filter((d) => d.x != null && Number.isFinite(d.x) && d.y > 0);
    const ts = theilSen(pts.map((d) => d.x), pts.map((d) => Math.log(d.y)));
    const xmin = Math.min(...pts.map((d) => d.x));
    const xmax = Math.max(...pts.map((d) => d.x));
    return chartCard({
      title: `vs ${f[1].toLowerCase()}`,
      sub: `ρ = ${rho.toFixed(2)} · ${pText(p)} · n = ${n}`,
      table: {
        columns: [
          ['Puzzle', (d) => d.r.puzzleId],
          ['Solver', (d) => ctx.nameOf(d.r.user)],
          [f[1], (d) => d.x],
          ['vs usual', (d) => d.y.toFixed(3)],
        ],
        rows: pts,
      },
      draw: (w) =>
        xyChart(w, {
          height: 170,
          label: `Relative time against ${f[1]}`,
          x: { label: f[1] },
          y: { type: 'log', fmt: (v) => `${+v.toFixed(2)}×` },
          layers: [
            { type: 'rule', y: 1 },
            ...(ts ? [{ type: 'line', color: 'var(--color-text-muted)', width: 1.5, hover: false, points: [xmin, xmax].map((x) => ({ x, y: Math.exp(ts.intercept + ts.slope * x) })) }] : []),
            ...ctx.users.slice(0, 3).map((u) => ({
              type: 'dots',
              key: u,
              label: ctx.nameOf(u),
              color: ctx.colorOf(u),
              r: 3,
              points: pts
                .filter((d) => d.r.user === u)
                .map((d) => ({ x: d.x, y: d.y, href: breakdownHref(d.r.puzzleId, d.r.solveId), tip: { title: puzzleName(d.r.puzzle), rows: [{ value: fmt.rel(d.y), label: ctx.nameOf(u), color: ctx.colorOf(u) }, { value: String(+d.x.toFixed(2)), label: f[1] }] } })),
            })),
          ],
        }),
    });
  });
  return [
    sectionHead('Correlations', 'Does anything about a puzzle, or when it’s solved, go with a slow solve? The four strongest are plotted, with a robust (Theil–Sen) trend line. Correlation isn’t causation, and with few solves most of these are noise: check the p.'),
    chartGrid(matrix),
    el('div', { class: 'chart-grid small' }, top),
  ];
}

// ----- difficulty -----

function difficulty(ctx, fit) {
  if (!fit) return [];
  const solvedBy = groupBy(ctx.inType, (r) => r.puzzleId);
  const list = [...fit.puzzle]
    .filter(([id]) => (fit.puzzleN.get(id) ?? 0) >= 2)
    .map(([id, b]) => ({ id, b, p: ctx.puzzles.get(id), rs: solvedBy.get(id) ?? [] }))
    .sort((a, b) => b.b - a.b);
  if (list.length < 4) return [];
  const k = Math.min(8, Math.floor(list.length / 2));
  const pick = [...list.slice(0, k), ...list.slice(-k)];
  const mine = new Set(ctx.rows.map((r) => r.puzzleId));
  return [
    sectionHead('Hardest and easiest', `From everyone’s ${ctx.typeLabel.toLowerCase()} times (all time, puzzles with 2+ solvers): how much slower or faster each was than a typical puzzle of its weekday, after allowing for who solved it.`),
    chartGrid(
      chartCard({
        title: `The ${k} hardest and ${k} easiest`,
        sub: 'Faint dots: the difficulty each solver saw (their time against their own prediction).',
        table: {
          columns: [
            ['Puzzle', (r) => r.id],
            ['Difficulty', (r) => Math.exp(r.b), (v) => `${v.toFixed(2)}×`],
            ['Solvers', (r) => r.rs.length],
            ['Median time', (r) => median(r.rs.map((x) => x.seconds)), fmt.time],
          ],
          rows: list,
        },
        draw: (w) =>
          dotPlot(w, {
            rows: pick.map((x) => ({
              key: x.id,
              label: `${puzzleName(x.p)}${x.p?.constructors.length ? ` · ${x.p.constructors[0]}` : ''}`,
              color: x.b > 0 ? 'var(--color-div-5)' : 'var(--color-div-1)',
              strong: mine.has(x.id),
              value: Math.exp(x.b),
              values: x.rs.map((r) => Math.exp(Math.log(r.seconds) - fit.fitted(r) + x.b)),
              href: breakdownHref(x.id),
              tip: {
                title: puzzleName(x.p),
                rows: [
                  { value: diffText(x.b), label: 'than a typical one' },
                  { value: `${x.rs.length} solvers`, label: `median ${fmt.time(median(x.rs.map((r) => r.seconds)))}` },
                  ...(x.p?.constructors.length ? [{ value: x.p.constructors.join(', ') }] : []),
                ],
              },
            })),
            fmt: (v) => `${+v.toFixed(2)}×`,
            ticks: 'number',
            log: true,
            label: 'Puzzle difficulty',
          }),
        note: 'Bold names are puzzles in your current selection.',
      })
    ),
  ];
}
