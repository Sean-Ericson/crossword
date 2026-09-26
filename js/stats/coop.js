/*
 * stats/coop.js — solving together: every co-op solve with its synergy
 * (the team's time against what its members would do alone), partners,
 * who filled how much, and who fixed whose mistakes. Co-op results never
 * count toward the solo stats in the other tabs.
 */

import { el } from '../util.js';
import { median } from '../stats-math.js';
import { coopSynergy } from '../stats-model.js';
import { distinctColors } from '../people.js';
import { chartCard, xyChart, barChart, heatmap, legend, scaleLegend, fmt } from '../charts.js';
import { sectionHead, sortableTable, puzzleName, breakdownHref, link, who, empty, chartGrid, tiles, tile } from './common.js';

export async function render(host, ctx) {
  const list = ctx.coop;
  if (!list.length) {
    host.append(empty(`No ${ctx.typeLabel.toLowerCase()} co-op solves${ctx.users.length > 1 ? ' with anyone picked' : ''} in this selection yet. Start one from a puzzle’s Solo ▾ menu.`));
    return;
  }
  const { fit, constructors } = ctx.models();
  const rows = list.map((c) => ({ ...c, syn: coopSynergy(fit, c, ctx.puzzles, constructors) }));
  const syn = rows.filter((r) => r.syn);
  const clean = rows.filter((r) => r.clean).length;

  host.append(
    tiles([
      tile({ label: 'Co-op solves', value: String(rows.length), sub: `${clean} clean` }),
      tile({ label: 'Median time', value: fmt.time(median(rows.map((r) => r.seconds))) }),
      syn.length
        ? tile({
            label: 'Synergy',
            value: `${median(syn.map((r) => r.syn.vsBest)).toFixed(2)}×`,
            sub: 'the fastest member’s predicted solo time ÷ the team’s (median). Above 1×: better together',
          })
        : null,
      syn.length
        ? tile({
            label: 'Against a perfect split',
            value: `${median(syn.map((r) => r.syn.vsSplit)).toFixed(2)}×`,
            sub: 'as if the work split perfectly by speed. 1× would be flawless teamwork',
          })
        : null,
    ])
  );

  // every account in these solves gets a color that differs within this tab
  const everyone = [...new Set(rows.flatMap((r) => r.members))];
  const acct = new Map(ctx.accounts.map((a) => [a.name, a]));
  const colors = distinctColors(everyone.map((name) => ({ name, color: acct.get(name)?.color ?? '#888888' })));
  const colorOf = (u) => colors.get(u) ?? 'var(--color-text-subtle)';

  if (syn.length >= 2) {
    const all = syn.flatMap((r) => [r.seconds, r.syn.predictedBest]);
    const lo = Math.min(...all) / 1.15;
    const hi = Math.max(...all) * 1.15;
    host.append(
      chartGrid(
        chartCard({
          title: 'Faster together?',
          sub: 'Each dot is a co-op solve: the fastest member’s predicted solo time across, the team’s actual time up. Below the diagonal the team beat its best member.',
          table: {
            columns: [
              ['Puzzle', (r) => r.puzzleId],
              ['Team', (r) => r.members.map(ctx.nameOf).join(', ')],
              ['Actual', (r) => r.seconds, fmt.time],
              ['Best member alone (predicted)', (r) => r.syn.predictedBest, fmt.time],
              ['Synergy', (r) => r.syn.vsBest, (v) => `${v.toFixed(2)}×`],
            ],
            rows: syn,
          },
          draw: (w) =>
            xyChart(w, {
              height: 260,
              label: 'Co-op times against predicted solo times',
              x: { type: 'log', ticks: 'time', fmt: fmt.time, min: lo, max: hi, label: 'best member alone (predicted)' },
              y: { type: 'log', ticks: 'time', fmt: fmt.time, min: lo, max: hi, label: 'team' },
              layers: [
                { type: 'line', color: 'var(--color-chart-axis)', width: 1, hover: false, points: [{ x: lo, y: lo }, { x: hi, y: hi }] },
                {
                  type: 'dots',
                  label: 'Co-op solve',
                  color: ctx.colorOf(ctx.users[0]),
                  points: syn.map((r) => ({
                    x: r.syn.predictedBest,
                    y: r.seconds,
                    href: breakdownHref(r.puzzleId, r.id),
                    tip: { title: `${puzzleName(r.puzzle)} · ${r.members.map(ctx.nameOf).join(', ')}`, rows: [{ value: fmt.time(r.seconds), label: 'together' }, { value: fmt.time(r.syn.predictedBest), label: 'best member alone' }, { value: `${r.syn.vsBest.toFixed(2)}×`, label: 'synergy' }] },
                  })),
                },
              ],
            }),
        }),
        contributions(ctx, rows, colorOf)
      )
    );
  } else {
    host.append(chartGrid(contributions(ctx, rows, colorOf)));
  }

  // partners
  if (ctx.users.length === 1) {
    const me = ctx.users[0];
    const byPartner = new Map();
    for (const r of rows) {
      for (const m of r.members) {
        if (m === me) continue;
        if (!byPartner.has(m)) byPartner.set(m, []);
        byPartner.get(m).push(r);
      }
    }
    host.append(
      sectionHead('Partners'),
      sortableTable({
        columns: [
          { key: 'u', label: 'Partner', value: (r) => ctx.nameOf(r.u), show: (_, r) => el('span', { class: 'who' }, [el('span', { class: 'dot', style: `background:${colorOf(r.u)}` }), ctx.nameOf(r.u)]) },
          { key: 'n', label: 'Solves', value: (r) => r.rs.length, num: true, better: -1 },
          { key: 't', label: 'Median time', value: (r) => median(r.rs.map((x) => x.seconds)), show: fmt.time, num: true },
          { key: 's', label: 'Synergy', value: (r) => {
            const v = r.rs.filter((x) => x.syn).map((x) => x.syn.vsBest);
            return v.length ? median(v) : null;
          }, show: (v) => `${v.toFixed(2)}×`, num: true, better: -1 },
          { key: 'c', label: '★ Clean', value: (r) => r.rs.filter((x) => x.clean).length / r.rs.length, show: fmt.pct, num: true, better: -1 },
        ],
        rows: [...byPartner].map(([u, rs]) => ({ u, rs })),
        sort: { key: 'n', dir: -1 },
      })
    );
  }

  // who fixed whose mistakes
  const fixes = await fixMatrix(ctx, rows);
  if (fixes) host.append(chartGrid(fixes));

  host.append(
    sectionHead('Every co-op solve', 'Newest first. Synergy compares the team with its fastest member’s predicted solo time.'),
    sortableTable({
      columns: [
        { key: 'p', label: 'Puzzle', value: (r) => r.date ?? r.puzzleId, show: (_, r) => link(breakdownHref(r.puzzleId, r.id), puzzleName(r.puzzle)) },
        { key: 'w', label: 'Team', value: (r) => r.members.length, show: (_, r) => el('span', { class: 'with' }, r.members.map((m) => el('span', { class: 'coop-partner' }, [el('span', { class: 'dot', style: `background:${colorOf(m)}` }), ctx.nameOf(m)]))) },
        { key: 't', label: 'Time', value: (r) => r.seconds, show: fmt.time, num: true },
        { key: 's', label: 'Synergy', value: (r) => r.syn?.vsBest ?? null, show: (v) => `${v.toFixed(2)}×`, num: true, better: -1 },
        { key: 'c', label: '', value: (r) => (r.clean ? 1 : 0), show: (v) => (v ? el('span', { class: 'gold' }, '★') : '') },
      ],
      rows,
      sort: { key: 'p', dir: -1 },
      limit: 20,
    })
  );
}

