/*
 * analysis-page.js — one puzzle, broken down (analysis.html?puzzle=ID[&solve=ID]).
 *
 * Everyone's results on the puzzle and how each compares with what the
 * model expected, the race (every logged solve's progress on one clock),
 * and for one chosen solve: its numbers, a replay on the real grid with
 * each person's cursor, grid heatmaps (fill order, when each square was
 * right for good, mistakes, who filled it) and an entry-by-entry table.
 *
 * Spoilers: someone who hasn't solved the puzzle sees times, curves and
 * ranks, but letters, answers and clue text stay hidden until they click
 * "Show anyway". The server serves finished solves' logs to anyone signed
 * in; the guard is here.
 */

import { el, qs, formatDateLong, themeTitle, PUZZLE_TYPE_LABELS, parsePuzzleId, WEEKDAY_NAMES } from './util.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { api } from './api.js';
import { parsePuz } from './puz.js';
import { PuzzleModel } from './model.js';
import { GridView } from './grid-view.js';
import { distinctColors } from './people.js';
import { analyzeSolve, attemptOf, applyEvent } from './solve-analysis.js';
import { buildDataset, splitAuthor } from './stats-data.js';
import { fitAdditive } from './stats-model.js';
import { median } from './stats-math.js';
import { chartCard, xyChart, dotPlot, gridHeatmap, legend, scaleLegend, fmt } from './charts.js';
import { sectionHead, sortableTable, tiles, tile, chartGrid, empty, playHref } from './stats/common.js';

const MAX_LOGS = 12; // logged solves fetched for the race and the entry table
const SPEEDS = [1, 2, 5, 10, 20, 30, 60, 120];

const params = new URLSearchParams(location.search);
const puzzleId = params.get('puzzle') ?? '';
let solveParam = params.get('solve');

const toEvent = ([seq, t, at, user, kind, cell, value, marks, dir]) => ({ seq, t, at, user, kind, cell, value, marks, dir });
const mmss = (ms) => fmt.time(ms / 1000);

