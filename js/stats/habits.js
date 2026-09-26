/*
 * stats/habits.js — when and how people solve: a calendar by puzzle
 * date, a punchcard of solving hours, how long after publication, how
 * many sittings, and what's left unfinished.
 */

import { el, WEEKDAY_NAMES } from '../util.js';
import { median } from '../stats-math.js';
import { localDate } from '../stats-data.js';
import { chartCard, calendarChart, heatmap, barChart, xyChart, legend, scaleLegend, fmt } from '../charts.js';
import { WEEKDAY_ORDER, wd, sectionHead, sortableTable, puzzleName, breakdownHref, playHref, link, who, empty, chartGrid, tiles, tile } from './common.js';

const DAY = 86400000;

export function render(host, ctx) {
  if (!ctx.rows.length && !ctx.unfinished.length) {
    host.append(empty('No solves in this selection yet.'));
    return;
  }
  if (ctx.hasWeekdays) host.append(...calendars(ctx));
  host.append(chartGrid(...punchcards(ctx)));
  if (ctx.hasWeekdays) host.append(chartGrid(lag(ctx)));
  host.append(chartGrid(sessions(ctx), sittings(ctx)));
  host.append(sectionHead('Unfinished', 'Started but not solved (co-op solves not included).'), completion(ctx));
}

// ----- calendar -----

function calendars(ctx) {
  const dated = ctx.rows.filter((r) => r.date);
  if (!dated.length) return [];
  const last = dated.reduce((m, r) => (r.date > m ? r.date : m), '');
  // the latest six months, starting at the first solve in them (old archive
  // puzzles solved lately would otherwise stretch it back years)
  const earliest = localDate(Date.parse(last + 'T12:00:00Z') - 182 * DAY);
  const from = dated.map((r) => r.date).filter((d) => d >= earliest).sort()[0];
  const scale = { type: 'div', min: Math.log(0.5), mid: 0, max: Math.log(2) };
  const people = ctx.users.slice(0, 6);
  const cards = people.map((u) => {
    const byDate = new Map((ctx.byUser.get(u) ?? []).filter((r) => r.date).map((r) => [r.date, r]));
    return chartCard({
      title: people.length > 1 ? ctx.nameOf(u) : 'Calendar',
      sub: people.length > 1 ? null : 'One square per puzzle date (latest six months). Blue: faster than your usual for that weekday; red: slower; gray: exactly usual. Empty: not solved.',
      legend: people.length > 1 ? null : scaleLegend(scale, { low: 'twice as fast as usual', high: 'twice as slow' }),
      table: {
        columns: [
          ['Puzzle date', (r) => r.date],
          ['Time', (r) => r.seconds, fmt.time],
          ['vs usual', (r) => r.relative, fmt.rel],
        ],
        rows: [...byDate.values()].filter((r) => r.date >= from),
      },
      draw: (w) =>
        calendarChart(w, {
          from,
          to: last,
          scale,
          label: `Solves by puzzle date for ${ctx.nameOf(u)}`,
          day: (date) => {
            const r = byDate.get(date);
            if (!r) return null;
            return {
              value: Math.log(r.relative),
              href: breakdownHref(r.puzzleId, r.solveId),
              tip: {
                title: fmt.day(date),
                rows: [
                  { value: fmt.time(r.seconds), label: r.clean ? '★ clean' : 'assisted', color: ctx.colorOf(u) },
                  { value: fmt.rel(r.relative), label: 'vs usual' },
                  { value: r.dayOf ? 'on the day' : `${r.lagDays} day${r.lagDays === 1 ? '' : 's'} later`, label: 'solved' },
                ],
              },
            };
          },
        }),
    });
  });
  const out = [];
  if (people.length > 1) {
    out.push(sectionHead('Calendar', 'One square per puzzle date (latest six months): blue faster than that person’s usual, red slower, empty not solved.'));
  }
  if (people.length > 1) out.push(scaleLegend(scale, { low: 'twice as fast as usual', high: 'twice as slow' }));
  out.push(el('div', { class: people.length > 1 ? 'chart-grid' : '' }, cards));
  if (ctx.users.length > 6) out.push(el('p', { class: 'stats-note' }, 'Calendars for the first six people picked.'));
  return out;
}

// ----- punchcard -----

