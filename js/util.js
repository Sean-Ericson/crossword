/* util.js — small shared helpers (no DOM assumptions except el/qs). */

export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** 512 -> "8:32"; 3725 -> "1:02:05" */
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function isoNow() {
  return new Date().toISOString();
}

/** "2026-07-21" if the id is a plain daily date id, else null. */
export function dateFromId(id) {
  return /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null;
}

export const PUZZLE_TYPE_LABELS = {
  daily: 'The Crossword',
  mini: 'The Mini',
  midi: 'The Midi',
  bonus: 'Bonus',
  special: 'Special',
};

/**
 * Strip the synthesized "NY Times, Weekday, Month D, YYYY" prefix that
 * nytxw_puz bakes into .puz titles, leaving just the theme title (if any).
 */
export function themeTitle(title) {
  return (title || '').replace(/^NY Times,\s+\w+,\s+\w+\s+\d+,\s+\d{4}\s*/, '').trim();
}

/**
 * Classify a puzzle id:
 *   "2026-07-21"        -> {type:'daily', date:'2026-07-21'}
 *   "mini-2026-07-21"   -> {type:'mini',  date:'2026-07-21'}   (also midi)
 *   "bonus-2026-07-01"  -> {type:'bonus', date:'2026-07-01'}   (monthly)
 *   anything else       -> {type:'special', date:null}
 */
export function parsePuzzleId(id) {
  let m = /^(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (m) return { type: 'daily', date: m[1] };
  m = /^(mini|midi|bonus)-(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (m) return { type: m[1], date: m[2] };
  return { type: 'special', date: null };
}

/** UTC-safe weekday (0=Sunday) for a "YYYY-MM-DD" string. */
export function weekdayOf(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

/** "Monday, July 21, 2026" */
export function formatDateLong(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** UTF-8-safe base64 encode (btoa alone throws on non-Latin-1). */
export function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** UTF-8-safe base64 decode; tolerates newlines in the input (GitHub API). */
export function b64DecodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** base64 -> ArrayBuffer, for binary payloads (a .puz handed over inline). */
export function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.flush = (...args) => {
    if (t !== null) {
      clearTimeout(t);
      t = null;
      fn(...args);
    }
  };
  wrapped.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  return wrapped;
}

/** Tiny DOM builder: el('div', {class:'x', onclick:fn}, ['text', child]) */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