/** Who holds the finished squares in each logged co-op solve. */
function contributions(ctx, rows, colorOf) {
  const logged = rows.filter((r) => r.summary?.by).sort((a, b) => b.completedAt - a.completedAt).slice(0, 14);
  if (!logged.length) return null;
  const people = [...new Set(logged.flatMap((r) => Object.keys(r.summary.by)))];
  const share = (r, u) => {
    const cells = r.summary.cells || 1;
    const v = r.summary.by[u]?.final ?? 0;
    return v ? v / cells : null;
  };
  const series = people.map((u) => ({ key: u, label: ctx.nameOf(u), color: colorOf(u) }));
  return chartCard({
    title: 'Who filled what',
    sub: 'Share of the finished grid each person typed (revealed squares count for nobody). Latest logged co-op solves.',
    legend: legend(series),
    table: {
      columns: [['Puzzle', (r) => r.puzzleId], ...people.map((u) => [ctx.nameOf(u), (r) => share(r, u), fmt.pct])],
      rows: logged,
    },
    draw: (w) =>
      barChart(w, {
        categories: logged.map((r) => ({ key: r.id, label: puzzleName(r.puzzle) })),
        series,
        value: (id, u) => share(logged.find((r) => r.id === id), u),
        horizontal: true,
        stacked: true,
        max: 1,
        fmt: fmt.pct,
        valueLabels: false,
        href: (c) => breakdownHref(logged.find((r) => r.id === c.key).puzzleId, c.key),
        label: 'Share of squares by person',
      }),
  });
}

async function fixMatrix(ctx, rows) {
  const ids = new Set(rows.map((r) => r.id));
  const maps = await Promise.all(ctx.users.map((u) => ctx.details(u)));
  const seen = new Set();
  const counts = new Map();
  for (const m of maps) {
    for (const [id, d] of Object.entries(m)) {
      if (!ids.has(id) || seen.has(id)) continue;
      seen.add(id);
      for (const [k, n] of Object.entries(d.detail.fixes ?? {})) counts.set(k, (counts.get(k) ?? 0) + n);
    }
  }
  if (!counts.size) return null;
  const people = [...new Set([...counts.keys()].flatMap((k) => k.split('>')).filter(Boolean))].sort(ctx.byDisplay);
  const max = Math.max(...counts.values());
  const scale = { type: 'seq', min: 0, max };
  return chartCard({
    title: 'Who fixed whose mistakes',
    sub: 'Row put the right letter where column had typed a wrong one.',
    legend: scaleLegend(scale, { low: '1', high: String(max) }),
    table: {
      columns: [
        ['Fixer', (r) => ctx.nameOf(r[0].split('>')[0])],
        ['Whose mistake', (r) => ctx.nameOf(r[0].split('>')[1])],
        ['Letters', (r) => r[1]],
      ],
      rows: [...counts],
    },
    draw: (w) =>
      heatmap(w, {
        rows: people.map((u) => ({ key: u, label: ctx.nameOf(u) })),
        cols: people.map((u) => ({ key: u, label: ctx.nameOf(u) })),
        scale,
        showValues: true,
        cellMax: 56,
        label: 'Fixes between co-op partners',
        cell: (a, b) => {
          const n = counts.get(`${a}>${b}`);
          return n ? { value: n, text: String(n), tip: { title: `${ctx.nameOf(a)} fixed ${ctx.nameOf(b)}`, rows: [{ value: `${n} letter${n === 1 ? '' : 's'}` }] } } : null;
        },
      }),
  });
}
