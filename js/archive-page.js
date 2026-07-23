/*
 * archive-page.js — home page: latest-puzzle hero, month calendar with
 * per-day solve status for the active profile, and special puzzles list.
 */

import { el, qs, formatTime, formatDateLong } from './util.js';
import { loadLocal, statusOf } from './state.js';
import { getActiveUser } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { Sync } from './sync.js';
import { initSyncBadge } from './sync-ui.js';

const user = getActiveUser();
const pad = (n) => String(n).padStart(2, '0');

const STATUS_ICON = {
  'solved-clean': ['★', 'status-star-gold', 'Solved — clean!'],
  solved: ['★', 'status-star-blue', 'Solved'],
  'in-progress': ['◐', 'status-star-blue', 'In progress'],
  unsolved: ['', '', ''],
};

async function main() {
  initProfileChip(qs('#profile-chip'));
  initSyncBadge(qs('#sync-badge'), new Sync(user));

  let index = null;
  try {
    const resp = await fetch('./puzzles/index.json', { cache: 'no-cache' });
    if (resp.ok) index = await resp.json();
  } catch {
    /* fall through to empty state */
  }

  const puzzles = index?.puzzles ?? [];
  const dated = puzzles.filter((p) => p.date);
  const special = puzzles.filter((p) => !p.date);

  if (!puzzles.length) {
    qs('#archive-empty').hidden = false;
    return;
  }

  const byDate = new Map(dated.map((p) => [p.date, p]));

  // ----- hero: newest dated puzzle -----
  if (dated.length) {
    const latest = dated[0]; // index is sorted date-desc
    const status = statusOf(loadLocal(user, latest.id));
    qs('#hero').hidden = false;
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

  // ----- calendar -----
  if (dated.length) {
    qs('#cal-header').hidden = false;
    const months = [...new Set(dated.map((p) => p.date.slice(0, 7)))].sort();
    const minMonth = months[0];
    const maxMonth = months[months.length - 1];
    let view = maxMonth; // "YYYY-MM"

    const title = qs('#cal-title');
    const prevBtn = qs('#cal-prev');
    const nextBtn = qs('#cal-next');
    const calEl = qs('#calendar');

    const shift = (ym, delta) => {
      const [y, m] = ym.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    };

    const render = () => {
      const [y, m] = view.split('-').map(Number);
      title.textContent = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
      prevBtn.disabled = view <= minMonth;
      nextBtn.disabled = view >= maxMonth;

      calEl.textContent = '';
      for (const dow of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
        calEl.append(el('div', { class: 'cal-dow' }, dow));
      }
      const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let i = 0; i < firstDow; i++) calEl.append(el('div', { class: 'cal-day empty' }));
      for (let day = 1; day <= daysInMonth; day++) {
        const id = `${y}-${pad(m)}-${pad(day)}`;
        const puzzle = byDate.get(id);
        if (!puzzle) {
          calEl.append(el('div', { class: 'cal-day no-puzzle' }, String(day)));
          continue;
        }
        const record = loadLocal(user, id);
        const status = statusOf(record);
        const [icon, iconClass, tooltip] = STATUS_ICON[status];
        calEl.append(
          el(
            'a',
            {
              class: `cal-day has-puzzle st-${status}`,
              href: `./puzzle.html?id=${encodeURIComponent(id)}`,
              title: tooltip || formatDateLong(id),
            },
            [
              el('span', {}, String(day)),
              el('span', { class: `day-status ${iconClass}` }, icon),
              record?.completed
                ? el('span', { class: 'day-time' }, formatTime(record.elapsed))
                : el('span', { class: 'day-time' }, ' '),
            ]
          )
        );
      }
    };

    prevBtn.addEventListener('click', () => {
      if (view > minMonth) {
        view = shift(view, -1);
        render();
      }
    });
    nextBtn.addEventListener('click', () => {
      if (view < maxMonth) {
        view = shift(view, 1);
        render();
      }
    });
    render();
  }

  // ----- special puzzles -----
  if (special.length) {
    qs('#special-list').hidden = false;
    const host = qs('#special-items');
    for (const p of special) {
      const status = statusOf(loadLocal(user, p.id));
      const [icon, iconClass] = STATUS_ICON[status];
      host.append(
        el(
          'a',
          { class: 'special-item', href: `./puzzle.html?id=${encodeURIComponent(p.id)}` },
          [
            el('span', { class: 'sp-title' }, p.title || p.id),
            el('span', { class: 'sp-meta' }, [p.author, `${p.width}×${p.height}`].filter(Boolean).join(' · ')),
            el('span', { class: `sp-status ${iconClass}` }, icon),
          ]
        )
      );
    }
  }
}

main();
