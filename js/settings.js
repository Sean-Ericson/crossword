/* settings.js — per-profile solver settings (local-only, not synced). */

export const DEFAULT_SETTINGS = {
  skipFilled: true, // skip over filled squares while typing
  jumpBack: false, // at word end, jump back to the first blank in the word
  showTimer: true,
  playSound: false, // completion jingle (off by default)
};

export function settingsKey(user) {
  return `xw:${user}:settings`;
}

export function loadSettings(user) {
  try {
    const raw = localStorage.getItem(settingsKey(user));
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(user, settings) {
  try {
    localStorage.setItem(settingsKey(user), JSON.stringify(settings));
  } catch {
    /* private mode: session-only settings */
  }
}

export const SETTING_LABELS = [
  ['skipFilled', 'Skip over filled squares'],
  ['jumpBack', 'At the end of a word, jump back to the first blank'],
  ['showTimer', 'Show timer'],
  ['playSound', 'Play sound on solve'],
];
