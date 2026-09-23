/*
 * profiles.js — who is signed in. Identity comes from the server session
 * (GET /api/me); every page calls loadMe() before doing anything else.
 *
 * The old device-local profile list (from the GitHub-sync days) is still
 * readable so its progress can be imported into an account.
 */

import { api } from './api.js';

const LEGACY_LIST_KEY = 'xw:site:profiles';
const LEGACY_ACTIVE_KEY = 'xw:site:profile';

let me = null;

/** @returns {Promise<{name, display_name, color, is_admin}>} */
export async function loadMe() {
  const { user } = await api.get('me');
  me = user;
  return user;
}

export function currentUser() {
  return me;
}

/** Name of the signed-in user (after loadMe()). */
export function getActiveUser() {
  return me?.name ?? 'guest';
}

/** Profile names this browser used before accounts existed. */
export function getLegacyProfiles() {
  const names = new Set(['guest']);
  try {
    const list = JSON.parse(localStorage.getItem(LEGACY_LIST_KEY) || '[]');
    if (Array.isArray(list)) list.forEach((n) => names.add(n));
    const active = localStorage.getItem(LEGACY_ACTIVE_KEY);
    if (active) names.add(active);
  } catch {
    /* no storage */
  }
  return [...names].sort();
}
