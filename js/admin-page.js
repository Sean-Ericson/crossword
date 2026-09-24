/*
 * admin-page.js — account management for admins (admin.html): reset
 * someone's password and add accounts, from anywhere. The server enforces
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

  async function render() {
    const { users } = await api.get('admin/users');
    const tbody = qs('#user-table tbody');
    tbody.textContent = '';
    for (const u of users) {
      const self = u.name === me.name;
      tbody.append(
        el('tr', {}, [
          el('td', {}, [
            el('span', { class: 'user-dot', style: `background:${u.color};margin-right:6px` }),
            u.name,
            u.is_admin ? el('span', { class: 'tag' }, 'admin') : null,
          ]),
          el('td', {}, u.display_name),
          el('td', {}, u.created_at ? new Date(u.created_at).toLocaleDateString() : ''),
          el(
            'td',
            {},
            self
              ? el('span', { style: 'font-size:12px;color:var(--color-text-muted)' }, 'you — use your account menu')
              : el('button', { class: 'btn', onclick: () => resetFor(u) }, 'Reset password')
          ),
        ])
      );
    }
  }

  function resetFor(u) {
    const input = el('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'leave blank for a temporary password',
      style: inputStyle,
    });
    const error = el('div', { style: 'color:#b3261e;font-size:13px;min-height:18px;margin-top:6px' });
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