async function main() {
  const me = await loadMe();
  initProfileChip(qs('#profile-chip'));
  const host = qs('#analysis');

  const [usersDoc, resultsDoc, statsAll, index, buf] = await Promise.all([
    api.get('users'),
    api.get(`puzzles/${encodeURIComponent(puzzleId)}/results`).catch(() => ({ results: [] })),
    api.get('stats-all').catch(() => null),
    fetch('./puzzles/index.json').then((r) => (r.ok ? r.json() : { puzzles: [] })).catch(() => ({ puzzles: [] })),
    fetch(`./puzzles/${encodeURIComponent(puzzleId)}.puz`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);
  host.textContent = '';
  if (!buf) {
    host.append(empty('That puzzle isn’t in the archive.'));
    return;
  }
  const model = new PuzzleModel(parsePuz(buf));
  const accounts = usersDoc.users;
  const acct = new Map(accounts.map((u) => [u.name, u]));
  const nameOf = (u) => acct.get(u)?.display_name ?? u ?? 'someone';
  const results = resultsDoc.results ?? [];
  const entry = (index.puzzles ?? []).find((p) => p.id === puzzleId) ?? null;
  const info = parsePuzzleId(puzzleId);

  // colors: everyone who appears on this page, distinct from each other
  const people = [...new Set(results.flatMap((r) => r.members))];
  people.sort((a, b) => (a === me.name ? -1 : b === me.name ? 1 : nameOf(a).localeCompare(nameOf(b))));
  const colors = distinctColors(people.map((name) => ({ name, color: acct.get(name)?.color ?? '#888888' })));
  const colorOf = (u) => colors.get(u) ?? 'var(--color-text-subtle)';
  const labelOf = (r) => r.members.map(nameOf).join(' + ');
  const colorOfResult = (r) => colorOf(r.members[0]);

  const solvedByMe = results.some((r) => r.members.includes(me.name));
  let reveal = solvedByMe;
  const hide = (text) => (reveal ? text : text.replace(/[^\s]/g, '•'));

  // the model, for difficulty and expectations
  let fit = null;
  let rowsByUser = new Map();
  let difficultyRank = null;
  if (statsAll) {
    const ds = buildDataset(statsAll, index.puzzles ?? []);
    const typeRows = ds.solves.filter((r) => r.type === info.type);
    fit = fitAdditive(typeRows);
    rowsByUser = new Map(typeRows.filter((r) => r.puzzleId === puzzleId).map((r) => [r.user, r]));
    if (fit?.puzzle.has(puzzleId)) {
      const ranked = [...fit.puzzle].filter(([id]) => (fit.puzzleN.get(id) ?? 0) >= 2).sort((a, b) => b[1] - a[1]);
      const k = ranked.findIndex(([id]) => id === puzzleId);
      if (k >= 0) difficultyRank = { k: k + 1, of: ranked.length };
    }
  }

  // ----- header -----
  const { constructors, editor } = splitAuthor(entry?.author ?? model.puz.author);
  const title = info.date ? formatDateLong(info.date) : model.puz.title || puzzleId;
  const theme = themeTitle(entry?.title ?? model.puz.title ?? '');
  const b = fit?.puzzle.get(puzzleId);
  const facts = [
    `${model.width}×${model.height}`,
    `${model.clueOrder.length} words`,
    `${model.cells.filter((c) => c.isBlack).length} black squares`,
    ...(entry?.rebus ? [`${entry.rebus} rebus square${entry.rebus === 1 ? '' : 's'}`] : []),
    ...(entry?.circles ? [`${entry.circles} circled`] : []),
  ].join(' · ');
  document.title = `${title} · breakdown`;
  host.append(
    el('div', { class: 'analysis-head' }, [
      el('p', { class: 'stats-scope' }, `${PUZZLE_TYPE_LABELS[info.type] ?? 'Puzzle'} · breakdown`),
      el('h1', {}, title),
      theme ? el('p', { class: 'theme-title' }, theme) : null,
      el('p', { class: 'facts' }, [constructors.length ? `By ${constructors.join(', ')}` : '', editor && editor !== constructors[0] ? ` · edited by ${editor}` : ''].join('')),
      el('p', { class: 'facts' }, facts),
      b != null
        ? el(
            'p',
            { class: 'facts' },
            `${fmt.rel(Math.exp(b)).replace('faster', 'easier').replace('slower', 'harder').replace('as usual', 'about as hard as')} than a typical ${info.date ? WEEKDAY_NAMES[new Date(info.date + 'T12:00:00Z').getUTCDay()] : PUZZLE_TYPE_LABELS[info.type]}${difficultyRank ? ` · #${difficultyRank.k} hardest of ${difficultyRank.of} rated` : ''}`
          )
        : null,
      el('div', { class: 'actions' }, [el('a', { href: playHref(puzzleId) }, solvedByMe ? 'Open the puzzle' : 'Play it'), el('a', { href: './stats.html#puzzles' }, 'All puzzles')]),
    ])
  );
  const banner = el('div', { class: 'spoiler-banner' }, [
    el('span', {}, 'You haven’t solved this one, so letters, answers and clues are hidden. Times and charts are safe.'),
    el(
      'button',
      {
        class: 'btn btn-quiet',
        type: 'button',
        onclick: () => {
          reveal = true;
          banner.remove();
          renderSolve();
        },
      },
      'Show anyway'
    ),
  ]);
  if (!reveal) host.append(banner);

  if (!results.length) {
    host.append(empty('Nobody has finished this puzzle yet.'));
    return;
  }

  // ----- results -----
  const sorted = [...results].sort((x, y) => x.seconds - y.seconds);
  const expected = (r) => {
    if (r.kind !== 'solo' || !fit) return null;
    const row = rowsByUser.get(r.members[0]);
    return row ? Math.exp(fit.fitted(row)) : null;
  };
  host.append(
    sectionHead('Results', 'Everyone who finished it, solo and co-op. “vs expected” compares with the model’s prediction for that solver on a puzzle this hard.'),
    chartGrid(
      chartCard({
        title: 'Times',
        sub: 'Solo solves by person; co-op teams listed with a +.',
        table: {
          columns: [
            ['Solver', (r) => labelOf(r)],
            ['Kind', (r) => r.kind],
            ['Time', (r) => r.seconds, fmt.time],
            ['Clean', (r) => (r.flags & 1 ? 'yes' : 'no')],
          ],
          rows: sorted,
        },
        draw: (w) =>
          dotPlot(w, {
            rows: sorted.map((r) => ({
              key: r.solve_id ?? labelOf(r),
              label: labelOf(r),
              color: colorOfResult(r),
              value: r.seconds,
              strong: r.members.includes(me.name),
              tip: {
                title: labelOf(r),
                rows: [
                  { value: fmt.time(r.seconds), label: r.flags & 1 ? '★ clean' : r.flags & 4 ? 'revealed' : 'checked', color: colorOfResult(r) },
                  ...(expected(r) ? [{ value: fmt.rel(r.seconds / expected(r)), label: `than expected (${fmt.time(expected(r))})` }] : []),
                ],
              },
            })),
            fmt: fmt.time,
            log: sorted.at(-1).seconds / Math.max(1, sorted[0].seconds) > 4,
            label: 'Times on this puzzle',
          }),
      })
    ),
    sortableTable({
      columns: [
        { key: 'rank', label: '#', value: (r) => sorted.indexOf(r) + 1, num: true },
        { key: 'who', label: 'Solver', value: (r) => labelOf(r), show: (v, r) => el('span', { class: 'who' }, [el('span', { class: 'dot', style: `background:${colorOfResult(r)}` }), v]) },
        { key: 't', label: 'Time', value: (r) => r.seconds, show: fmt.time, num: true },
        { key: 'exp', label: 'vs expected', value: (r) => (expected(r) ? r.seconds / expected(r) : null), show: fmt.rel, num: true },
        { key: 'usual', label: 'vs their usual', value: (r) => (r.kind === 'solo' ? rowsByUser.get(r.members[0])?.relative ?? null : null), show: fmt.rel, num: true },
        { key: 'c', label: '', value: (r) => r.flags & 1, show: (v, r) => (v ? el('span', { class: 'gold' }, '★') : r.flags & 4 ? 'revealed' : 'checked') },
        {
          key: 'log',
          label: 'Breakdown',
          value: (r) => (r.logged ? 1 : 0),
          show: (v, r) =>
            v ? el('button', { class: 'link-btn', type: 'button', onclick: () => pick(r.solve_id) }, r.solve_id === solveParam ? 'shown below' : 'show') : el('span', { class: 'muted', title: 'Solved before move-by-move recording began' }, 'time only'),
        },
      ],
      rows: sorted,
      sort: { key: 'rank', dir: 1 },
    })
  );

  // ----- logged solves: the race and the chosen solve -----
  const logged = sorted.filter((r) => r.logged && r.solve_id).slice(0, MAX_LOGS);
  if (!logged.length) {
    host.append(empty('None of these solves were recorded move by move (recording began with the stats update), so there’s no replay yet.'));
    return;
  }
  const logs = new Map();
  await Promise.all(
    logged.map(async (r) => {
      try {
        const doc = await api.get(`solves/${encodeURIComponent(r.solve_id)}/events`);
        const events = doc.events.map(toEvent);
        logs.set(r.solve_id, { r, events, a: analyzeSolve(model, events) });
      } catch {
        /* skip one we can't read */
      }
    })
  );
  const loggedOk = logged.filter((r) => logs.has(r.solve_id));
  if (!solveParam || !logs.has(solveParam)) {
    solveParam = (loggedOk.find((r) => r.members.includes(me.name)) ?? loggedOk[0])?.solve_id ?? null;
  }

  host.append(raceChart(loggedOk));
  if (loggedOk.length >= 2) host.append(...entryComparison(loggedOk));
  const solveHost = el('div');
  host.append(solveHost);

  function pick(id) {
    if (!logs.has(id)) return;
    solveParam = id;
    const url = new URL(location.href);
    url.searchParams.set('solve', id);
    history.replaceState(null, '', url);
    renderSolve();
    solveHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function raceChart(list) {
    const many = list.length > 3;
    const focus = solveParam;
    return chartGrid(
      chartCard({
        title: 'The race',
        sub: 'Every recorded solve on one clock: the share of squares right as time went on. ' + (many ? 'The chosen solve is in color.' : ''),
        legend: legend(list.map((r) => ({ key: r.solve_id, label: labelOf(r), color: colorOfResult(r), kind: 'line', muted: many && r.solve_id !== focus }))),
        table: {
          columns: [
            ['Solver', (r) => labelOf(r)],
            ['Time', (r) => r.seconds, fmt.time],
            ['First letter', (r) => logs.get(r.solve_id).a.firstEntry?.t ?? null, (v) => mmss(v)],
            ['Grid full', (r) => logs.get(r.solve_id).a.fullAt, (v) => mmss(v)],
          ],
          rows: list,
        },
        draw: (w) =>
          xyChart(w, {
            height: 260,
            label: 'Progress of every recorded solve',
            x: { ticks: 'time', fmt: fmt.time, min: 0 },
            y: { min: 0, max: 100, fmt: (v) => `${v}%` },
            hover: 'x',
            layers: [...list]
              .sort((p, q) => (p.solve_id === focus) - (q.solve_id === focus))
              .map((r) => {
                const { a } = logs.get(r.solve_id);
                return {
                  type: 'line',
                  key: r.solve_id,
                  label: labelOf(r),
                  color: colorOfResult(r),
                  muted: many && r.solve_id !== focus,
                  step: true,
                  points: a.curve.map(([t, , right]) => ({ x: t / 1000, y: (right * 100) / a.cellCount })),
                };
              }),
          }),
      })
    );
  }

  function entryComparison(list) {
    const cols = list.slice(0, 6);
    const rows = model.clueOrder.map((w) => {
      const per = cols.map((r) => logs.get(r.solve_id).a.words.find((x) => x.id === w.id));
      return { w, per, med: median(per.map((x) => x.dwell)) };
    });
    const hardest = [...rows].sort((p, q) => q.med - p.med)[0];
    return [
      sectionHead(
        'Entry by entry',
        `Time with the cursor on each entry, per solver (all visits added up). The group’s slowest: ${hardest.w.num}${hardest.w.dir === 'A' ? '-Across' : '-Down'} (median ${mmss(hardest.med)}).`
      ),
      sortableTable({
        columns: [
          { key: 'e', label: 'Entry', value: (r) => (r.w.dir === 'A' ? 0 : 1000) + r.w.num, show: (_, r) => `${r.w.num}${r.w.dir}` },
          { key: 'c', label: 'Clue', value: (r) => r.w.clueText, show: (v) => el('span', { class: 'clip', title: reveal ? v : '' }, hide(v)) },
          { key: 'a', label: 'Answer', value: (r) => r.per[0].answer, show: (v) => hide(v) },
          ...cols.map((r, k) => ({
            key: `d${k}`,
            label: labelOf(r),
            value: (row) => row.per[k].dwell,
            show: (v, row) => el('span', { class: v === Math.max(...row.per.map((x) => x.dwell)) && v > 0 ? 'fastest' : null }, mmss(v)),
            num: true,
            better: -1,
          })),
          { key: 'm', label: 'Median', value: (r) => r.med, show: mmss, num: true, better: -1 },
        ],
        rows,
        sort: { key: 'm', dir: -1 },
        limit: 15,
      }),
    ];
  }

  // ----- one solve -----

  let stopReplay = () => {};
  function renderSolve() {
    stopReplay();
    solveHost.textContent = '';
    const cur = logs.get(solveParam);
    if (!cur) return;
    const { r, events, a } = cur;
    const pickSel = el(
      'select',
      { class: 'solve-pick', 'aria-label': 'Which solve', onchange: (e) => pick(e.target.value) },
      loggedOk.map((x) => el('option', { value: x.solve_id, ...(x.solve_id === solveParam ? { selected: true } : {}) }, `${labelOf(x)} · ${fmt.time(x.seconds)}`))
    );
    solveHost.append(el('div', { class: 'section-head row' }, [el('h2', {}, `${labelOf(r)}’s solve`), pickSel]));
    if (a.partial) solveHost.append(el('p', { class: 'stats-note' }, 'Part of this solve happened before recording began, so its early squares have no times.'));

    const people = a.people.filter((p) => p.name);
    const sum = (k) => people.reduce((s2, p) => s2 + p[k], 0);
    const letters = sum('letters');
    const across = sum('across');
    const down = sum('down');
    solveHost.append(
      tiles([
        tile({ label: 'Time', value: fmt.time(r.seconds), sub: r.flags & 1 ? '★ clean' : r.flags & 4 ? 'with a reveal' : 'with a check' }),
        tile({ label: 'First letter', value: a.firstEntry ? mmss(a.firstEntry.t) : '—', sub: a.firstEntry ? `at ${cellName(a.firstEntry.cell, a.firstEntry.dir)}` : null }),
        tile({ label: 'Typos', value: String(sum('wrong')), sub: `${letters ? fmt.pct1(sum('wrong') / letters) : '—'} of ${letters} letters typed` }),
        tile({ label: 'Typo hunt', value: a.finishMs != null && a.finishMs > 1500 ? mmss(a.finishMs) : 'none', sub: 'from a full grid to solved' }),
        tile({ label: 'Longest stall', value: mmss(a.stall.ms), sub: `from ${mmss(a.stall.at)}` }),
        tile({ label: 'Across / down', value: across + down ? `${Math.round((across * 100) / (across + down))} / ${Math.round((down * 100) / (across + down))}` : '—', sub: 'letters typed in each direction' }),
        tile({ label: 'Sittings', value: String(Math.max(1, a.sittings)), sub: a.wallMs ? `over ${fmt.time(a.wallMs / 1000)} on the clock` : null }),
        tile({ label: 'Assists', value: `${Object.values(a.checks).reduce((x, y) => x + y, 0)} / ${Object.values(a.reveals).reduce((x, y) => x + y, 0)}`, sub: 'checks / reveals' }),
        people.length > 1 ? tile({ label: 'Split', value: people.map((p) => `${Math.round((p.final * 100) / a.cellCount)}%`).join(' / '), sub: people.map((p) => nameOf(p.name)).join(' / ') }) : null,
      ])
    );

    solveHost.append(replay(r, events, a));
    solveHost.append(chartGrid(heatmaps(r, a)));
    solveHost.append(sectionHead('Entries', 'When each entry was first right, how long the cursor spent on it, and its mistakes. Order is the order entries were completed.'), entryTable(r, a));
  }

  function cellName(i, dir) {
    const w = model.wordAt(i, dir ?? 'A') ?? model.wordAt(i, dir === 'D' ? 'A' : 'D');
    return w ? `${w.num}-${w.dir === 'A' ? 'Across' : 'Down'}` : 'a square';
  }

  // ----- replay -----

  function replay(r, allEvents, a) {
    const events = attemptOf(allEvents);
    const endMs = Math.max(a.ms, events.at(-1)?.t ?? 0);
    const boardWrap = el('div', { class: 'board-wrap', style: `aspect-ratio:${model.width} / ${model.height}` });
    const clueBox = el('div', { class: 'replay-clue' });
    const range = el('input', { type: 'range', min: 0, max: Math.max(1, Math.round(endMs)), step: 100, value: 0, 'aria-label': 'Replay position' });
    const timeText = el('span', { class: 'replay-time' });
    const play = el('button', { class: 'replay-play', type: 'button', 'aria-label': 'Play' }, '▶');
    const auto = SPEEDS.find((s2) => endMs / s2 <= 75_000) ?? SPEEDS.at(-1);
    const people = a.people.filter((p) => p.name).map((p) => p.name);
    const speedSel = el(
      'select',
      { class: 'replay-speed', 'aria-label': 'Speed' },
      SPEEDS.map((s2) => el('option', { value: s2, ...(s2 === auto ? { selected: true } : {}) }, `${s2}×`))
    );
    const moments = [
      a.firstEntry ? ['First letter', a.firstEntry.t] : null,
      a.stall.ms > 0 ? [`Longest stall (${mmss(a.stall.ms)})`, a.stall.at] : null,
      ...a.assists.slice(0, 6).map((x) => [`${x.kind === 'autocheck' ? 'Autocheck' : x.kind === 'check' ? 'Check' : 'Reveal'} ${x.scope}${people.length > 1 && x.user ? ` (${nameOf(x.user)})` : ''}`, x.t]),
      a.fullAt != null ? ['Grid full', a.fullAt] : null,
      a.done ? ['Solved', a.ms] : null,
    ].filter(Boolean);

    const card = el('div', { class: 'chart replay-card' }, [
      el('div', { class: 'chart-head' }, [el('div', { class: 'chart-titles' }, [el('h3', {}, 'Replay'), el('p', { class: 'chart-sub' }, reveal ? 'The grid as it was, second by second (on the solve’s own clock, pauses skipped).' : 'Letters are hidden (•) until you’ve solved it.')])]),
      el('div', { class: 'replay' }, [
        el('div', { class: 'replay-board' }, [boardWrap, el('div', { class: 'replay-controls' }, [play, range, timeText, speedSel])]),
        el('div', { class: 'replay-side' }, [
          el('h3', {}, 'On the cursor'),
          clueBox,
          el('h3', {}, 'Moments'),
          el(
            'ul',
            { class: 'moments' },
            moments.map(([label, t]) => el('li', {}, el('button', { type: 'button', onclick: () => seek(t) }, [el('span', { class: 't' }, mmss(t)), label])))
          ),
        ]),
      ]),
    ]);

    const view = new GridView(boardWrap, model, {});
    let grid = { fill: model.cells.map((c) => (c.isBlack ? '.' : '')), marks: new Array(model.cells.length).fill(0) };
    let k = 0; // events applied
    let now = 0;
    const cursors = new Map(); // user -> {cell, dir}
    const shown = (i) => ({ fill: { [i]: reveal || grid.fill[i] === '' || grid.fill[i] === '.' ? grid.fill[i] : '•' }, marks: grid.marks });
    const drawAll = () => {
      for (const c of model.cells) if (!c.isBlack) view.updateCell(c.index, shown(c.index));
    };
    const apply = (e) => {
      if (applyEvent(model, grid, e)) {
        if (e.kind === 'c') view.updateCell(e.cell, shown(e.cell));
        else drawAll();
      }
      if (e.kind === 'w' && e.user && e.cell != null) cursors.set(e.user, { cell: e.cell, dir: e.dir ?? 'A' });
      else if (e.kind === 'c' && e.user && !(e.marks & 0x04)) cursors.set(e.user, { cell: e.cell, dir: e.dir ?? cursors.get(e.user)?.dir ?? 'A' });
      else if (e.kind === 'p' && e.value === '0' && e.user) cursors.delete(e.user);
    };
    const drawCursors = () => {
      view.pruneRemoteCursors(new Set(cursors.keys()));
      for (const [user, { cell, dir }] of cursors) {
        const w = model.wordAt(cell, dir) ?? model.wordAt(cell, dir === 'A' ? 'D' : 'A');
        view.setRemoteCursor(user, { index: cell, cells: w?.cells ?? [], color: colorOf(user), label: people.length > 1 ? nameOf(user) : null });
      }
      const lines = [...cursors].map(([user, { cell, dir }]) => {
        const w = model.wordAt(cell, dir) ?? model.wordAt(cell, dir === 'A' ? 'D' : 'A');
        if (!w) return null;
        return el('div', {}, [
          people.length > 1 ? el('div', { class: 'who' }, nameOf(user)) : null,
          el('strong', {}, `${w.num}${w.dir} `),
          hide(w.clueText),
        ]);
      });
      clueBox.textContent = '';
      clueBox.append(...lines.filter(Boolean));
      if (!lines.some(Boolean)) clueBox.append(el('span', { class: 'muted' }, now === 0 ? 'Press play.' : '—'));
    };
    function seek(t) {
      t = Math.max(0, Math.min(endMs, t));
      if (t < now || k === 0) {
        grid = { fill: model.cells.map((c) => (c.isBlack ? '.' : '')), marks: new Array(model.cells.length).fill(0) };
        cursors.clear();
        k = 0;
        drawAll();
      }
      while (k < events.length && events[k].t <= t) apply(events[k++]);
      now = t;
      range.value = String(Math.round(t));
      timeText.textContent = `${mmss(t)} / ${mmss(endMs)}`;
      view.setCompleted(t >= endMs && a.done);
      drawCursors();
    }
    let raf = null;
    let last = null;
    const tick = (ts) => {
      if (last != null) seek(now + (ts - last) * Number(speedSel.value));
      last = ts;
      if (now >= endMs) {
        pause();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    function pause() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      last = null;
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Play');
    }
    play.addEventListener('click', () => {
      if (raf) return pause();
      if (now >= endMs) seek(0);
      play.textContent = '❚❚';
      play.setAttribute('aria-label', 'Pause');
      raf = requestAnimationFrame(tick);
    });
    range.addEventListener('input', () => {
      pause();
      seek(Number(range.value));
    });
    stopReplay = pause;
    seek(0);
    drawCursors();
    return card;
  }

  // ----- grid heatmaps -----

  function heatmaps(r, a) {
    const coop = a.people.filter((p) => p.name).length > 1;
    const modes = [
      ['order', 'Fill order'],
      ['right', 'Right for good'],
      ['mistakes', 'Mistakes'],
      ...(coop ? [['who', 'Who filled it']] : []),
    ];
    const state = { mode: 'order' };
    const maxWrong = Math.max(1, ...a.cells.filter(Boolean).map((c) => c.wrong + (c.revealed ? 1 : 0)));
    const scaleFor = () => (state.mode === 'mistakes' ? { type: 'seq', min: 0, max: maxWrong } : { type: 'seq', min: 0, max: a.ms || 1 });
    const controls = el('div', { class: 'chart-controls heat-modes' });
    const legendHost = el('div');
    let fig = null;
    const drawControls = () => {
      controls.textContent = '';
      controls.append(
        el(
          'div',
          { class: 'segmented small', role: 'group', 'aria-label': 'Color by' },
          modes.map(([k, label]) =>
            el(
              'button',
              {
                type: 'button',
                class: k === state.mode ? 'active' : null,
                'aria-pressed': String(k === state.mode),
                onclick: () => {
                  state.mode = k;
                  drawControls();
                  fig?.redraw();
                },
              },
              label
            )
          )
        )
      );
      legendHost.textContent = '';
      legendHost.append(
        state.mode === 'who'
          ? legend(a.people.filter((p) => p.name).map((p) => ({ key: p.name, label: nameOf(p.name), color: colorOf(p.name) })))
          : scaleLegend(scaleFor(), state.mode === 'mistakes' ? { low: 'none', high: `${maxWrong}` } : { low: 'early', high: 'late' })
      );
      controls.append(legendHost);
    };
    drawControls();
    const value = (i) => {
      const c = a.cells[i];
      if (!c) return null;
      if (state.mode === 'order') return c.first;
      if (state.mode === 'right') return c.since;
      if (state.mode === 'mistakes') return c.wrong + (c.revealed ? 1 : 0) || null;
      return null;
    };
    fig = chartCard({
      title: 'The grid, colored',
      sub: 'Fill order: when each square got its first letter. Right for good: when it last became right. Mistakes: wrong letters typed there (a reveal counts one). Empty squares have no data.',
      legend: controls,
      table: {
        columns: [
          ['Square', (x) => `r${x.row + 1}c${x.col + 1}`],
          ['First letter at', (x) => a.cells[x.index].first, (v) => mmss(v)],
          ['Right for good at', (x) => a.cells[x.index].since, (v) => mmss(v)],
          ['Wrong letters', (x) => a.cells[x.index].wrong],
          ['Revealed', (x) => (a.cells[x.index].revealed ? 'yes' : '')],
          ['Filled by', (x) => (a.cells[x.index].by ? nameOf(a.cells[x.index].by) : '')],
        ],
        rows: model.cells.filter((c) => !c.isBlack),
      },
      draw: (w) =>
        gridHeatmap(Math.min(w, 520), {
          model,
          scale: scaleFor(),
          value,
          fill: state.mode === 'who' ? (i) => (a.cells[i]?.by ? colorOf(a.cells[i].by) : null) : null,
          text: reveal ? (i) => a.grid.fill[i] : null,
          maxCell: 34,
          label: 'Grid heatmap',
          tip: (i) => {
            const c = a.cells[i];
            if (!c) return null;
            return {
              title: `${cellName(i, 'A')} / ${cellName(i, 'D')}`,
              rows: [
                { value: c.first != null ? mmss(c.first) : '—', label: 'first letter' },
                { value: c.since != null ? mmss(c.since) : '—', label: 'right for good' },
                { value: String(c.wrong), label: c.wrong === 1 ? 'wrong letter' : 'wrong letters' },
                ...(c.revealed ? [{ value: 'revealed' }] : []),
                ...(c.by ? [{ value: nameOf(c.by), label: 'filled it', color: colorOf(c.by) }] : []),
              ],
            };
          },
        }),
    });
    return fig;
  }

  function entryTable(r, a) {
    const coop = a.people.filter((p) => p.name).length > 1;
    return sortableTable({
      columns: [
        { key: 'e', label: 'Entry', value: (w) => (w.dir === 'A' ? 0 : 1000) + w.num, show: (_, w) => `${w.num}${w.dir}` },
        { key: 'clue', label: 'Clue', value: (w) => w.clue, show: (v) => el('span', { class: 'clip', title: reveal ? v : '' }, hide(v)) },
        { key: 'ans', label: 'Answer', value: (w) => w.answer, show: (v) => hide(v) },
        { key: 'right', label: 'Right at', value: (w) => w.correct, show: mmss, num: true },
        { key: 'dwell', label: 'Time on it', value: (w) => w.dwell, show: mmss, num: true, better: -1 },
        { key: 'rank', label: 'Order', value: (w) => w.rank ?? null, num: true },
        { key: 'err', label: 'Wrong letters', value: (w) => w.errors, num: true, better: -1 },
        { key: 'dir', label: 'Typed', value: (w) => (w.own + w.cross ? w.own / (w.own + w.cross) : null), show: (v) => (v >= 0.5 ? `${Math.round(v * 100)}% this way` : `${Math.round((1 - v) * 100)}% crossing`), num: true, title: 'Letters typed going this entry’s direction vs filled from crossings' },
        { key: 'flags', label: '', value: (w) => (w.revealed ? 2 : w.checked ? 1 : 0), show: (v) => (v === 2 ? 'revealed' : v === 1 ? 'checked' : '') },
        ...(coop ? [{ key: 'by', label: 'Mostly by', value: (w) => (w.by ? nameOf(w.by) : null), show: (v, w) => el('span', { class: 'who' }, [el('span', { class: 'dot', style: `background:${colorOf(w.by)}` }), v]) }] : []),
      ],
      rows: a.words,
      sort: { key: 'rank', dir: 1 },
      limit: 20,
    });
  }

  renderSolve();
}

main();
