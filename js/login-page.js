/*
 * login-page.js — sign-in form. Accounts are made by the site admin
 * (server/admin.mjs); there's no sign-up.
 */

import { api } from './api.js';
import { qs } from './util.js';

/** Only ever bounce back to a page on this site. */
function nextUrl() {
  const next = new URLSearchParams(location.search).get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

async function main() {
  // already signed in? skip the form
  const { user } = await api.get('me?optional=1').catch(() => ({ user: null }));
  if (user) {
    location.replace(nextUrl());
    return;
  }

  const form = qs('#login-form');
  const error = qs('#login-error');
  qs('#login-name').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api.post(
        'login',
        {
          name: qs('#login-name').value.trim().toLowerCase(),
          password: qs('#login-password').value,
        },
        { redirectOn401: false }
      );
      location.replace(nextUrl());
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}

main();
