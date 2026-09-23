/*
 * stats-page.js — per-user statistics and multi-user comparison.
 *
 * Users shown = every account on the server, each in its own color (the
 * same one their cursor has in co-op solves). Solo stats only; co-op
 * solves are listed separately and never count toward streaks or times.
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

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun, NYT style
const TYPE_TABS = [
  ['daily', 'Daily'],
  ['mini', 'Mini'],
  ['midi', 'Midi'],
  ['bonus', 'Bonus'],
  ['special', 'Special'],
];
const TYPE_KEY = 'xw:site:stats-type';

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

  const accounts = (await api.get('users')).users;
  const allUsers = accounts.map((u) => u.name).sort();
  const colorOf = (user) => accounts.find((u) => u.name === user)?.color ?? '#999999';
  const nameOf = (user) => accounts.find((u) => u.name === user)?.display_name ?? user;

  const selected = new Set([activeUser]);
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

  renderTypeTabs();
  renderSelector();
  render();

  function renderSelector() {
    const host = qs('#user-select');
    host.textContent = '';
    for (const user of allUsers) {
      const chip = el(
        'label',
        { class: 'user-chip' + (selected.has(user) ? ' selected' : '') },
        [
          el('span', { class: 'dot', style: `background:${colorOf(user)}` }),
          nameOf(user),
          el('input', {
            type: 'checkbox',
            ...(selected.has(user) ? { checked: true } : {}),
            onchange: (e) => {
              if (e.target.checked) selected.add(user);
              else selected.delete(user);
              if (!selected.size) selected.add(user); // keep at least one
              renderSelector();
              render();
            },
          }),
        ]
      );
      host.append(chip);
    }
    if (allUsers.length <= 1) {
      host.append(el('span', { class: 'user-note' }, 'Other solvers show up here once they have accounts.'));
    }
  }

  async function render() {
    const body = qs('#stats-body');
    body.textContent = '';
    const users = [...selected].sort();
    const data = [];
    for (const user of users) {
      data.push({ user, solves: filterByType(await getSolves(user)) });
    }
    if (users.length === 1) {
      renderSingle(body, data[0]);
      renderCoop(body, users[0], (await getCoopSolves(users[0])).filter(
        (s) => parsePuzzleId(s.puzzle_id).type === statsType
      ));
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
        el('table', { class: 'h2h-table' }, [
          el('thead', {}, el('tr', {}, [el('th', {}, 'Puzzle'), el('th', {}, 'With'), el('th', {}, 'Time'), el('th', {}, '')])),
          el(
            'tbody',
            {},
            sorted.map((s) => {
              const info = parsePuzzleId(s.puzzle_id);
              return el('tr', {}, [
                el('td', {}, info.date ? formatDateLong(info.date) : s.puzzle_id),
                el(
                  'td',
                  {},
                  s.members
                    .filter((n) => n !== user)
                    .map((n) => el('span', { class: 'coop-partner' }, [
                      el('span', { class: 'dot', style: `background:${colorOf(n)}` }),
                      nameOf(n),
                    ]))
                ),
                el('td', {}, formatTime(s.seconds)),
                el('td', { class: 'gold' }, s.clean ? '★' : ''),
              ]);
            })
          ),
        ]),
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
          `No completed ${statsType} puzzles yet for “${user}”. Go solve one!`
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

    // headline tiles: solved counts side by side
    body.append(
      el(
        'div',
        { class: 'stat-tiles' },
        statsByUser.map(({ user, stats }) =>
          tile(
            String(stats.solvedCount),
            `${user} — solved`,
            `★ ${stats.cleanCount} clean · streak ${stats.currentStreak}`
          )
        )
      )
    );

    // weekday grouped bars
    const maxAvg = Math.max(
      1,
      ...statsByUser.flatMap(({ stats }) => stats.byWeekday.map((w) => w.avgSeconds ?? 0))
    );
    const chart = el('div', { class: 'weekday-chart' }, [
      el('h2', {}, 'Average solve time by day'),
      el(
        'div',
        { class: 'legend' },
        data.map(({ user }) =>
          el('span', { class: 'legend-item' }, [
            el('span', { class: 'dot', style: `background:${colorOf(user)}` }),
            user,
          ])
        )
      ),
    ]);
    for (const dow of WEEKDAY_ORDER) {
      const bars = el('div', { class: 'wk-bars' });
      for (const { user, stats } of statsByUser) {
        const wk = stats.byWeekday[dow];
        bars.append(
          wk.avgSeconds == null
            ? el('div', { class: 'wk-empty' }, `${user}: —`)
            : el(
                'div',
                {
                  class: 'wk-bar-line',
                  title: `${user} — ${WEEKDAY_NAMES[dow]}: avg ${formatTime(wk.avgSeconds)} over ${wk.count}`,
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

    // head-to-head
    const { common, wins } = compareUsers(data);
    const h2h = el('div', { class: 'h2h' }, [el('h2', {}, 'Head to head')]);
    if (!common.length) {
      h2h.append(
        el('p', { class: 'chart-sub' }, 'No commonly-solved puzzles yet.')
      );
    } else {
      h2h.append(
        el(
          'div',
          { class: 'h2h-wins' },
          data.map(({ user }) =>
            el('span', { class: 'win-chip' }, [
              el('span', { class: 'dot', style: `background:${colorOf(user)}` }),
              `${user}`,
              el('b', {}, String(wins[user] ?? 0)),
              'wins',
            ])
          )
        )
      );
      const table = el('table', { class: 'h2h-table' });
      table.append(
        el('tr', {}, [
          el('th', {}, 'Puzzle'),
          ...data.map(({ user }) => el('th', {}, user)),
          el('th', {}, 'Fastest'),
        ])
      );
      for (const row of common.slice(0, 50)) {
        table.append(
          el('tr', {}, [
            el('td', {}, [
              el(
                'a',
                { href: `./puzzle.html?id=${encodeURIComponent(row.puzzleId)}` },
                row.date ? formatDateLong(row.date) : row.puzzleId
              ),
            ]),
            ...data.map(({ user }) =>
              el(
                'td',
                { class: row.winner === user ? 'fastest' : '' },
                row.times[user] != null ? formatTime(row.times[user]) : '—'
              )
            ),
            el('td', {}, row.winner ?? 'tie'),
          ])
        );
      }
      h2h.append(table);
    }
    body.append(h2h);
  }
}

main();