function punchcards(ctx) {
  const people = ctx.users.length <= 3 ? ctx.users.map((u) => [u]) : [ctx.users];
  return people.map((group) => {
    const rows = ctx.rows.filter((r) => group.includes(r.user) && r.solveHour != null);
    if (!rows.length) return null;
    const counts = new Map();
    for (const r of rows) {
      const k = `${r.solveWeekday}|${r.solveHour}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const max = Math.max(...counts.values());
    const hours = Array.from({ length: 24 }, (_, h) => ({ key: h, label: h % 3 === 0 ? fmt.hour(h) : '' }));
    const peak = [...counts].sort((a, b) => b[1] - a[1])[0][0].split('|').map(Number);
    const name = group.length === 1 ? ctx.nameOf(group[0]) : 'Everyone picked';
    return chartCard({
      title: ctx.users.length > 1 ? `When ${name} solves` : 'When you solve',
      sub: `Finishing time by day and hour (your time zone). Busiest: ${WEEKDAY_NAMES[peak[0]]}s around ${fmt.hour(peak[1])}.`,
      table: {
        columns: [['Day', (r) => WEEKDAY_NAMES[r.d]], ...Array.from({ length: 24 }, (_, h) => [fmt.hour(h), (r) => counts.get(`${r.d}|${h}`) ?? 0])],
        rows: WEEKDAY_ORDER.map((d) => ({ d })),
      },
      draw: (w) =>
        heatmap(w, {
          rows: WEEKDAY_ORDER.map((d) => ({ key: d, label: wd(d) })),
          cols: hours,
          scale: { type: 'seq', min: 0, max },
          cellMax: 26,
          label: `Solving times of day for ${name}`,
          cell: (d, h) => {
            const n = counts.get(`${d}|${h}`);
            if (!n) return null;
            return { value: n, tip: { title: `${WEEKDAY_NAMES[d]}, ${fmt.hour(h)}–${fmt.hour((h + 1) % 24)}`, rows: [{ value: `${n} solve${n === 1 ? '' : 's'}` }] } };
          },
        }),
    });
  });
}

// ----- lag -----

const LAG_BUCKETS = [
  ['0', 'Same day', (d) => d <= 0],
  ['1', 'Next day', (d) => d === 1],
  ['2', '2–3 days', (d) => d >= 2 && d <= 3],
  ['4', '4–7 days', (d) => d >= 4 && d <= 7],
  ['8', '8–30 days', (d) => d >= 8 && d <= 30],
  ['31', 'Later', (d) => d > 30],
];

function lag(ctx) {
  const share = (u, test) => {
    const rs = (ctx.byUser.get(u) ?? []).filter((r) => r.lagDays != null);
    return rs.length ? rs.filter((r) => test(r.lagDays)).length / rs.length : null;
  };
  const series = ctx.users.length <= 3 ? ctx.series() : null;
  const lagMed = ctx.users.map((u) => `${ctx.nameOf(u)} ${fmt.pct(share(u, (d) => d <= 0) ?? 0)}`);
  return chartCard({
    title: 'How soon after it comes out',
    sub: `Days between a puzzle’s date and solving it. On the day: ${lagMed.join(' · ')}.`,
    legend: series && ctx.users.length > 1 ? legend(series) : null,
    table: {
      columns: [['Solver', (r) => ctx.nameOf(r.u)], ...LAG_BUCKETS.map(([, label, test]) => [label, (r) => share(r.u, test), fmt.pct])],
      rows: ctx.users.map((u) => ({ u })),
    },
    draw: (w) =>
      series
        ? barChart(w, {
            categories: LAG_BUCKETS.map(([key, label]) => ({ key, label })),
            series,
            value: (k, u) => share(u, LAG_BUCKETS.find(([key]) => key === k)[2]),
            fmt: fmt.pct,
            height: 200,
            valueLabels: ctx.users.length === 1,
            label: 'Share of solves by days after publication',
          })
        : heatmap(w, {
            rows: ctx.users.map((u) => ({ key: u, label: ctx.nameOf(u) })),
            cols: LAG_BUCKETS.map(([key, label]) => ({ key, label })),
            scale: { type: 'seq', min: 0, max: 1 },
            showValues: true,
            cellMax: 70,
            label: 'Share of solves by days after publication',
            cell: (u, k) => {
              const v = share(u, LAG_BUCKETS.find(([key]) => key === k)[2]);
              return v == null ? null : { value: v, text: fmt.pct(v) };
            },
          }),
  });
}

// ----- sittings -----

function sessions(ctx) {
  const rows = ctx.rows.filter((r) => r.spanMs != null && r.spanMs > 0);
  if (rows.length < 3) return null;
  const emphasisUsers = ctx.users.slice(0, 3);
  const focus = rows.map((r) => r.seconds / (r.spanMs / 1000));
  return chartCard({
    title: 'Solving time against time on the clock',
    sub: `From opening a puzzle to finishing it, against the timer. On the diagonal = one sitting; above it = breaks. Median focus: ${fmt.pct(Math.min(1, median(focus)))} of the elapsed time spent solving.`,
    legend: ctx.users.length > 1 ? legend(ctx.series(emphasisUsers)) : null,
    table: {
      columns: [
        ['Solver', (r) => ctx.nameOf(r.user)],
        ['Puzzle', (r) => r.puzzleId],
        ['Solving', (r) => r.seconds, fmt.time],
        ['Open to finish', (r) => r.spanMs / 1000, fmt.time],
      ],
      rows,
    },
    draw: (w) => {
      const all = rows.flatMap((r) => [r.seconds, r.spanMs / 1000]);
      const lo = Math.min(...all);
      const hi = Math.max(...all);
      return xyChart(w, {
        height: 240,
        label: 'Solving time versus elapsed time',
        x: { type: 'log', ticks: 'time', fmt: fmt.time, min: lo / 1.2, max: hi * 1.2, label: 'solving time' },
        y: { type: 'log', ticks: 'time', fmt: fmt.time, min: lo, max: hi, label: 'open → finish' },
        layers: [
          { type: 'line', color: 'var(--color-chart-axis)', width: 1, hover: false, points: [{ x: lo / 1.2, y: lo / 1.2 }, { x: hi * 1.2, y: hi * 1.2 }] },
          ...emphasisUsers.map((u) => ({
            type: 'dots',
            key: u,
            label: ctx.nameOf(u),
            color: ctx.colorOf(u),
            points: rows
              .filter((r) => r.user === u)
              .map((r) => ({
                x: r.seconds,
                y: r.spanMs / 1000,
                href: breakdownHref(r.puzzleId, r.solveId),
                tip: { title: puzzleName(r.puzzle), rows: [{ value: fmt.time(r.seconds), label: 'solving', color: ctx.colorOf(u) }, { value: fmt.time(r.spanMs / 1000), label: 'open to finish' }, ...(r.summary ? [{ value: String(r.summary.sittings), label: 'sittings' }] : [])] },
              })),
          })),
        ],
      });
    },
    note: ctx.users.length > 3 ? 'Showing the first three people picked.' : null,
  });
}

function sittings(ctx) {
  const buckets = [
    ['1', '1'],
    ['2', '2'],
    ['3', '3'],
    ['4', '4+'],
  ];
  const share = (u, k) => {
    const rs = (ctx.byUser.get(u) ?? []).filter((r) => r.summary?.sittings);
    if (!rs.length) return null;
    return rs.filter((r) => (k === '4' ? r.summary.sittings >= 4 : r.summary.sittings === Number(k))).length / rs.length;
  };
  if (!ctx.users.some((u) => share(u, '1') != null)) return null;
  const series = ctx.series(ctx.users.slice(0, 3));
  return chartCard({
    title: 'Sittings per solve',
    sub: 'How many times the clock started (from logged solves).',
    legend: ctx.users.length > 1 ? legend(series) : null,
    table: {
      columns: [['Solver', (r) => ctx.nameOf(r.u)], ...buckets.map(([k, label]) => [`${label} sitting${k === '1' ? '' : 's'}`, (r) => share(r.u, k), fmt.pct])],
      rows: ctx.users.map((u) => ({ u })),
    },
    draw: (w) =>
      barChart(w, {
        categories: buckets.map(([key, label]) => ({ key, label })),
        series,
        value: (k, u) => share(u, k),
        fmt: fmt.pct,
        height: 200,
        valueLabels: series.length === 1,
        label: 'Share of solves by number of sittings',
      }),
  });
}

// ----- unfinished -----

function completion(ctx) {
  const wrap = el('div');
  wrap.append(
    tiles(
      ctx.users.map((u) => {
        const done = (ctx.byUser.get(u) ?? []).length;
        const open = ctx.unfinished.filter((x) => x.user === u).length;
        return tile({ label: ctx.users.length > 1 ? ctx.nameOf(u) : 'Finished what you started', value: done + open ? fmt.pct(done / (done + open)) : '—', sub: `${open} unfinished · ${done} solved` });
      })
    )
  );
  if (!ctx.unfinished.length) {
    wrap.append(el('p', { class: 'stats-note' }, 'Nothing left hanging.'));
    return wrap;
  }
  wrap.append(
    sortableTable({
      columns: [
        ...(ctx.users.length > 1 ? [{ key: 'u', label: 'Solver', value: (r) => ctx.nameOf(r.user), show: (_, r) => who(ctx, r.user) }] : []),
        { key: 'p', label: 'Puzzle', value: (r) => r.puzzle.date ?? r.puzzleId, show: (_, r) => (r.user === ctx.me ? link(playHref(r.puzzleId), puzzleName(r.puzzle)) : puzzleName(r.puzzle)) },
        { key: 'pct', label: 'Filled', value: (r) => r.pct, show: (v) => `${v}%`, num: true, better: -1 },
        { key: 't', label: 'Time so far', value: (r) => r.elapsed, show: fmt.time, num: true, better: -1 },
        { key: 'u2', label: 'Last touched', value: (r) => r.updatedAt, show: (v) => fmt.date(v), better: -1 },
      ],
      rows: ctx.unfinished,
      sort: { key: 'u2', dir: -1 },
      limit: 15,
    })
  );
  return wrap;
}
