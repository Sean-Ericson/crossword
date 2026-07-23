/*
 * profiles.js — local profile management. A "profile" is just a name; it
 * scopes localStorage keys and the folder used in the data repo. Remote
 * discovery of other users lives in sync.js.
 */

const ACTIVE_KEY = 'xw:site:profile';
const LIST_KEY = 'xw:site:profiles';

export const PROFILE_NAME_RE = /^[a-z0-9-]{1,24}$/;

export function getActiveUser() {
  try {
    return localStorage.getItem(ACTIVE_KEY) || 'guest';
  } catch {
    return 'guest';
  }
}

export function setActiveUser(name) {
  localStorage.setItem(ACTIVE_KEY, name);
}

export function getLocalProfiles() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addLocalProfile(name) {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error('Names must be 1-24 chars: lowercase letters, digits, hyphens.');
  }
  const list = getLocalProfiles();
  if (!list.includes(name)) {
    list.push(name);
    list.sort();
    localStorage.setItem(LIST_KEY, JSON.stringify(list));
  }
  return list;
}

export function removeLocalProfile(name) {
  const list = getLocalProfiles().filter((n) => n !== name);
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
  if (getActiveUser() === name) setActiveUser(list[0] || 'guest');
  return list;
}
