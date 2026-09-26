/*
 * stats/style.js — how people solve, from the move-by-move logs: pace,
 * first letter, typos and fixes, the typo hunt, across vs down, the
 * average progress curve, time per entry by length, letter mix-ups, the
 * most-missed answers, where solves start and which corner falls first.
 * Solves from before logging began (and partial logs) are left out.
 */

import { el } from '../util.js';
import { median, mean } from '../stats-math.js';
import { chartCard, xyChart, heatmap, gridHeatmap, barChart, legend, scaleLegend, fmt } from '../charts.js';
import { sectionHead, sortableTable, tiles, tile, who, empty, chartGrid, note, puzzleName, breakdownHref, link } from './common.js';

const secs = (ms) => (ms == null ? null : ms / 1000);

/** Hides an answer until the viewer has solved its puzzle or clicks. */
export function spoiler(ctx, text, puzzleId) {
  if (ctx.solvedByMe?.has(puzzleId)) return text;
  const span = el('button', { type: 'button', class: 'spoiler', title: 'You haven’t solved this one yet. Click to show anyway.' }, text);
  span.addEventListener('click', () => span.classList.add('shown'), { once: true });
  return span;
}

export async function render(host, ctx) {
  ctx.solvedByMe = new Set([...ctx.ds.solves.filter((r) => r.user === ctx.me).map((r) => r.puzzleId), ...ctx.ds.coop.filter((c) => c.members.includes(ctx.me)).map((c) => c.puzzleId)]);
  const logged = ctx.rows.filter((r) => r.summary && !r.summary.partial);
  const since = ctx.inType.filter((r) => r.summary).reduce((m, r) => Math.min(m, r.completedAt), Infinity);
  if (!logged.length) {
    host.append(
      empty(
        Number.isFinite(since)
          ? 'No logged solves in this selection. Try a wider date range.'
          : 'Solve style needs solves recorded move by move, which started with this update. Solve a puzzle and come back!'
      )
    );
    return;
  }
  host.append(note(`From ${logged.length} solve${logged.length === 1 ? '' : 's'} recorded move by move (recording began ${fmt.date(since)}; older solves only have a time).`));

  const people = ctx.users.filter((u) => logged.some((r) => r.user === u));
  const stats = people.map((u) => metrics(logged.filter((r) => r.user === u)));
  if (people.length === 1) host.append(tiles(styleTiles(stats[0])));
  else host.append(sectionHead('Side by side'), styleTable(ctx, people, stats));

  // details: per-entry and per-letter data, per person
  const detailMaps = await Promise.all(people.map((u) => ctx.details(u)));
  const detailOf = new Map();
  people.forEach((u, k) => {
    const ids = new Set(logged.filter((r) => r.user === u).map((r) => r.solveId));
    detailOf.set(
      u,
      Object.entries(detailMaps[k])
        .filter(([id]) => ids.has(id))
        .map(([id, d]) => ({ id, ...d, row: logged.find((r) => r.solveId === id) }))
    );
  });

  host.append(chartGrid(progressCurve(ctx, people, detailOf), dwellByLength(ctx, people, detailOf)));
  host.append(chartGrid(startMap(ctx, logged), quadrantOrder(ctx, people, detailOf)));
  host.append(chartGrid(confusions(ctx, people, detailOf)));
  host.append(sectionHead('Most-missed answers', 'Entries that got a wrong letter, a check or a reveal, most often first. Answers to puzzles you haven’t solved are hidden until you click them.'), missed(ctx, people, detailOf));
}

