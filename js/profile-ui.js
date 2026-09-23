/*
 * profile-ui.js — the header account chip and its menu: change password,
 * import progress saved in this browser before accounts existed, log out.
 */

import { el } from './util.js';
import { showModal, confirmDialog, toast } from './modals.js';
import { api } from './api.js';
import { currentUser, getLegacyProfiles } from './profiles.js';
import {
  localDataSummary,
  listProgressIds,
  loadLocal,
  loadStatsLocal,
  deleteUserData,
} from './state.js';

/** Render the header chip; clicking opens the account menu. */
export function initProfileChip(chipEl) {
  const me = currentUser();
  if (!me) return;
  chipEl.textContent = '';
  chipEl.append(
    el('span', { class: 'user-dot', style: `background:${me.color}` }),
    me.display_name || me.name
  );
  chipEl.style.cursor = 'pointer';
  chipEl.title = 'Account';
  chipEl.addEventListener('click', () => openAccountModal());
}

const inputStyle =
  'width:100%;padding:8px 10px;border:1px solid var(--color-border);border-radius:6px;font-size:14px;box-sizing:border-box';

export function openAccountModal() {
  const me = currentUser();
  const legacy = getLegacyProfiles()
    .map((name) => ({ name, summary: localDataSummary(name) }))
    .filter((p) => p.summary.any);

  const body = el('div', { style: 'text-align:left' }, [
    el('p', { style: 'margin-top:0' }, [
      'Signed in as ',
      el('b', {}, me.display_name || me.name),
      me.display_name && me.display_name !== me.name ? ` (${me.name})` : '',
    ]),
    el('button', { class: 'btn', style: 'margin-right:8px', onclick: () => openPasswordModal() }, 'Change password'),
    el(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          await api.post('logout').catch(() => {});
          location.href = './login.html';
        },
      },
      'Log out'
    ),
    legacy.length ? legacySection(legacy) : null,
  ]);

  const close = showModal({ title: 'Account', body });

  function legacySection(profiles) {
    return el('div', { style: 'margin-top:18px;border-top:1px solid var(--color-border);padding-top:12px' }, [
      el('h3', { style: 'font-size:14px;margin:0 0 6px' }, 'Progress saved in this browser'),
      el(
        'p',
        { style: 'font-size:13px;color:var(--color-text-muted);margin:0 0 8px' },
        'From before accounts. Import it into your account; anything already on the server is kept (the same merge rules as before).'
      ),
      ...profiles.map(({ name, summary }) => {
        const bits = [];
        if (summary.solves) bits.push(`${summary.solves} solved`);
        if (summary.started) bits.push(`${summary.started} in progress`);
        return el('div', { style: 'display:flex;gap:10px;align-items:center;padding:4px 0' }, [
          el('span', { style: 'flex:1' }, [
            el('b', {}, name),
            ` — ${summary.puzzles} puzzle${summary.puzzles === 1 ? '' : 's'}${bits.length ? ` (${bits.join(', ')})` : ''}`,
          ]),
          el('button', { class: 'btn', style: 'font-size:13px;padding:4px 12px', onclick: () => importLegacy(name) }, 'Import'),
        ]);
      }),
    ]);
  }

  async function importLegacy(name) {
    const records = listProgressIds(name)
      .map((id) => loadLocal(name, id))
      .filter(Boolean);
    const stats = loadStatsLocal(name);
    try {
      const result = await api.post('import-local', { records, stats });
      const ok = await confirmDialog(
        `Imported ${result.imported} puzzle${result.imported === 1 ? '' : 's'} and ${result.solves} new solve${
          result.solves === 1 ? '' : 's'
        } into your account${result.skipped ? ` (${result.skipped} skipped)` : ''}. Remove “${name}”’s copy from this browser?`,
        { confirmLabel: 'Remove local copy', title: 'Imported' }
      );
      if (ok) deleteUserData(name);
      close();
      location.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }
}

function openPasswordModal() {
  const current = el('input', { type: 'password', autocomplete: 'current-password', style: inputStyle });
  const next = el('input', { type: 'password', autocomplete: 'new-password', style: inputStyle });
  const again = el('input', { type: 'password', autocomplete: 'new-password', style: inputStyle });
  const error = el('div', { style: 'color:#b3261e;font-size:13px;min-height:18px;margin-top:6px' });
  const row = (label, input) =>
    el('label', { style: 'display:block;margin-bottom:10px;font-size:13px' }, [
      el('div', { style: 'margin-bottom:3px;font-weight:600' }, label),
      input,
    ]);
  showModal({
    title: 'Change password',
    body: el('div', { style: 'text-align:left' }, [
      row('Current password', current),
      row('New password (8+ characters)', next),
      row('New password again', again),
      error,
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Change',
        primary: true,
        keepOpen: true,
        onClick: async (e) => {
          if (next.value !== again.value) {
            error.textContent = 'The new passwords don’t match.';
            return;
          }
          try {
            await api.post('me/password', { current: current.value, next: next.value });
            e.target.closest('.overlay')?.remove();
            toast('Password changed. Other devices were signed out.');
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
    ],
  });
}
