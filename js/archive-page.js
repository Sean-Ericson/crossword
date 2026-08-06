/*
 * archive-page.js — home page. Tabs per puzzle type: Daily/Mini/Midi get a
 * month calendar with per-day solve status for the active profile; Bonus
 * (monthly) and Special get list views. The Daily tab also shows the
 * latest-puzzle hero.
 */

import {
  el,
  qs,
  formatTime,
  formatDateLong,
  parsePuzzleId,
  themeTitle,
} from './util.js';
import { loadLocal, statusOf } from './state.js';
import { getActiveUser } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { Sync } from './sync.js';
import { initSyncBadge } from './sync-ui.js';
import { ARCHIVE_START } from './config.js';

const user = getActiveUser();
const pad = (n) => String(n).padStart(2, '0');
const TAB_KEY = 'xw:site:archive-tab';

const TABS = [
  ['daily', 'Daily'],
  ['mini', 'Mini'],
  ['midi', 'Midi'],
  ['bonus', 'Bonus'],
  ['special', 'Special'],
];

const STATUS_ICON = {
  'solved-clean': ['★', 'status-star-gold', 'Solved — clean!'],
  solved: ['★', 'status-star-blue', 'Solved'],
  'in-progress': ['◐', 'status-star-blue', 'In progress'],
  unsolved: ['', '', ''],
};

