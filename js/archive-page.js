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

  const monthSel = qs('#cal-month');
  const yearSel = qs('#cal-year');

  const shift = (ym, delta) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };

  const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2000, i, 1)).toLocaleDateString('en-US', {
      month: 'long',
      timeZone: 'UTC',
    })
  );

  function fillSelect(select, options, selected) {
    select.textContent = '';
    for (const { value, label, disabled } of options) {
      select.append(
        el('option', { value, ...(disabled ? { disabled: true } : {}) }, label)
      );
    }
    select.value = String(selected);
  }

  /**
   * Point the month/year dropdowns at `view`, clamped to the archive's
   * range. Jumping to 2003 by way of 270 clicks on "‹" is no fun.
   */
  function syncMonthYearPickers(view, minMonth, maxMonth) {
    const [y, m] = view.split('-').map(Number);
    const minYear = Number(minMonth.slice(0, 4));
    const maxYear = Number(maxMonth.slice(0, 4));

    monthSel.hidden = false;
    fillSelect(
      monthSel,
      MONTH_NAMES.map((label, i) => {
        const ym = `${y}-${pad(i + 1)}`;
        return { value: String(i + 1), label, disabled: ym < minMonth || ym > maxMonth };
      }),
      m
    );
    fillSelect(
      yearSel,
      Array.from({ length: maxYear - minYear + 1 }, (_, i) => {
        const year = maxYear - i; // newest first, like the archive itself
        return { value: String(year), label: String(year) };
      }),
      y
    );

    const goTo = (ym) => {
      // Clamp, so picking e.g. December of the current year lands on the
      // newest month that actually exists rather than an empty grid.
      monthView[tab] = ym < minMonth ? minMonth : ym > maxMonth ? maxMonth : ym;
      renderCurrent();
    };
    monthSel.onchange = () => goTo(`${yearSel.value}-${pad(Number(monthSel.value))}`);
    yearSel.onchange = () => goTo(`${yearSel.value}-${pad(Number(monthSel.value))}`);
  }

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
    syncMonthYearPickers(view, minMonth, maxMonth);
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

  /**
   * Bonus puzzles come out monthly, so browse them a year at a time.
   * Months NYT published but we haven't downloaded are offered for
   * fetching, exactly like the dashed days in the calendar.
   */
  function renderBonusYear(entries) {
    const byDate = new Map(entries.map((p) => [p.date, p]));
    const start = ARCHIVE_START.bonus;
    const minYear = Number(start.slice(0, 4));
    const maxYear = Number(todayStr.slice(0, 4));
    let year = Number((monthView.bonus ?? '').slice(0, 4));
    if (!year || year < minYear || year > maxYear) {
      year = Number((entries[0]?.date ?? todayStr).slice(0, 4));
    }
    monthView.bonus = `${year}-01`;

    calHeader.hidden = false;
    // Bonus puzzles are monthly, so only the year picker makes sense here.
    monthSel.hidden = true;
    fillSelect(
      yearSel,
      Array.from({ length: maxYear - minYear + 1 }, (_, i) => {
        const y = maxYear - i;
        return { value: String(y), label: String(y) };
      }),
      year
    );
    yearSel.onchange = () => {
      monthView.bonus = `${yearSel.value}-01`;
      renderCurrent();
    };
    monthSel.onchange = null;
    prevBtn.disabled = year <= minYear;
    nextBtn.disabled = year >= maxYear;
    prevBtn.onclick = () => {
      monthView.bonus = `${year - 1}-01`;
      renderCurrent();
    };
    nextBtn.onclick = () => {
      monthView.bonus = `${year + 1}-01`;
      renderCurrent();
    };

    qs('#special-list').hidden = false;
    qs('#special-title').textContent = 'Bonus puzzles';
    const host = qs('#special-items');
    host.textContent = '';

    for (let m = 1; m <= 12; m++) {
      const date = `${year}-${pad(m)}-01`;
      const monthName = new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'long',
        timeZone: 'UTC',
      });
      const puzzle = byDate.get(date);
      if (puzzle) {
        const { status } = statusBits(puzzle.id);
        const [icon, iconClass] = STATUS_ICON[status];
        host.append(
          el(
            'a',
            { class: 'special-item', href: `./puzzle.html?id=${encodeURIComponent(puzzle.id)}` },
            [
              el('span', { class: 'sp-title' }, [monthName, themeTitle(puzzle.title) ? ` — ${themeTitle(puzzle.title)}` : ''].join('')),
              el(
                'span',
                { class: 'sp-meta' },
                [puzzle.author, `${puzzle.width}×${puzzle.height}`].filter(Boolean).join(' · ')
              ),
              el('span', { class: `sp-status ${iconClass}` }, icon),
            ]
          )
        );
        continue;
      }
      const published = date >= start && date <= todayStr;
      if (published && sync.active) {
        host.append(
          el(
            'a',
            {
              class: 'special-item fetchable',
              href: `./puzzle.html?id=bonus-${date}`,
              title: 'Not downloaded yet — opening it fetches it',
            },
            [
              el('span', { class: 'sp-title' }, monthName),
              el('span', { class: 'sp-meta' }, 'not downloaded'),
              el('span', { class: 'sp-status' }, '↓'),
            ]
          )
        );
      } else if (published) {
        host.append(
          el('div', { class: 'special-item unavailable' }, [
            el('span', { class: 'sp-title' }, monthName),
            el('span', { class: 'sp-meta' }, 'not downloaded — connect sync to fetch'),
          ])
        );
      }
    }
  }

  function renderCurrent() {
    calHeader.hidden = true;
    calEl.textContent = '';
    qs('#special-list').hidden = true;
    renderHero();

    const entries = byType.get(tab);
    if (tab === 'bonus') {
      renderBonusYear(entries);
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
