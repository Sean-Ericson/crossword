/*
 * profile-ui.js — shared profile chip + switcher modal used by all pages.
 */

import { el } from './util.js';
import { showModal, confirmDialog, toast } from './modals.js';
import {
  localDataSummary,
  migrateUserData,
  deleteUserData,
  loadStatsLocal,
} from './state.js';
import { Sync } from './sync.js';
import {
  getActiveUser,
  setActiveUser,
  getLocalProfiles,
  addLocalProfile,
  removeLocalProfile,
  PROFILE_NAME_RE,
} from './profiles.js';

/** Render the header chip; clicking opens the switcher. */
export function initProfileChip(chipEl) {
  chipEl.textContent = getActiveUser();
  chipEl.style.cursor = 'pointer';
  chipEl.title = 'Switch profile';
  chipEl.addEventListener('click', () => openProfileModal());
}

export function openProfileModal() {
  const active = getActiveUser();
  const profiles = [...new Set([active, ...getLocalProfiles()])].sort();

  const list = el(
    'div',
    { style: 'text-align:left' },
    profiles.map((name) => {
      const summary = localDataSummary(name);
      const row = el('div', {
        style: 'display:flex;gap:10px;align-items:center;padding:7px 4px;font-size:15px',
      });
      row.append(
        el(
          'label',
          { style: 'display:flex;gap:10px;align-items:center;cursor:pointer;flex:1' },
          [
            el('input', {
              type: 'radio',
              name: 'profile',
              value: name,
              ...(name === active ? { checked: true } : {}),
              onchange: () => switchTo(name, { migrate: false }),
            }),
            name,
            summary.solves
              ? el(
                  'span',
                  { style: 'color:var(--color-text-muted);font-size:12px' },
                  `${summary.solves} solved`
                )
              : null,
          ]
        )
      );
      // The active profile can't be removed - switch away from it first.
      if (name !== active) {
        row.append(
          el(
            'button',
            {
              class: 'btn-quiet',
              title: `Remove “${name}” from this device`,
              style: 'font-size:16px;line-height:1;color:var(--color-text-muted)',
              onclick: () => removeProfile(name, summary),
            },
            '✕'
          )
        );
      }
      return row;
    })
  );

  const input = el('input', {
    type: 'text',
    placeholder: 'new-profile-name',
    style:
      'flex:1;padding:8px 10px;border:1px solid var(--color-border);border-radius:6px;font-size:14px',
  });

  // Offer to carry this device's existing solves onto the new profile.
  // Checked by default from "guest", since that is the unnamed default
  // identity people accumulate solves under before setting up a profile.
  const summary = localDataSummary(active);
  let migrateBox = null;
  let migrateRow = null;
  if (summary.any) {
    const bits = [];
    if (summary.solves) bits.push(`${summary.solves} solved`);
    if (summary.started) bits.push(`${summary.started} in progress`);
    migrateBox = el('input', {
      type: 'checkbox',
      ...(active === 'guest' ? { checked: true } : {}),
    });
    migrateRow = el(
      'label',
      {
        style:
          'display:flex;gap:10px;align-items:flex-start;margin-top:12px;cursor:pointer;font-size:13px;line-height:1.4',
      },
      [
        migrateBox,
        el('span', {}, [
          `Move “${active}”’s puzzles to the new profile`,
          bits.length ? el('span', { style: 'color:var(--color-text-muted)' }, ` (${bits.join(', ')})`) : null,
        ]),
      ]
    );
  }

  const addRow = el('div', { style: 'display:flex;gap:8px;margin-top:10px' }, [
    input,
    el(
      'button',
      {
        class: 'btn',
        onclick: () => {
          const name = input.value.trim().toLowerCase();
          if (!PROFILE_NAME_RE.test(name)) {
            toast('Names: 1-24 lowercase letters, digits, or hyphens.', { error: true });
            return;
          }
          if (profiles.includes(name)) {
            toast(`“${name}” already exists — pick it above.`, { error: true });
            return;
          }
          switchTo(name, { migrate: !!migrateBox?.checked });
        },
      },
      'Add'
    ),
  ]);

  const close = showModal({
    title: 'Who’s solving?',
    body: el('div', {}, [
      list,
      addRow,
      migrateRow,
      el(
        'p',
        { style: 'font-size:12px;margin-top:12px' },
        'Each profile keeps its own progress, stats, and settings.'
      ),
    ]),
  });

  async function removeProfile(name, summary) {
    const bits = [];
    if (summary.solves) bits.push(`${summary.solves} solved`);
    if (summary.started) bits.push(`${summary.started} in progress`);
    const what = bits.length
      ? `This deletes “${name}” and its saved puzzles (${bits.join(', ')}).`
      : `Remove “${name}” from this device?`;
    const ok = await confirmDialog(
      `${what} This only affects this browser — anything already synced stays in the data repo.`,
      { confirmLabel: 'Remove profile', title: `Remove ${name}?` }
    );
    if (!ok) return;
    deleteUserData(name);
    removeLocalProfile(name);
    toast(`Removed “${name}”.`);
    close();
    location.reload();
  }

  async function switchTo(name, { migrate }) {
    addLocalProfile(name);
    if (migrate && name !== active) {
      const moved = migrateUserData(active, name);
      if (moved.puzzles || moved.solves) {
        toast(`Moved ${moved.puzzles} puzzle${moved.puzzles === 1 ? '' : 's'} to “${name}”.`);
      }
      // Push the adopted solve log now so the stats page and other devices
      // see it without waiting for the next completed puzzle. Individual
      // progress records sync as each puzzle is opened.
      setActiveUser(name);
      const sync = new Sync(name);
      if (sync.active) {
        try {
          await sync.ensureProfile();
          await sync.pushStats(loadStatsLocal(name));
        } catch {
          /* the next solve will retry */
        }
      }
    } else {
      setActiveUser(name);
    }
    close();
    location.reload();
  }
}
