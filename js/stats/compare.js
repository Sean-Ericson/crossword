/*
 * stats/compare.js — two or more people head to head: ratings (the skill
 * model, Elo, Bradley–Terry), win and speed matrices with significance, a
 * paired scatter and ratio spread for any two, Elo over time, finishing
 * positions, whether people find the same puzzles hard, and every shared
 * puzzle.
 */

import { el } from '../util.js';
import { median, geometricMean, wilcoxonSignedRank, signTest, pearson, correlationP } from '../stats-math.js';
import { sharedPuzzles, pairwise, rankCounts } from '../stats-model.js';
import { chartCard, heatmap, xyChart, dotPlot, histogramChart, barChart, legend, scaleLegend, fmt } from '../charts.js';
import { sectionHead, sortableTable, puzzleName, breakdownHref, link, who, empty, chartGrid, pText, signedTime } from './common.js';
import { skillOf } from './overview.js';

export function render(host, ctx) {
  const people = ctx.users;
  if (people.length < 2) {
    host.append(empty('Pick at least one more person above to compare.'));
    return;
  }
  const rows = ctx.rows;
  const games = sharedPuzzles(rows);
  const { elo, bt } = ctx.models();
  const { wins, games: played } = pairwise(rows);
  const w = (a, b) => wins.get(a)?.get(b) ?? 0;
  const g = (a, b) => played.get(a)?.get(b) ?? 0;

  // ----- ratings -----
  const ratingRows = people.map((u) => {
    let won = 0;
    let lost = 0;
    for (const v of people) {
      if (v === u) continue;
      won += w(u, v);
      lost += w(v, u);
    }
    return { u, skill: skillOf(ctx, u), elo: elo.ratings.get(u) ?? null, bt: bt.get(u) ?? null, won, lost };
  });
  host.append(
    sectionHead('Ratings', 'Skill: speed against the average solver from a model of everyone’s times (weekday + solver + puzzle), so it works even without shared puzzles. Elo and Bradley–Terry come from who beat whom on shared puzzles. All time, everyone.'),
    sortableTable({
      columns: [
        { key: 'u', label: 'Solver', value: (r) => ctx.nameOf(r.u), show: (_, r) => who(ctx, r.u) },
        { key: 'skill', label: 'Skill', value: (r) => r.skill?.factor ?? null, show: (v) => fmt.rel(v), num: true },
        { key: 'ci', label: '95% range', value: (r) => r.skill?.lo ?? null, show: (_, r) => `${fmt.rel(r.skill.lo)} to ${fmt.rel(r.skill.hi)}`, num: true },
        { key: 'elo', label: 'Elo', value: (r) => r.elo, show: (v) => Math.round(v), num: true, better: -1 },
        { key: 'bt', label: 'Bradley–Terry', value: (r) => r.bt, show: (v) => Math.round(v), num: true, better: -1 },
        { key: 'wl', label: 'Won–lost', value: (r) => (r.won + r.lost ? r.won / (r.won + r.lost) : null), show: (_, r) => `${r.won}–${r.lost}`, num: true, better: -1, title: 'Head-to-head results against the others picked, on shared puzzles in this selection' },
      ],
      rows: ratingRows,
      sort: { key: 'skill', dir: 1 },
      rowClass: (r) => (r.u === ctx.me ? 'you' : null),
    })
  );
  const skilled = ratingRows.filter((r) => r.skill);
  if (skilled.length) {
    host.append(
      chartGrid(
        chartCard({
          title: 'Skill with its uncertainty',
          sub: 'Typical time against the average solver here (left is faster); the bar is the 95% range. Fewer solves, wider bar.',
          table: {
            columns: [
              ['Solver', (r) => ctx.nameOf(r.u)],
              ['Factor', (r) => r.skill.factor, (v) => `${v.toFixed(2)}×`],
              ['Low', (r) => r.skill.lo, (v) => `${v.toFixed(2)}×`],
              ['High', (r) => r.skill.hi, (v) => `${v.toFixed(2)}×`],
              ['Solves', (r) => r.skill.n],
            ],
            rows: skilled,
          },
          draw: (width) =>
            dotPlot(width, {
              rows: [...skilled]
                .sort((a, b) => a.skill.factor - b.skill.factor)
                .map((r) => ({
                  key: r.u,
                  label: ctx.nameOf(r.u),
                  color: ctx.colorOf(r.u),
                  value: r.skill.factor,
                  range: [r.skill.lo, r.skill.hi],
                  tip: { title: ctx.nameOf(r.u), rows: [{ value: fmt.rel(r.skill.factor), label: 'than average', color: ctx.colorOf(r.u) }, { value: `${fmt.rel(r.skill.lo)} to ${fmt.rel(r.skill.hi)}`, label: '95%' }, { value: String(r.skill.n), label: 'solves' }] },
                })),
              fmt: (v) => `${+v.toFixed(2)}×`,
              ticks: 'number',
              log: true,
              label: 'Skill ratings with intervals',
            }),
        })
      )
    );
  }

  if (!games.length) {
    host.append(empty('No puzzles two of you have both solved in this selection yet.'));
    return;
  }

  // ----- matrices -----
  const pr = (a, b) => {
    const pairs = games.filter((x) => x.times.has(a) && x.times.has(b));
    if (!pairs.length) return null;
    const logs = pairs.map((x) => Math.log(x.times.get(a) / x.times.get(b)));
    const test = wilcoxonSignedRank(logs);
    return { n: pairs.length, ratio: geometricMean(pairs.map((x) => x.times.get(a) / x.times.get(b))), p: test.p, logs, pairs };
  };
  const cols = people.map((u) => ({ key: u, label: ctx.nameOf(u) }));
  const winScale = { type: 'div', min: 0, mid: 0.5, max: 1 };
  const ratioScale = { type: 'div', min: Math.log(0.5), mid: 0, max: Math.log(2) };
  host.append(
    chartGrid(
      chartCard({
        title: 'Who beats whom',
        sub: 'Row’s wins against column on puzzles both solved. Blue: the row wins more often. The p asks whether a record this lopsided could be a coin flip.',
        legend: scaleLegend(winScale, { low: 'row wins them all', high: 'row loses them all' }),
        table: {
          columns: [['Row \\ column', (r) => ctx.nameOf(r.u)], ...people.map((v) => [ctx.nameOf(v), (r) => (r.u === v ? '' : `${w(r.u, v)}–${w(v, r.u)}`)])],
          rows: people.map((u) => ({ u })),
        },
        draw: (width) =>
          heatmap(width, {
            rows: cols,
            cols,
            scale: winScale,
            showValues: true,
            cellMax: 64,
            label: 'Head-to-head wins',
            cell: (a, b) => {
              if (a === b || !g(a, b)) return null;
              const share = w(a, b) / g(a, b);
              const test = signTest(w(a, b), w(b, a));
              return {
                value: 1 - share,
                text: `${w(a, b)}–${w(b, a)}`,
                tip: { title: `${ctx.nameOf(a)} vs ${ctx.nameOf(b)}`, rows: [{ value: `${w(a, b)}–${w(b, a)}`, label: `${fmt.pct(share)} won`, color: ctx.colorOf(a) }, { value: pText(test.p), label: 'sign test' }] },
              };
            },
          }),
      }),
      chartCard({
        title: 'How much faster',
        sub: 'Row’s time ÷ column’s on shared puzzles (geometric mean). Blue: the row is faster. The p is a Wilcoxon signed-rank test on the pairs.',
        legend: scaleLegend(ratioScale, { low: 'row twice as fast', high: 'row twice as slow' }),
        table: {
          columns: [['Row \\ column', (r) => ctx.nameOf(r.u)], ...people.map((v) => [ctx.nameOf(v), (r) => (r.u === v ? '' : pr(r.u, v)?.ratio.toFixed(3) ?? '')])],
          rows: people.map((u) => ({ u })),
        },
        draw: (width) =>
          heatmap(width, {
            rows: cols,
            cols,
            scale: ratioScale,
            showValues: true,
            cellMax: 64,
            label: 'Speed ratios',
            cell: (a, b) => {
              if (a === b) return null;
              const c = pr(a, b);
              if (!c) return null;
              return {
                value: Math.log(c.ratio),
                text: `${c.ratio.toFixed(2)}×`,
                tip: { title: `${ctx.nameOf(a)} vs ${ctx.nameOf(b)}`, rows: [{ value: fmt.rel(c.ratio), label: `on ${c.n} shared`, color: ctx.colorOf(a) }, { value: pText(c.p), label: 'Wilcoxon' }] },
              };
            },
          }),
      })
    )
  );

  // ----- one pair up close -----
  const pairState = { a: people.includes(ctx.me) ? ctx.me : people[0] };
  pairState.b = people.find((u) => u !== pairState.a);
  const pairHost = el('div');
  const drawPair = () => {
    pairHost.textContent = '';
    const pick = (key) =>
      el(
        'select',
        {
          'aria-label': key === 'a' ? 'First person' : 'Second person',
          onchange: (e) => {
            pairState[key] = e.target.value;
            if (pairState.a === pairState.b) pairState[key === 'a' ? 'b' : 'a'] = people.find((u) => u !== e.target.value);
            drawPair();
          },
        },
        people.map((u) => el('option', { value: u, ...(pairState[key] === u ? { selected: true } : {}) }, ctx.nameOf(u)))
      );
    pairHost.append(el('div', { class: 'section-head row' }, [el('h2', {}, 'Up close'), el('div', { class: 'pair-pick' }, [pick('a'), ' vs ', pick('b')])]));
    const { a, b } = pairState;
    const c = pr(a, b);
    if (!c) {
      pairHost.append(empty(`${ctx.nameOf(a)} and ${ctx.nameOf(b)} haven’t solved the same puzzle in this selection.`));
      return;
    }
    const faster = c.ratio < 1 ? a : b;
    const pct = Math.round(Math.abs(1 - (c.ratio < 1 ? c.ratio : 1 / c.ratio)) * 100);
    pairHost.append(
      el('p', { class: 'headline' }, [
        el('strong', {}, ctx.nameOf(faster)),
        ` is typically ${pct}% faster over ${c.n} shared puzzle${c.n === 1 ? '' : 's'} (${pText(c.p)}${c.p != null && c.p < 0.05 ? ', unlikely to be luck' : c.p != null ? ', could be luck' : ''}).`,
      ])
    );
    const all = c.pairs.flatMap((x) => [x.times.get(a), x.times.get(b)]);
    const lo = Math.min(...all) / 1.15;
    const hi = Math.max(...all) * 1.15;
    const winnerColor = (x) => (x.times.get(a) < x.times.get(b) ? ctx.colorOf(a) : x.times.get(a) > x.times.get(b) ? ctx.colorOf(b) : 'var(--color-text-muted)');
    pairHost.append(
      chartGrid(
        chartCard({
          title: 'Every shared puzzle',
          sub: `${ctx.nameOf(a)} across, ${ctx.nameOf(b)} up. Below the diagonal ${ctx.nameOf(b)} was faster; each dot takes the winner’s color.`,
          legend: legend([
            { key: a, label: `${ctx.nameOf(a)} faster`, color: ctx.colorOf(a), kind: 'dot' },
            { key: b, label: `${ctx.nameOf(b)} faster`, color: ctx.colorOf(b), kind: 'dot' },
          ]),
          table: {
            columns: [
              ['Puzzle', (x) => x.puzzleId],
              [ctx.nameOf(a), (x) => x.times.get(a), fmt.time],
              [ctx.nameOf(b), (x) => x.times.get(b), fmt.time],
            ],
            rows: c.pairs,
          },
          draw: (width) =>
            xyChart(width, {
              height: 280,
              label: `Paired times, ${ctx.nameOf(a)} against ${ctx.nameOf(b)}`,
              x: { type: 'log', ticks: 'time', fmt: fmt.time, min: lo, max: hi, label: ctx.nameOf(a) },
              y: { type: 'log', ticks: 'time', fmt: fmt.time, min: lo, max: hi, label: ctx.nameOf(b) },
              layers: [
                { type: 'line', color: 'var(--color-chart-axis)', width: 1, hover: false, points: [{ x: lo, y: lo }, { x: hi, y: hi }] },
                ...[a, b].map((u) => ({
                  type: 'dots',
                  key: u,
                  label: ctx.nameOf(u),
                  color: ctx.colorOf(u),
                  points: c.pairs
                    .filter((x) => winnerColor(x) === ctx.colorOf(u))
                    .map((x) => {
                      const p = ctx.puzzles.get(x.puzzleId);
                      return {
                        x: x.times.get(a),
                        y: x.times.get(b),
                        href: breakdownHref(x.puzzleId),
                        tip: {
                          title: puzzleName(p),
                          rows: [
                            { value: fmt.time(x.times.get(a)), label: ctx.nameOf(a), color: ctx.colorOf(a) },
                            { value: fmt.time(x.times.get(b)), label: ctx.nameOf(b), color: ctx.colorOf(b) },
                          ],
                        },
                      };
                    }),
                })),
              ],
            }),
        }),
        chartCard({
          title: 'The gap, puzzle by puzzle',
          sub: `${ctx.nameOf(a)}’s time ÷ ${ctx.nameOf(b)}’s: left of 1× ${ctx.nameOf(a)} was faster. Median ${median(c.logs.map(Math.exp)).toFixed(2)}×.`,
          table: {
            columns: [
              ['Puzzle', (x) => x.puzzleId],
              ['Ratio', (x) => x.times.get(a) / x.times.get(b), (v) => `${v.toFixed(3)}×`],
            ],
            rows: c.pairs,
          },
          draw: (width) =>
            histogramChart(width, {
              series: [{ key: a, label: ctx.nameOf(a), color: ctx.colorOf(a), values: c.logs.map(Math.exp) }],
              fmt: (v) => `${+v.toFixed(2)}×`,
              ticks: 'number',
              log: true,
              height: 280,
              label: 'Distribution of time ratios',
            }),
        })
      )
    );
  };
  drawPair();
  host.append(pairHost);

  // ----- Elo over time, finishing positions, agreement -----
  const eloSeries = people.filter((u) => elo.history.has(u));
  const ranks = rankCounts(rows, people);
  const places = people.map((_, k) => k);
  const ord = (k) => ['1st', '2nd', '3rd'][k] ?? `${k + 1}th`;
  host.append(
    chartGrid(
      eloSeries.length
        ? chartCard({
            title: 'Elo over time',
            sub: 'Every shared puzzle is a game; beating a stronger rating gains more. Everyone, all time.',
            legend: legend(ctx.series(eloSeries).map((s) => ({ ...s, kind: 'line' }))),
            table: {
              columns: [
                ['Solver', (r) => ctx.nameOf(r.u)],
                ['Date', (r) => new Date(r.at).toISOString().slice(0, 10)],
                ['Rating', (r) => Math.round(r.rating)],
                ['Puzzle', (r) => r.puzzleId],
              ],
              rows: eloSeries.flatMap((u) => elo.history.get(u).map((h) => ({ u, ...h }))),
            },
            draw: (width) =>
              xyChart(width, {
                height: 240,
                label: 'Elo ratings over time',
                x: { type: 'time' },
                y: { fmt: (v) => String(Math.round(v)) },
                hover: 'x',
                layers: [{ type: 'rule', y: 1500 }, ...eloSeries.map((u) => ({ type: 'line', key: u, label: ctx.nameOf(u), color: ctx.colorOf(u), step: true, extend: true, points: elo.history.get(u).map((h) => ({ x: h.at, y: h.rating })) }))],
              }),
          })
        : null,
      chartCard({
        title: 'Finishing positions',
        sub: 'On puzzles several of you solved: how often each person finished 1st, 2nd, … The strongest color is 1st.',
        legend: legend(places.map((k) => ({ key: k, label: ord(k), color: `var(--color-seq-${Math.max(0, 6 - Math.round((k * 6) / Math.max(1, places.length - 1)))})` }))),
        table: {
          columns: [['Solver', (r) => ctx.nameOf(r.u)], ...places.map((k) => [ord(k), (r) => ranks.get(r.u)[k]])],
          rows: people.map((u) => ({ u })),
        },
        draw: (width) =>
          barChart(width, {
            categories: people.map((u) => ({ key: u, label: ctx.nameOf(u) })),
            series: places.map((k) => ({ key: k, label: ord(k), color: `var(--color-seq-${Math.max(0, 6 - Math.round((k * 6) / Math.max(1, places.length - 1)))})` })),
            value: (u, k) => ranks.get(u)[k] || null,
            horizontal: true,
            stacked: true,
            fmt: (v) => fmt.int(v),
            label: 'Finishing positions',
          }),
      })
    )
  );

  const agreement = (a, b) => {
    const pairs = games.filter((x) => x.times.has(a) && x.times.has(b));
    if (pairs.length < 5) return null;
    const r = pearson(pairs.map((x) => Math.log(x.times.get(a))), pairs.map((x) => Math.log(x.times.get(b))));
    return r == null ? null : { r, n: pairs.length, p: correlationP(r, pairs.length) };
  };
  const agreeScale = { type: 'div', min: -1, mid: 0, max: 1 };
  host.append(
    chartGrid(
      chartCard({
        title: 'Do you find the same puzzles hard?',
        sub: 'Correlation of log times on shared puzzles (5+ needed). Near 1: when one of you struggles, so does the other. Weekday differences push this up, so pick a single weekday above for the purest read.',
        legend: scaleLegend(agreeScale, { low: '−1', high: '+1' }),
        table: {
          columns: [['', (r) => ctx.nameOf(r.u)], ...people.map((v) => [ctx.nameOf(v), (r) => (r.u === v ? '' : agreement(r.u, v)?.r.toFixed(2) ?? '')])],
          rows: people.map((u) => ({ u })),
        },
        draw: (width) =>
          heatmap(width, {
            rows: cols,
            cols,
            scale: agreeScale,
            showValues: true,
            cellMax: 64,
            label: 'Agreement on difficulty',
            cell: (a, b) => {
              if (a === b) return null;
              const c = agreement(a, b);
              return c ? { value: c.r, text: c.r.toFixed(2), tip: { title: `${ctx.nameOf(a)} & ${ctx.nameOf(b)}`, rows: [{ value: `r = ${c.r.toFixed(2)}`, label: `${pText(c.p)}, n = ${c.n}` }] } } : null;
            },
          }),
      })
    )
  );

  // ----- every shared puzzle -----
  const table = [...games].reverse().map((x) => {
    const sorted = [...x.times].filter(([u]) => people.includes(u)).sort((p, q) => p[1] - q[1]);
    return { ...x, p: ctx.puzzles.get(x.puzzleId), winner: sorted[0][1] < (sorted[1]?.[1] ?? Infinity) ? sorted[0][0] : null, margin: sorted.length > 1 ? sorted[1][1] - sorted[0][1] : null, fastest: sorted[0][1] };
  });
  host.append(
    sectionHead('Every shared puzzle', 'Puzzles at least two of you solved. The fastest time is in bold; the margin is the gap to second.'),
    sortableTable({
      columns: [
        { key: 'p', label: 'Puzzle', value: (r) => r.p?.date ?? r.puzzleId, show: (_, r) => link(breakdownHref(r.puzzleId), puzzleName(r.p)) },
        ...people.map((u) => ({
          key: u,
          label: ctx.nameOf(u),
          value: (r) => r.times.get(u) ?? null,
          show: (v, r) => el('span', { class: v === r.fastest ? 'fastest' : null }, fmt.time(v)),
          num: true,
        })),
        { key: 'w', label: 'Fastest', value: (r) => (r.winner ? ctx.nameOf(r.winner) : 'tie'), show: (_, r) => (r.winner ? who(ctx, r.winner) : 'tie') },
        { key: 'm', label: 'Margin', value: (r) => r.margin, show: (v) => signedTime(v).replace('+', ''), num: true, better: -1 },
      ],
      rows: table,
      sort: { key: 'p', dir: -1 },
      limit: 20,
    })
  );
}