function metrics(rows) {
  const s = rows.map((r) => r.summary);
  const med = (f) => {
    const v = s.map(f).filter((x) => x != null && Number.isFinite(x));
    return v.length ? median(v) : null;
  };
  const letters = s.reduce((a, x) => a + x.letters, 0);
  const across = s.reduce((a, x) => a + x.across, 0);
  const down = s.reduce((a, x) => a + x.down, 0);
  return {
    n: rows.length,
    first: med((x) => secs(x.first_ms)),
    pace: med((x) => (x.ms > 0 ? x.cells / (x.ms / 60000) : null)),
    overtype: med((x) => (x.cells ? x.letters / x.cells : null)),
    errorRate: letters ? s.reduce((a, x) => a + x.wrong, 0) / letters : null,
    fixMs: med((x) => x.fix_ms),
    huntShare: s.filter((x) => x.finish_ms > 2000).length / s.length,
    hunt: med((x) => (x.finish_ms > 2000 ? secs(x.finish_ms) : null)),
    stall: med((x) => secs(x.stall_ms)),
    stallShare: med((x) => (x.ms ? x.stall_ms / x.ms : null)),
    across: across + down ? across / (across + down) : null,
    pencil: letters ? s.reduce((a, x) => a + x.pencil, 0) / letters : null,
    checks: mean(s.map((x) => x.checks.letter + x.checks.word + x.checks.puzzle)),
    reveals: mean(s.map((x) => x.reveals.letter + x.reveals.word + x.reveals.puzzle)),
    sittings: mean(s.map((x) => x.sittings || 1)),
    oneAcross: s.filter((x) => x.start_word === 'A1').length / s.length,
  };
}

function styleTiles(m) {
  return [
    tile({ label: 'First letter', value: m.first == null ? '—' : fmt.time(m.first), sub: 'median wait before typing anything' }),
    tile({ label: 'Pace', value: m.pace == null ? '—' : `${m.pace.toFixed(1)}/min`, sub: 'squares per minute (median)' }),
    tile({ label: 'Typos', value: m.errorRate == null ? '—' : fmt.pct1(m.errorRate), sub: `of letters typed were wrong · fixed after ${m.fixMs == null ? '—' : fmt.time(m.fixMs / 1000)} (median)` }),
    tile({ label: 'Typo hunts', value: fmt.pct(m.huntShare), sub: m.hunt == null ? 'of solves: grid full but not right' : `of solves; median hunt ${fmt.time(m.hunt)}` }),
    tile({ label: 'Longest stall', value: m.stall == null ? '—' : fmt.time(m.stall), sub: `median; ${m.stallShare == null ? '—' : fmt.pct(m.stallShare)} of a typical solve` }),
    tile({ label: 'Across vs down', value: m.across == null ? '—' : `${Math.round(m.across * 100)} / ${Math.round((1 - m.across) * 100)}`, sub: 'letters typed going across / down' }),
    tile({ label: 'Starts at 1-Across', value: fmt.pct(m.oneAcross), sub: 'of solves begin there' }),
    tile({ label: 'Retyping', value: m.overtype == null ? '—' : `${m.overtype.toFixed(2)}×`, sub: 'letters typed per square (1× = never retyped)' }),
    tile({ label: 'Pencil', value: m.pencil == null ? '—' : fmt.pct1(m.pencil), sub: 'of letters in pencil' }),
    tile({ label: 'Assists', value: `${m.checks.toFixed(2)} / ${m.reveals.toFixed(2)}`, sub: 'checks / reveals per solve' }),
    tile({ label: 'Sittings', value: m.sittings.toFixed(2), sub: 'per solve on average' }),
  ];
}

function styleTable(ctx, people, stats) {
  const rows = people.map((u, k) => ({ u, ...stats[k] }));
  const n = (key, label, show, better = 1, title = null) => ({ key, label, value: (r) => r[key], show, num: true, better, title });
  return sortableTable({
    columns: [
      { key: 'u', label: 'Solver', value: (r) => ctx.nameOf(r.u), show: (_, r) => who(ctx, r.u) },
      n('n', 'Logged', null, -1),
      n('first', 'First letter', fmt.time),
      n('pace', 'Squares/min', (v) => v.toFixed(1), -1),
      n('errorRate', 'Typos', fmt.pct1),
      n('huntShare', 'Typo hunts', fmt.pct),
      n('stall', 'Longest stall', fmt.time),
      n('across', 'Across share', fmt.pct, -1),
      n('oneAcross', 'Start at 1A', fmt.pct, -1),
      n('overtype', 'Retyping', (v) => `${v.toFixed(2)}×`),
      n('pencil', 'Pencil', fmt.pct1, -1),
      n('checks', 'Checks', (v) => v.toFixed(2)),
      n('reveals', 'Reveals', (v) => v.toFixed(2)),
      n('sittings', 'Sittings', (v) => v.toFixed(2)),
    ],
    rows,
    sort: { key: 'pace', dir: -1 },
    rowClass: (r) => (r.u === ctx.me ? 'you' : null),
  });
}

