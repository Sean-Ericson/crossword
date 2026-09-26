/*
 * stats-page.js — per-user statistics and multi-user comparison.
 *
 * Anyone with an account can be compared. With a short account list every
 * person gets a chip to toggle; a longer one shows just the people being
 * compared plus "Compare with…" (the people picker). Two or three people
 * get tiles and grouped bars. Four or more get tables (a sortable
 * leaderboard and a weekday grid), which stay readable however many are
 * picked. Each person has their account color, kept distinct within a
 * comparison (see distinctColors). Solo stats only; co-op solves are
 * listed separately and never count toward streaks or times.
 */

import {
  el,
  qs,
  formatTime,
  formatDateLong,
  WEEKDAY_NAMES,
  parsePuzzleId,
} from './util.js';
import { computeUserStats, compareUsers } from './stats.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { api } from './api.js';
import { byDisplayName, distinctColors, listNames } from './people.js';
import { pickPeople } from './people-picker.js';

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun, NYT style
const TYPE_TABS = [
  ['daily', 'Daily'],
  ['mini', 'Mini'],
  ['midi', 'Midi'],
  ['bonus', 'Bonus'],
  ['special', 'Special'],
];
const TYPE_KEY = 'xw:site:stats-type';
const CHIPS_UP_TO = 8; // more accounts than this: "Compare with…" instead of a chip each
const CHIPS_PICKED = 6; // then chips for the people compared, up to this many
const TABLES_FROM = 4; // comparing this many people: tables instead of tiles and bars

/** "Fri, Sep 25, 2026" */
const shortDate = (date) =>
  new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const solvesCache = new Map(); // user -> solves map
const coopCache = new Map(); // user -> co-op solve list

async function getSolves(user) {
  if (!solvesCache.has(user)) {
    const doc = await api.get(`stats/${encodeURIComponent(user)}`).catch(() => null);
    solvesCache.set(user, doc?.solves ?? {});
  }
  return solvesCache.get(user);
}

async function getCoopSolves(user) {
  if (!coopCache.has(user)) {
    const doc = await api.get(`coop-stats/${encodeURIComponent(user)}`).catch(() => null);
    coopCache.set(user, doc?.solves ?? []);
  }
  return coopCache.get(user);
}

