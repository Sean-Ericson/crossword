/*
 * profile-ui.js — shared profile chip + switcher modal used by all pages.
 */

import { el } from './util.js';
import { showModal, toast } from './modals.js';
import {
  getActiveUser,
  setActiveUser,
  getLocalProfiles,
  addLocalProfile,
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
    profiles.map((name) =>
      el(
        'label',
        {
          style:
            'display:flex;gap:10px;align-items:center;padding:7px 4px;cursor:pointer;font-size:15px',
        },
        [
          el('input', {
            type: 'radio',
            name: 'profile',
            value: name,
            ...(name === active ? { checked: true } : {}),
            onchange: () => switchTo(name),
          }),
          name,
        ]
      )
    )
  );

  const input = el('input', {
    type: 'text',
    placeholder: 'new-profile-name',
    style:
      'flex:1;padding:8px 10px;border:1px solid var(--color-border);border-radius:6px;font-size:14px',
  });
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
          try {
            addLocalProfile(name);
          } catch (err) {
            toast(err.message, { error: true });
            return;
          }
          switchTo(name);
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
      el(
        'p',
        { style: 'font-size:12px;margin-top:12px' },
        'Each profile keeps its own progress, stats, and settings.'
      ),
    ]),
  });

  function switchTo(name) {
    addLocalProfile(name);
    setActiveUser(name);
    close();
    location.reload();
  }
}
