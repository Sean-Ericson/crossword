/*
 * stats-page.js — per-user statistics and multi-user comparison.
 *
 * Users shown = local profiles ∪ users discovered in the data repo.
 * Each user keeps a stable color assigned from the sorted list of all
 * known users (color follows the entity, not the selection order).
 */

import { el, qs, formatTime, formatDateLong, WEEKDAY_NAMES } from './util.js';
import { computeUserStats, compareUsers } from './stats.js';
import { loadStatsLocal, mergeStats } from './state.js';
import { getActiveUser, getLocalProfiles } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { Sync } from './sync.js';
import { initSyncBadge } from './sync-ui.js';

// Okabe-Ito subset — CVD-validated; bars always carry direct value labels
// and the comparison ships a table view (contrast relief).
const USER_COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#999999'];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun, NYT style

const activeUser = getActiveUser();
const sync = new Sync(activeUser);
const solvesCache = new Map(); // user -> solves map

async function getSolves(user) {
  if (solvesCache.has(user)) return solvesCache.get(user);
  const isLocal = user === activeUser || getLocalProfiles().includes(user);
  const localDoc = isLocal ? loadStatsLocal(user) : null;
  let remoteDoc = null;
  if (sync.active) {
    remoteDoc = await new Sync(user).pullStats(user);
  }
  const solves = mergeStats(localDoc, remoteDoc)?.solves ?? {};
  solvesCache.set(user, solves);
  return solves;
}

async function main() {
  initProfileChip(qs('#profile-chip'));
  initSyncBadge(qs('#sync-badge'), sync);

  const locals = new Set([activeUser, ...getLocalProfiles()]);
  const remotes = sync.active ? await sync.listUsers() : [];
  const allUsers = [...new Set([...locals, ...remotes])].sort();
  const colorOf = (user) =>
    USER_COLORS[allUsers.indexOf(user) % USER_COLORS.length];

  const selected = new Set([activeUser]);
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
          user,
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
    if (!sync.active && allUsers.length <= 1) {
      host.append(
        el('span', { class: 'user-note' }, 'Connect GitHub sync to compare with other solvers.')
      );
    }
  }

  async function render() {
    const body = qs('#stats-body');
    body.textContent = '';
    const users = [...selected].sort();
    const data = [];
    for (const user of users) {
      data.push({ user, solves: await getSolves(user) });
    }
    if (users.length === 1) renderSingle(body, data[0]);
    else renderComparison(body, data);
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
        el('div', { class: 'stats-empty' }, `No completed puzzles yet for “${user}”. Go solve one!`)
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