async function main() {
  const me = await loadMe();
  const activeUser = me.name;
  initProfileChip(qs('#profile-chip'));

  const accounts = (await api.get('users')).users.sort(byDisplayName);
  const byName = new Map(accounts.map((u) => [u.name, u]));
  const nameOf = (user) => byName.get(user)?.display_name ?? user;
  const byDisplay = (a, b) => byDisplayName(byName.get(a) ?? { name: a }, byName.get(b) ?? { name: b });

  // In the order people were picked: that decides who keeps their own
  // color when two share one.
  const selected = new Set([activeUser]);
  let colors = new Map();
  const colorOf = (user) => colors.get(user) ?? byName.get(user)?.color ?? 'var(--color-text-subtle)';
  const dot = (user) => el('span', { class: 'dot', style: `background:${colorOf(user)}` });
  /** A name that gets cut short in narrow table columns (full name on hover). */
  const shortName = (user) => el('span', { class: 'who-name', title: nameOf(user) }, nameOf(user));
  const who = (user) => el('div', { class: 'who' }, [dot(user), shortName(user)]);

  let statsType = localStorage.getItem(TYPE_KEY);
  if (!TYPE_TABS.some(([t]) => t === statsType)) statsType = 'daily';

  function renderTypeTabs() {
    const host = qs('#type-tabs');
    host.textContent = '';
    for (const [t, label] of TYPE_TABS) {
      host.append(
        el(
          'button',
          {
            class: 'type-tab' + (t === statsType ? ' active' : ''),
            onclick: () => {
              statsType = t;
              localStorage.setItem(TYPE_KEY, t);
              renderTypeTabs();
              render();
            },
          },
          label
        )
      );
    }
  }

  function filterByType(solves) {
    return Object.fromEntries(
      Object.entries(solves).filter(([id]) => parsePuzzleId(id).type === statsType)
    );
  }

  function update() {
    // whoever is already on screen keeps their color as people come and go
    colors = distinctColors(
      [...selected].map((name) => ({ name, color: byName.get(name)?.color })),
      { keep: colors }
    );
    renderSelector();
    render();
  }

  // ----- who's compared -----

  function renderSelector() {
    const host = qs('#user-select');
    host.textContent = '';
    if (accounts.length <= CHIPS_UP_TO) {
      for (const u of accounts) host.append(toggleChip(u.name));
      if (accounts.length <= 1) {
        host.append(el('span', { class: 'user-note' }, 'Other solvers show up here once they have accounts.'));
      }
      return;
    }
    // the first few picked; the tables below list everyone
    const picked = [...selected];
    const shown = picked.length > CHIPS_PICKED ? picked.slice(0, CHIPS_PICKED - 1) : picked;
    for (const user of shown) host.append(pickedChip(user));
    const more = picked.length - shown.length;
    host.append(
      el(
        'button',
        { class: 'user-chip compare-btn', type: 'button', onclick: () => openCompare() },
        more ? `+${more} more · Add or remove…` : selected.size > 1 ? 'Add or remove…' : '+ Compare with…'
      )
    );
  }

  /** Short account list: a chip per person that toggles them. */
  function toggleChip(user) {
    const on = selected.has(user);
    return el('label', { class: 'user-chip' + (on ? ' selected' : '') }, [
      dot(user),
      nameOf(user),
      el('input', {
        type: 'checkbox',
        ...(on ? { checked: true } : {}),
        onchange: (e) => {
          if (e.target.checked) selected.add(user);
          else selected.delete(user);
          if (!selected.size) selected.add(user); // keep at least one
          update();
        },
      }),
    ]);
  }

  /** Long account list: a chip per person being compared, with ×. */
  function pickedChip(user) {
    return el('span', { class: 'user-chip selected' }, [
      dot(user),
      el('span', { class: 'chip-name' }, nameOf(user)),
      selected.size > 1
        ? el(
            'button',
            {
              class: 'chip-x',
              type: 'button',
              title: 'Remove',
              'aria-label': `Stop comparing ${nameOf(user)}`,
              onclick: () => {
                selected.delete(user);
                update();
              },
            },
            '×'
          )
        : null,
    ]);
  }

  async function openCompare() {
    const names = await pickPeople({
      title: 'Compare stats',
      users: accounts,
      selected,
      confirmLabel: 'Compare',
      you: activeUser,
    });
    if (!names?.length) return;
    selected.clear();
    for (const name of names) selected.add(name);
    update();
  }

  // ----- the stats -----

  let renderSeq = 0;
  async function render() {
    const seq = ++renderSeq;
    const users = [...selected].sort(byDisplay);
    const docs = await Promise.all(users.map(getSolves));
    const coop = users.length === 1 ? await getCoopSolves(users[0]) : [];
    if (seq !== renderSeq) return; // a newer render has taken over
    const body = qs('#stats-body');
    body.textContent = '';
    const data = users.map((user, k) => ({ user, solves: filterByType(docs[k]) }));
    if (users.length === 1) {
      renderSingle(body, data[0]);
      renderCoop(body, users[0], coop.filter((s) => parsePuzzleId(s.puzzle_id).type === statsType));
    } else {
      renderComparison(body, data);
    }
  }

  /** Co-op solves: listed on their own, never mixed into solo stats. */
  function renderCoop(body, user, solves) {
    if (!solves.length) return;
    const sorted = [...solves].sort((a, b) => b.puzzle_id.localeCompare(a.puzzle_id));
    const clean = solves.filter((s) => s.clean).length;
    const best = Math.min(...solves.map((s) => s.seconds));
    body.append(
      el('div', { class: 'coop-stats' }, [
        el('h2', {}, 'Co-op solves'),
        el(
          'p',
          { class: 'chart-sub' },
          `${solves.length} solved together · ${clean} clean · best ${formatTime(best)}. Not counted in the solo stats above.`
        ),
        el('div', { class: 'table-scroll' }, el('table', { class: 'h2h-table' }, [
          el('thead', {}, el('tr', {}, [el('th', {}, 'Puzzle'), el('th', {}, 'With'), el('th', {}, 'Time'), el('th', {}, '')])),
          el(
            'tbody',
            {},
            sorted.map((s) => {
              const info = parsePuzzleId(s.puzzle_id);
              const partners = s.members.filter((n) => n !== user).sort(byDisplay);
              // a big group: three names, then "+N" (hover for everyone)
              const shown = partners.length > 4 ? partners.slice(0, 3) : partners;
              return el('tr', {}, [
                el('td', {}, info.date ? shortDate(info.date) : s.puzzle_id),
                el('td', { class: 'with', title: listNames(partners.map(nameOf)) }, [
                  ...shown.map((n) =>
                    el('span', { class: 'coop-partner' }, [
                      el('span', { class: 'dot', style: `background:${byName.get(n)?.color ?? 'var(--color-text-subtle)'}` }),
                      nameOf(n),
                    ])
                  ),
                  shown.length < partners.length
                    ? el('span', { class: 'coop-more' }, `+${partners.length - shown.length} more`)
                    : null,
                ]),
                el('td', {}, formatTime(s.seconds)),
                el('td', { class: 'gold' }, s.clean ? '★' : ''),
              ]);
            })
          ),
        ])),
      ])
    );
  }

  function tile(value, label, sub = '') {
    return el('div', { class: 'stat-tile' }, [
      el('div', { class: 'tile-value' }, value),
      el('div', { class: 'tile-label' }, label),
      sub ? el('div', { class: 'tile-sub' }, sub) : null,
    ]);
  }

  function renderSingle(body, { user, solves }) {
    const st = computeUserStats(solves);
    if (!st.solvedCount) {
      body.append(
        el(
          'div',
          { class: 'stats-empty' },
          `No completed ${statsType} puzzles yet for ${nameOf(user)}. Go solve one!`
        )
      );
      return;
    }
    body.append(
      el('div', { class: 'stat-tiles' }, [
        tile(String(st.solvedCount), 'Puzzles solved'),
        tile(String(st.cleanCount), '★ Clean solves', 'no check or reveal'),
        tile(String(st.currentStreak), 'Current streak', 'consecutive puzzle dates'),
        tile(String(st.longestStreak), 'Longest streak'),
        tile(st.avgSeconds != null ? formatTime(st.avgSeconds) : '—', 'Average time'),
        tile(
          st.bestSeconds != null ? formatTime(st.bestSeconds) : '—',
          'Best time',
          st.bestPuzzleId ?? ''
        ),
      ])
    );

    const maxAvg = Math.max(
      1,
      ...st.byWeekday.map((w) => w.avgSeconds ?? 0)
    );
    const chart = el('div', { class: 'weekday-chart' }, [
      el('h2', {}, 'Average solve time by day'),
      el('p', { class: 'chart-sub' }, 'Bar = average · right label = best'),
    ]);
    for (const dow of WEEKDAY_ORDER) {
      const wk = st.byWeekday[dow];
      chart.append(
        el('div', { class: 'wk-row' }, [
          el('div', { class: 'wk-label' }, WEEKDAY_NAMES[dow].slice(0, 3)),
          el('div', { class: 'wk-bars' }, [
            wk.avgSeconds == null
              ? el('div', { class: 'wk-empty' }, 'no solves')
              : el(
                  'div',
                  {
                    class: 'wk-bar-line',
                    title: `${WEEKDAY_NAMES[dow]}: avg ${formatTime(wk.avgSeconds)} over ${wk.count} solve${wk.count > 1 ? 's' : ''}`,
                  },
                  [
                    el('div', {
                      class: 'wk-bar',
                      style: `width:${(wk.avgSeconds / maxAvg) * 100}%;background:${colorOf(user)}`,
                    }),
                    el('span', { class: 'wk-value' }, formatTime(wk.avgSeconds)),
                    el(
                      'span',
                      { class: 'wk-best' },
                      wk.bestSeconds != null ? `best ${formatTime(wk.bestSeconds)}` : ''
                    ),
                  ]
                ),
          ]),
        ])
      );
    }
    body.append(chart);
  }

  function renderComparison(body, data) {
    const statsByUser = data.map(({ user, solves }) => ({
      user,
      stats: computeUserStats(solves),
    }));
    const h2h = compareUsers(data);
    if (data.length >= TABLES_FROM) {
      body.append(leaderboard(statsByUser, h2h.wins), weekdayTable(statsByUser));
    } else {
      renderTilesAndBars(body, data, statsByUser);
    }
    renderHeadToHead(body, data, h2h, { winChips: data.length < TABLES_FROM });
  }

  /** Two or three people: headline tiles side by side, then grouped bars. */
  function renderTilesAndBars(body, data, statsByUser) {
    body.append(
      el(
        'div',
        { class: 'stat-tiles' },
        statsByUser.map(({ user, stats }) =>
          tile(
            String(stats.solvedCount),
            [dot(user), ` ${nameOf(user)} — solved`],
            `★ ${stats.cleanCount} clean · streak ${stats.currentStreak}`
          )
        )
      )
    );

    const maxAvg = Math.max(
      1,
      ...statsByUser.flatMap(({ stats }) => stats.byWeekday.map((w) => w.avgSeconds ?? 0))
    );
    const chart = el('div', { class: 'weekday-chart' }, [
      el('h2', {}, 'Average solve time by day'),
      el(
        'div',
        { class: 'legend' },
        data.map(({ user }) => el('span', { class: 'legend-item' }, [dot(user), nameOf(user)]))
      ),
    ]);
    for (const dow of WEEKDAY_ORDER) {
      const bars = el('div', { class: 'wk-bars' });
      for (const { user, stats } of statsByUser) {
        const wk = stats.byWeekday[dow];
        bars.append(
          wk.avgSeconds == null
            ? el('div', { class: 'wk-empty' }, `${nameOf(user)}: —`)
            : el(
                'div',
                {
                  class: 'wk-bar-line',
                  title: `${nameOf(user)} — ${WEEKDAY_NAMES[dow]}: avg ${formatTime(wk.avgSeconds)} over ${wk.count}`,
                },
                [
                  el('div', {
                    class: 'wk-bar',
                    style: `width:${(wk.avgSeconds / maxAvg) * 100}%;background:${colorOf(user)}`,
                  }),
                  el('span', { class: 'wk-value' }, `${formatTime(wk.avgSeconds)}`),
                ]
              )
        );
      }
      chart.append(
        el('div', { class: 'wk-row' }, [
          el('div', { class: 'wk-label' }, WEEKDAY_NAMES[dow].slice(0, 3)),
          bars,
        ])
      );
    }
    body.append(chart);
  }

  // Leaderboard columns. `better` is the direction a column sorts in first
  // (more solves, faster times); people with no value always sort last.
  const BOARD_COLUMNS = [
    { key: 'solved', label: 'Solved', value: (r) => r.stats.solvedCount, show: String, better: -1 },
    { key: 'clean', label: '★ Clean', value: (r) => r.stats.cleanCount, show: String, better: -1 },
    { key: 'streak', label: 'Streak', value: (r) => r.stats.currentStreak, show: String, better: -1 },
    { key: 'avg', label: 'Average', value: (r) => r.stats.avgSeconds, show: formatTime, better: 1 },
    { key: 'best', label: 'Best', value: (r) => r.stats.bestSeconds, show: formatTime, better: 1 },
    { key: 'wins', label: 'Wins', value: (r) => r.wins, show: String, better: -1 },
  ];
  let boardSort = { key: 'solved', dir: -1 };

  /** Four or more people: one row each, sortable by any column. */
  function leaderboard(statsByUser, wins) {
    const rows = statsByUser.map((r) => ({ ...r, wins: wins[r.user] ?? 0 }));
    const section = el('div', { class: 'board' }, [
      el('h2', {}, 'Leaderboard'),
      el('p', { class: 'chart-sub' }, 'Streak = current run of consecutive puzzle dates · Wins = fastest on a puzzle two or more of you solved. Click a heading to sort.'),
    ]);
    const holder = el('div', { class: 'table-scroll' });
    section.append(holder);

    function draw() {
      const col = BOARD_COLUMNS.find((c) => c.key === boardSort.key);
      const sorted = [...rows].sort((a, b) => {
        const va = col.value(a);
        const vb = col.value(b);
        if (va == null && vb == null) return byDisplay(a.user, b.user);
        if (va == null || vb == null) return va == null ? 1 : -1;
        return (va - vb) * boardSort.dir || byDisplay(a.user, b.user);
      });
      holder.textContent = '';
      holder.append(
        el('table', { class: 'h2h-table board-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, 'Solver'),
            ...BOARD_COLUMNS.map((c) => {
              const active = c.key === boardSort.key;
              return el(
                'th',
                { class: 'num', 'aria-sort': active ? (boardSort.dir < 0 ? 'descending' : 'ascending') : null },
                el(
                  'button',
                  {
                    class: 'sort-btn' + (active ? ' active' : ''),
                    type: 'button',
                    onclick: () => {
                      boardSort = active ? { key: c.key, dir: -boardSort.dir } : { key: c.key, dir: c.better };
                      draw();
                    },
                  },
                  [c.label, active ? (boardSort.dir < 0 ? ' ▾' : ' ▴') : '']
                )
              );
            }),
          ])),
          el(
            'tbody',
            {},
            sorted.map((r) =>
              el('tr', { class: r.user === activeUser ? 'you' : null }, [
                el('td', {}, who(r.user)),
                ...BOARD_COLUMNS.map((c) => {
                  const v = c.value(r);
                  return el('td', { class: 'num' }, v == null ? '—' : c.show(v));
                }),
              ])
            )
          ),
        ])
      );
    }
    draw();
    return section;
  }

  /** Four or more people: average time per weekday, fastest in bold. */
  function weekdayTable(statsByUser) {
    const fastest = WEEKDAY_ORDER.map((dow) => {
      const avgs = statsByUser.map(({ stats }) => stats.byWeekday[dow].avgSeconds).filter((v) => v != null);
      return avgs.length ? Math.min(...avgs) : null;
    });
    return el('div', { class: 'weekday-chart' }, [
      el('h2', {}, 'Average solve time by day'),
      el('p', { class: 'chart-sub' }, 'Fastest average each day in bold.'),
      el('div', { class: 'table-scroll' }, el('table', { class: 'h2h-table wk-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, 'Solver'),
          ...WEEKDAY_ORDER.map((dow) => el('th', { class: 'num' }, WEEKDAY_NAMES[dow].slice(0, 3))),
        ])),
        el(
          'tbody',
          {},
          statsByUser.map(({ user, stats }) =>
            el('tr', { class: user === activeUser ? 'you' : null }, [
              el('td', {}, who(user)),
              ...WEEKDAY_ORDER.map((dow, k) => {
                const wk = stats.byWeekday[dow];
                if (wk.avgSeconds == null) return el('td', { class: 'num empty' }, '—');
                return el(
                  'td',
                  {
                    class: 'num' + (wk.avgSeconds === fastest[k] ? ' fastest' : ''),
                    title: `${nameOf(user)} — ${WEEKDAY_NAMES[dow]}: avg ${formatTime(wk.avgSeconds)} over ${wk.count}, best ${formatTime(wk.bestSeconds)}`,
                  },
                  formatTime(wk.avgSeconds)
                );
              }),
            ])
          )
        ),
      ])),
    ]);
  }

  function renderHeadToHead(body, data, { common, wins }, { winChips }) {
    const h2h = el('div', { class: 'h2h' }, [el('h2', {}, 'Head to head')]);
    if (!common.length) {
      h2h.append(
        el('p', { class: 'chart-sub' }, 'No commonly-solved puzzles yet.')
      );
      body.append(h2h);
      return;
    }
    if (winChips) {
      h2h.append(
        el(
          'div',
          { class: 'h2h-wins' },
          [...data]
            .sort((a, b) => (wins[b.user] ?? 0) - (wins[a.user] ?? 0) || byDisplay(a.user, b.user))
            .map(({ user }) =>
              el('span', { class: 'win-chip' }, [
                dot(user),
                nameOf(user),
                el('b', {}, String(wins[user] ?? 0)),
                'wins',
              ])
            )
        )
      );
    } else {
      h2h.append(el('p', { class: 'chart-sub' }, 'Puzzles at least two of you solved, newest first; the fastest time is in bold.'));
    }
    const table = el('table', { class: 'h2h-table' });
    table.append(
      el('tr', {}, [
        el('th', {}, 'Puzzle'),
        ...data.map(({ user }) => el('th', {}, shortName(user))),
        el('th', {}, 'Fastest'),
      ])
    );
    for (const row of common.slice(0, 50)) {
      table.append(
        el('tr', {}, [
          el('td', {}, [
            el(
              'a',
              { href: `./puzzle.html?id=${encodeURIComponent(row.puzzleId)}`, title: row.date ? formatDateLong(row.date) : null },
              row.date ? shortDate(row.date) : row.puzzleId
            ),
          ]),
          ...data.map(({ user }) =>
            el(
              'td',
              { class: row.winner === user ? 'fastest' : '' },
              row.times[user] != null ? formatTime(row.times[user]) : '—'
            )
          ),
          el('td', {}, row.winner ? nameOf(row.winner) : 'tie'),
        ])
      );
    }
    h2h.append(el('div', { class: 'table-scroll' }, table));
    body.append(h2h);
  }

  renderTypeTabs();
  update();
}

main();
