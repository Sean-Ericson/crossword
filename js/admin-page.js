/*
 * admin-page.js — account management for admins (admin.html): add and
 * delete accounts, reset passwords and grant or remove admin, from
 * anywhere. Nobody can change their own account here. The server enforces
 * the admin check; this page just hides itself for everyone else.
 */

import { el, qs } from './util.js';
import { api } from './api.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { showModal, toast } from './modals.js';

const inputStyle =
  'width:100%;padding:8px 10px;border:1px solid var(--color-border);border-radius:6px;font-size:15px;box-sizing:border-box;margin-top:4px';

async function main() {
  const me = await loadMe();
  initProfileChip(qs('#profile-chip'));
  const note = qs('#admin-note');
  if (!me.is_admin) {
    note.textContent = 'Only admins can manage accounts.';
    return;
  }
  note.textContent =
    'Resetting a password signs that person out on every device. Send them the new one privately.';
  qs('#user-table').hidden = false;
  qs('#add-section').hidden = false;

  // A long list gets a filter box, a count, and a shortcut to the add form
  // (which is below everyone).
  const FILTER_ABOVE = 8;
  const filter = qs('#user-filter');
  filter.addEventListener('input', () => applyFilter());
  qs('#jump-add').addEventListener('click', (e) => {
    e.preventDefault();
    qs('#add-section').scrollIntoView({ behavior: 'smooth' });
    qs('#add-form [name=name]').focus({ preventScroll: true });
  });

  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    const rows = [...qs('#user-table tbody').rows];
    let shown = 0;
    for (const tr of rows) {
      tr.hidden = !!q && !tr.dataset.search.includes(q);
      if (!tr.hidden) shown++;
    }
    qs('#user-count').textContent = q ? `${shown} of ${rows.length}` : `${rows.length} accounts`;
    qs('#no-match').hidden = shown > 0;
  }

  async function render() {
    const { users } = await api.get('admin/users');
    const tbody = qs('#user-table tbody');
    tbody.textContent = '';
    for (const u of users) {
      const self = u.name === me.name;
      tbody.append(
        el('tr', { dataset: { search: `${u.name} ${u.display_name}`.toLowerCase() } }, [
          el('td', {}, el('div', { class: 'acct' }, [
            el('span', { class: 'user-dot', style: `background:${u.color}` }),
            el('span', { class: 'acct-names' }, [
              el('span', { class: 'acct-display' }, u.display_name),
              // the sign-in name, unless it's just the display name in lowercase
              u.display_name.toLowerCase() !== u.name ? el('span', { class: 'acct-login' }, u.name) : null,
            ]),
            u.is_admin ? el('span', { class: 'tag' }, 'admin') : null,
          ])),
          el('td', { class: 'since' }, u.created_at ? new Date(u.created_at).toLocaleDateString() : ''),
          el(
            'td',
            {},
            self
              ? el('span', { style: 'font-size:12px;color:var(--color-text-muted)' }, 'you — use your account menu')
              : el('div', { class: 'row-actions' }, [
                  el('button', { class: 'btn', onclick: () => resetFor(u) }, 'Reset password'),
                  el(
                    'button',
                    { class: 'btn', onclick: () => setAdmin(u, !u.is_admin) },
                    u.is_admin ? 'Remove admin' : 'Make admin'
                  ),
                  el('button', { class: 'btn btn-danger', onclick: () => deleteUser(u) }, 'Delete'),
                ])
          ),
        ])
      );
    }
    const tools = qs('#admin-tools');
    tools.hidden = users.length <= FILTER_ABOVE;
    if (tools.hidden) filter.value = '';
    applyFilter(); // the list is rebuilt after every change; keep the filter
  }

  function setAdmin(u, on) {
    showModal({
      title: on ? `Make ${u.display_name} an admin?` : `Remove ${u.display_name} as admin?`,
      body: on
        ? 'They’ll be able to add, reset, delete and promote accounts, including yours.'
        : 'They’ll no longer be able to manage accounts.',
      actions: [
        { label: 'Cancel' },
        {
          label: on ? 'Make admin' : 'Remove admin',
          primary: true,
          onClick: async () => {
            try {
              await api.post(`admin/users/${encodeURIComponent(u.name)}/admin`, { is_admin: on });
              toast(on ? `${u.name} is now an admin.` : `${u.name} is no longer an admin.`);
              await render();
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
      ],
    });
  }

  function deleteUser(u) {
    const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', style: inputStyle });
    const error = el('div', { style: 'color:var(--color-error);font-size:13px;min-height:18px;margin-top:6px' });
    showModal({
      title: `Delete ${u.display_name}’s account?`,
      body: el('div', { style: 'text-align:left' }, [
        el(
          'p',
          { style: 'margin:0 0 10px' },
          'This signs them out and permanently deletes their account, solo progress and stats. ' +
            'Co-op solves stay for the other people in them. This can’t be undone.'
        ),
        el('label', { style: 'display:block;font-size:13px;font-weight:600' }, [`Type “${u.name}” to confirm`, input]),
        error,
      ]),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Delete account',
          primary: true,
          keepOpen: true,
          onClick: async (e) => {
            if (input.value.trim().toLowerCase() !== u.name) {
              error.textContent = `Type “${u.name}” exactly.`;
              return;
            }
            try {
              await api.del(`admin/users/${encodeURIComponent(u.name)}`);
              e.target.closest('.overlay')?.remove();
              toast(`Deleted ${u.name}.`);
              await render();
            } catch (err) {
              error.textContent = err.message;
            }
          },
        },
      ],
    });
    input.focus();
  }

  function resetFor(u) {
    const input = el('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'leave blank for a temporary password',
      style: inputStyle,
    });
    const error = el('div', { style: 'color:var(--color-error);font-size:13px;min-height:18px;margin-top:6px' });
    showModal({
      title: `Reset ${u.display_name}’s password`,
      body: el('div', { style: 'text-align:left' }, [
        el('label', { style: 'display:block;font-size:13px;font-weight:600' }, ['New password (8+ characters)', input]),
        error,
      ]),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Reset password',
          primary: true,
          keepOpen: true,
          onClick: async (e) => {
            try {
              const result = await api.post(`admin/users/${encodeURIComponent(u.name)}/password`, {
                password: input.value,
              });
              e.target.closest('.overlay')?.remove();
              showPassword(u.name, result.password ?? input.value, !!result.password);
            } catch (err) {
              error.textContent = err.message;
            }
          },
        },
      ],
    });
    input.focus();
  }

  function showPassword(name, password, generated) {
    const box = el('div', { class: 'new-password' }, password);
    showModal({
      title: generated ? `New password for ${name}` : `Password set for ${name}`,
      body: el('div', { style: 'text-align:left' }, [
        el('p', { style: 'margin:0' }, `They sign in with the name “${name}” and:`),
        box,
        el(
          'p',
          { style: 'font-size:13px;color:var(--color-text-muted);margin:0' },
          'This is the only time it’s shown. They can change it from their account menu after signing in.'
        ),
      ]),
      actions: [
        {
          label: 'Copy',
          keepOpen: true,
          onClick: () =>
            navigator.clipboard
              ?.writeText(password)
              .then(() => toast('Copied.'))
              .catch(() => toast('Couldn’t copy — select it instead.', { error: true })),
        },
        { label: 'Done', primary: true },
      ],
    });
  }

  qs('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {
      name: form.name.value.trim().toLowerCase(),
      display_name: form.display_name.value.trim(),
      password: form.password.value,
      is_admin: form.is_admin.checked,
    };
    try {
      const result = await api.post('admin/users', data);
      form.reset();
      await render();
      showPassword(data.name, result.password ?? data.password, !!result.password);
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  await render();
}

main();