async function main() {
  initProfileChip(qs('#profile-chip'));
  const sync = new Sync(user);
  initSyncBadge(qs('#sync-badge'), sync);
  const todayStr = new Date().toISOString().slice(0, 10);

  let index = null;
  try {
    const resp = await fetch('./puzzles/index.json', { cache: 'no-cache' });
    if (resp.ok) index = await resp.json();
  } catch {
    /* fall through to empty state */
  }

  const puzzles = (index?.puzzles ?? []).map((p) => ({
    ...p,
    type: p.type ?? parsePuzzleId(p.id).type,
  }));
  if (!puzzles.length) {
    qs('#archive-empty').hidden = false;
    return;
  }

  const byType = new Map(TABS.map(([t]) => [t, []]));
  for (const p of puzzles) {
    (byType.get(p.type) ?? byType.get('special')).push(p);
  }

  // ----- tabs (only those with content; Daily always) -----
  const tabsEl = qs('#type-tabs');
  const available = TABS.filter(([t]) => t === 'daily' || byType.get(t).length);
  let tab = localStorage.getItem(TAB_KEY);
  if (!available.some(([t]) => t === tab)) tab = 'daily';

  const monthView = {}; // per-tab current "YYYY-MM"

  function renderTabs() {
    tabsEl.hidden = available.length <= 1;
    tabsEl.textContent = '';
    for (const [t, label] of available) {
      tabsEl.append(
        el(
          'button',
          {
            class: 'type-tab' + (t === tab ? ' active' : ''),
            onclick: () => {
              tab = t;
              localStorage.setItem(TAB_KEY, t);
              renderTabs();
              renderCurrent();
            },
          },
          label
        )
      );
    }
  }

  function statusBits(id) {
    const record = loadLocal(user, id);
    return { record, status: statusOf(record) };
  }

  // ----- hero (Daily tab only) -----
  function renderHero() {
    const dailies = byType.get('daily');
    const show = tab === 'daily' && dailies.length > 0;
    qs('#hero').hidden = !show;
    if (!show) return;
    const latest = dailies[0]; // index is sorted date-desc
    const { status } = statusBits(latest.id);
    qs('#hero-title').textContent = formatDateLong(latest.date);
    qs('#hero-sub').textContent = [
      latest.author && `By ${latest.author}`,
      `${latest.width}×${latest.height}`,
      status !== 'unsolved' ? STATUS_ICON[status][2] : null,
    ]
      .filter(Boolean)
      .join(' · ');
    qs('#hero-play').href = `./puzzle.html?id=${encodeURIComponent(latest.id)}`;
    qs('#hero-play').textContent =
      status === 'in-progress' ? 'Continue' : status.startsWith('solved') ? 'Review' : 'Play';
  }

  // ----- calendar (Daily / Mini / Midi) -----
  const calHeader = qs('#cal-header');
  const calEl = qs('#calendar');
  const title = qs('#cal-title');
  const prevBtn = qs('#cal-prev');
  const nextBtn = qs('#cal-next');

  const shift = (ym, delta) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };

  function renderCalendar(entries) {
    calHeader.hidden = false;
    const byDate = new Map(entries.map((p) => [p.date, p]));
    // Browsable range spans the whole NYT archive for this type, not just
    // what's downloaded - missing days can be fetched on demand.
    const months = entries.map((p) => p.date.slice(0, 7));
    const archiveStart = ARCHIVE_START[tab];
    const minMonth = [archiveStart?.slice(0, 7), ...months].filter(Boolean).sort()[0];
    const maxMonth = [todayStr.slice(0, 7), ...months].sort().at(-1);
    if (!monthView[tab] || monthView[tab] < minMonth || monthView[tab] > maxMonth) {
      monthView[tab] = maxMonth;
    }
    const view = monthView[tab];

    const [y, m] = view.split('-').map(Number);
    title.textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    prevBtn.disabled = view <= minMonth;
    nextBtn.disabled = view >= maxMonth;
    prevBtn.onclick = () => {
      monthView[tab] = shift(view, -1);
      renderCurrent();
    };
    nextBtn.onclick = () => {
      monthView[tab] = shift(view, 1);
      renderCurrent();
    };

    calEl.textContent = '';
    for (const dow of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
      calEl.append(el('div', { class: 'cal-dow' }, dow));
    }
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let i = 0; i < firstDow; i++) calEl.append(el('div', { class: 'cal-day empty' }));
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${y}-${pad(m)}-${pad(day)}`;
      const puzzle = byDate.get(date);
      if (!puzzle) {
        // Not downloaded. If NYT published one, offer to fetch it.
        const inArchive = archiveStart && date >= archiveStart && date <= todayStr;
        if (inArchive && sync.active) {
          const id = tab === 'daily' ? date : `${tab}-${date}`;
          calEl.append(
            el(
              'a',
              {
                class: 'cal-day fetchable',
                href: `./puzzle.html?id=${encodeURIComponent(id)}`,
                title: `${formatDateLong(date)} — not downloaded yet; opening it fetches it`,
              },
              [el('span', {}, String(day)), el('span', { class: 'day-status' }, '↓')]
            )
          );
        } else {
          calEl.append(el('div', { class: 'cal-day no-puzzle' }, String(day)));
        }
        continue;
      }
      const { record, status } = statusBits(puzzle.id);
      const [icon, iconClass, tooltip] = STATUS_ICON[status];
      calEl.append(
        el(
          'a',
          {
            class: `cal-day has-puzzle st-${status}`,
            href: `./puzzle.html?id=${encodeURIComponent(puzzle.id)}`,
            title: tooltip || formatDateLong(date),
          },
          [
            el('span', {}, String(day)),
            el('span', { class: `day-status ${iconClass}` }, icon),
            record?.completed
              ? el('span', { class: 'day-time' }, formatTime(record.elapsed))
              : el('span', { class: 'day-time' }, ' '),
          ]
        )
      );
    }
  }

  // ----- list view (Bonus / Special) -----
  function renderList(entries, heading, labelFor) {
    qs('#special-list').hidden = false;
    qs('#special-title').textContent = heading;
    const host = qs('#special-items');
    host.textContent = '';
    for (const p of entries) {
      const { status } = statusBits(p.id);
      const [icon, iconClass] = STATUS_ICON[status];
      host.append(
        el(
          'a',
          { class: 'special-item', href: `./puzzle.html?id=${encodeURIComponent(p.id)}` },
          [
            el('span', { class: 'sp-title' }, labelFor(p)),
            el(
              'span',
              { class: 'sp-meta' },
              [p.author, `${p.width}×${p.height}`].filter(Boolean).join(' · ')
            ),
            el('span', { class: `sp-status ${iconClass}` }, icon),
          ]
        )
      );
    }
  }

  function renderCurrent() {
    calHeader.hidden = true;
    calEl.textContent = '';
    qs('#special-list').hidden = true;
    renderHero();

    const entries = byType.get(tab);
    if (tab === 'bonus') {
      renderList(entries, 'Bonus puzzles', (p) => {
        const month = new Date(p.date + 'T12:00:00Z').toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });
        const theme = themeTitle(p.title);
        return theme ? `${month} — ${theme}` : month;
      });
    } else if (tab === 'special') {
      renderList(entries, 'Special puzzles', (p) => themeTitle(p.title) || p.title || p.id);
    } else if (entries.length) {
      renderCalendar(entries);
    }
  }

  renderTabs();
  renderCurrent();
}

main();