function progressCurve(ctx, people, detailOf) {
  const avg = people
    .map((u) => {
      const curves = detailOf.get(u).map((d) => d.detail.curve?.correct).filter((c) => c?.length === 51);
      if (!curves.length) return null;
      return { u, n: curves.length, pts: curves[0].map((_, k) => ({ x: k * 2, y: mean(curves.map((c) => c[k])) })) };
    })
    .filter(Boolean);
  if (!avg.length) return null;
  return chartCard({
    title: 'The shape of a solve',
    sub: 'Share of squares correct at each point of the solve’s time, averaged over logged solves. A straight diagonal would be a steady pace; most solves start slow and speed up as crossings help.',
    legend: people.length > 1 ? legend(avg.map((a) => ({ key: a.u, label: ctx.nameOf(a.u), color: ctx.colorOf(a.u), kind: 'line' }))) : null,
    table: {
      columns: [['% of time', (r) => r.x], ...avg.map((a) => [ctx.nameOf(a.u), (r) => a.pts[r.x / 2].y, (v) => `${Math.round(v)}%`])],
      rows: avg[0].pts.map((p) => ({ x: p.x })),
    },
    draw: (w) =>
      xyChart(w, {
        height: 240,
        label: 'Average progress curve',
        x: { min: 0, max: 100, fmt: (v) => `${v}%`, label: 'time into the solve' },
        y: { min: 0, max: 100, fmt: (v) => `${v}%`, label: 'squares right' },
        hover: 'x',
        layers: [
          { type: 'line', color: 'var(--color-chart-axis)', width: 1, hover: false, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
          ...avg.map((a) => ({ type: 'line', key: a.u, label: ctx.nameOf(a.u), color: ctx.colorOf(a.u), points: a.pts })),
        ],
      }),
  });
}

function dwellByLength(ctx, people, detailOf) {
  const data = people.map((u) => {
    const byLen = new Map();
    for (const d of detailOf.get(u)) {
      for (const w of d.detail.words ?? []) {
        const [, len, , , , dwell] = w;
        if (dwell == null) continue;
        if (!byLen.has(len)) byLen.set(len, []);
        byLen.get(len).push(dwell / 1000);
      }
    }
    return { u, pts: [...byLen].filter(([, v]) => v.length >= 3).sort((a, b) => a[0] - b[0]).map(([len, v]) => ({ x: len, y: median(v), n: v.length })) };
  });
  if (!data.some((d) => d.pts.length > 1)) return null;
  return chartCard({
    title: 'Time on an entry by its length',
    sub: 'Median time with the cursor on an entry (all visits added up), by answer length.',
    legend: people.length > 1 ? legend(data.map((d) => ({ key: d.u, label: ctx.nameOf(d.u), color: ctx.colorOf(d.u), kind: 'line' }))) : null,
    table: {
      columns: [
        ['Solver', (r) => ctx.nameOf(r.u)],
        ['Length', (r) => r.x],
        ['Median seconds', (r) => r.y.toFixed(1)],
        ['Entries', (r) => r.n],
      ],
      rows: data.flatMap((d) => d.pts.map((p) => ({ u: d.u, ...p }))),
    },
    draw: (w) =>
      xyChart(w, {
        height: 240,
        label: 'Median dwell time by answer length',
        x: { fmt: (v) => String(v), label: 'letters' },
        y: { zero: true, ticks: 'time', fmt: fmt.time },
        hover: 'x',
        layers: data.flatMap((d) => [
          { type: 'line', key: d.u, label: ctx.nameOf(d.u), color: ctx.colorOf(d.u), points: d.pts },
          { type: 'dots', key: d.u, label: ctx.nameOf(d.u), color: ctx.colorOf(d.u), points: d.pts.map((p) => ({ ...p, tip: { title: `${p.x}-letter entries`, rows: [{ value: fmt.time(p.y), label: `${ctx.nameOf(d.u)}, median of ${p.n}`, color: ctx.colorOf(d.u) }] } })) },
        ]),
      }),
  });
}

function startMap(ctx, logged) {
  const sizes = new Map();
  for (const r of logged) {
    const s = r.summary;
    if (s.start_cell == null || !s.w) continue;
    const k = `${s.w}x${s.h}`;
    if (!sizes.has(k)) sizes.set(k, []);
    sizes.get(k).push(s.start_cell);
  }
  const [size, cells] = [...sizes].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (!size || cells.length < 3) return null;
  const [w, h] = size.split('x').map(Number);
  const counts = new Map();
  for (const c of cells) counts.set(c, (counts.get(c) ?? 0) + 1);
  const max = Math.max(...counts.values());
  const model = { width: w, height: h, cells: Array.from({ length: w * h }, () => ({ isBlack: false, number: 0 })) };
  const scale = { type: 'seq', min: 0, max };
  return chartCard({
    title: 'Where solves start',
    sub: `The first letter typed, over ${cells.length} ${size.replace('x', '×')} solves${ctx.users.length > 1 ? ' by everyone picked' : ''}.`,
    legend: scaleLegend(scale, { low: 'rarely', high: `${max}×` }),
    table: {
      columns: [
        ['Row', (r) => Math.floor(r[0] / w) + 1],
        ['Column', (r) => (r[0] % w) + 1],
        ['Starts', (r) => r[1]],
      ],
      rows: [...counts].sort((a, b) => b[1] - a[1]),
    },
    draw: (width) =>
      gridHeatmap(Math.min(width, 360), {
        model,
        scale,
        maxCell: 26,
        label: 'Starting squares',
        value: (i) => counts.get(i) ?? null,
        tip: (i) => (counts.get(i) ? { title: `Row ${Math.floor(i / w) + 1}, column ${(i % w) + 1}`, rows: [{ value: `${counts.get(i)} start${counts.get(i) === 1 ? '' : 's'}` }] } : null),
      }),
  });
}

function quadrantOrder(ctx, people, detailOf) {
  const qs = ['NW', 'NE', 'SW', 'SE'];
  const labels = { NW: 'Top left', NE: 'Top right', SW: 'Bottom left', SE: 'Bottom right' };
  const counts = new Map();
  const totals = new Map();
  for (const u of people) {
    for (const d of detailOf.get(u)) {
      const qd = (d.detail.quadrants ?? []).filter((q) => q[2] != null);
      if (qd.length < 4) continue;
      const first = qd.reduce((b, q) => (q[2] < b[2] ? q : b))[0];
      counts.set(`${u}|${first}`, (counts.get(`${u}|${first}`) ?? 0) + 1);
      totals.set(u, (totals.get(u) ?? 0) + 1);
    }
  }
  if (!totals.size) return null;
  const series = ctx.series(people.filter((u) => totals.has(u)).slice(0, 3));
  return chartCard({
    title: 'Which corner is finished first',
    sub: 'The quarter of the grid that was completely right first.',
    legend: series.length > 1 ? legend(series) : null,
    table: {
      columns: [['Corner', (r) => labels[r.q]], ...series.map((s) => [s.label, (r) => counts.get(`${s.key}|${r.q}`) ?? 0])],
      rows: qs.map((q) => ({ q })),
    },
    draw: (w) =>
      barChart(w, {
        categories: qs.map((q) => ({ key: q, label: labels[q] })),
        series,
        value: (q, u) => (totals.get(u) ? (counts.get(`${u}|${q}`) ?? 0) / totals.get(u) : null),
        fmt: fmt.pct,
        height: 200,
        valueLabels: series.length === 1,
        label: 'Share of solves by first finished quarter',
      }),
  });
}

function confusions(ctx, people, detailOf) {
  const counts = new Map();
  for (const u of people) {
    for (const d of detailOf.get(u)) {
      for (const [k, n] of Object.entries(d.detail.confusions ?? {})) counts.set(k, (counts.get(k) ?? 0) + n);
    }
  }
  if (counts.size < 3) return null;
  const involvement = new Map();
  for (const [k, n] of counts) {
    const [a, b] = k.split('>');
    involvement.set(a, (involvement.get(a) ?? 0) + n);
    involvement.set(b, (involvement.get(b) ?? 0) + n);
  }
  const letters = [...involvement].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([l]) => l).sort();
  const max = Math.max(...counts.values());
  const scale = { type: 'seq', min: 0, max };
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k.replace('>', ' for ')} (${n})`);
  return chartCard({
    title: 'Letter mix-ups',
    sub: `Wrong letter typed (row) where the answer had another (column), over every logged solve. Most common: ${top.join(', ')}.`,
    legend: scaleLegend(scale, { low: '1', high: String(max) }),
    table: {
      columns: [
        ['Typed', (r) => r[0].split('>')[0]],
        ['Answer', (r) => r[0].split('>')[1]],
        ['Times', (r) => r[1]],
      ],
      rows: [...counts].sort((a, b) => b[1] - a[1]),
    },
    draw: (w) =>
      heatmap(w, {
        rows: letters.map((l) => ({ key: l, label: l })),
        cols: letters.map((l) => ({ key: l, label: l })),
        scale,
        showValues: true,
        cellMax: 30,
        label: 'Letter confusion matrix',
        cell: (a, b) => {
          const n = counts.get(`${a}>${b}`);
          return n ? { value: n, text: String(n), tip: { title: `Typed ${a}, answer ${b}`, rows: [{ value: `${n} time${n === 1 ? '' : 's'}` }] } } : null;
        },
      }),
  });
}

function missed(ctx, people, detailOf) {
  const byAnswer = new Map();
  for (const u of people) {
    for (const d of detailOf.get(u)) {
      for (const [id, answer, errors, revealed, checked] of d.detail.missed ?? []) {
        const k = answer;
        if (!byAnswer.has(k)) byAnswer.set(k, { answer, times: 0, errors: 0, revealed: 0, checked: 0, where: [] });
        const e = byAnswer.get(k);
        e.times++;
        e.errors += errors;
        e.revealed += revealed;
        e.checked += checked;
        e.where.push({ id, row: d.row, u });
      }
    }
  }
  const rows = [...byAnswer.values()];
  if (!rows.length) return el('p', { class: 'stats-note' }, 'Nothing missed in the logged solves. Impressive.');
  return sortableTable({
    columns: [
      { key: 'a', label: 'Answer', value: (r) => r.answer, show: (v, r) => spoiler(ctx, v, r.where[0].row.puzzleId) },
      { key: 't', label: 'Times', value: (r) => r.times, num: true, better: -1 },
      { key: 'e', label: 'Wrong letters', value: (r) => r.errors, num: true, better: -1 },
      { key: 'r', label: 'Revealed', value: (r) => r.revealed, num: true, better: -1 },
      {
        key: 'w',
        label: 'Where',
        value: (r) => r.where.length,
        show: (_, r) =>
          el(
            'span',
            {},
            r.where.slice(0, 3).flatMap((x, k) => [k ? ', ' : '', link(breakdownHref(x.row.puzzleId, x.row.solveId), `${puzzleName(x.row.puzzle)} ${x.id.replace('A', '').replace('D', '')}${x.id[0] === 'A' ? 'A' : 'D'}`)])
          ),
      },
    ],
    rows,
    sort: { key: 't', dir: -1 },
    limit: 15,
  });
}
