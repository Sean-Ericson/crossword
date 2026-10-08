/*
 * word-lists.js — people's own word lists in the browser, for the builder's
 * Fill tab (which lists count, and a dialog to score or hide one word) and
 * the Word lists page (wordlists.html, js/wordlists-page.js).
 *
 * The server keeps the lists (/api/word-lists in server/api.mjs) and uses
 * them for /api/words: in the lists that are on, a word's score replaces
 * the site's, and 0 hides it. Each person's lists are theirs alone.
 */

import { el } from './util.js';
import { api } from './api.js';
import { showModal, toast } from './modals.js';
import { listNames } from './people.js';

export const MAX_FILE_BYTES = 30_000_000;
const LAST_LIST_KEY = 'xw:word-list';

/** A list file's text: UTF-8, or Windows-1252 for older files that aren't. */
export async function readListFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`That file is ${Math.round(file.size / 1e6)} MB; the most is ${MAX_FILE_BYTES / 1e6} MB.`);
  }
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** "My words" from "my words.txt" */
export function nameFromFile(file) {
  return file.name.replace(/\.[^.]*$/, '').replace(/[_]+/g, ' ').trim().slice(0, 60) || 'My words';
}

export const formatCount = (n) => n.toLocaleString('en-US');

/** What suggestions draw on: "the site’s list and My words"; null when nothing is on. */
export function describeLists({ use_site, lists }) {
  const names = lists.filter((l) => l.enabled).map((l) => `“${l.name}”`);
  const parts = use_site ? ['the site’s list', ...names] : names;
  return parts.length ? listNames(parts, 3) : null;
}

/** "added 3 words, rescored 1 (2 lines weren’t words)" */
export function describeEdit({ added = 0, updated = 0, removed = 0, skipped = 0 }) {
  const plural = (n, one, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;
  const bits = [];
  if (added) bits.push(`added ${plural(added, 'word')}`);
  if (updated) bits.push(`rescored ${formatCount(updated)}`);
  if (removed) bits.push(`removed ${formatCount(removed)}`);
  let text = bits.length ? bits.join(', ') : 'nothing changed';
  if (skipped) text += ` (${plural(skipped, 'line wasn’t a word', 'lines weren’t words')})`;
  return text[0].toUpperCase() + text.slice(1) + '.';
}

function rememberList(id) {
  try {
    localStorage.setItem(LAST_LIST_KEY, String(id));
  } catch {
    /* private mode: no memory, no harm */
  }
}

function lastList() {
  try {
    return Number(localStorage.getItem(LAST_LIST_KEY)) || null;
  } catch {
    return null;
  }
}

/** Where a word's score in your suggestions comes from, in a sentence. */
function sourceOf(look) {
  const on = look.lists.filter((l) => l.enabled);
  const hider = on.find((l) => l.score === 0);
  if (hider) return `Your suggestions leave it out: “${hider.name}” scores it 0.`;
  if (on.length) {
    const best = on.reduce((a, b) => (b.score > a.score ? b : a));
    return `Your suggestions score it ${best.score}, from “${best.name}”.`;
  }
  if (look.use_site && look.site != null) return `Your suggestions score it ${look.site}, from the site’s list.`;
  return 'It isn’t in any list your suggestions use.';
}

/**
 * Score or hide one word in one of your lists (a first list, “My words”,
 * is made if you have none). onSaved runs after a change.
 */
export async function openWordDialog(word, { onSaved } = {}) {
  let look;
  let lists;
  try {
    [look, { lists }] = await Promise.all([api.get(`word-lists/lookup?word=${encodeURIComponent(word)}`), api.get('word-lists')]);
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  const scoreIn = (id) => look.lists.find((l) => l.id === id)?.score;
  const select = el(
    'select',
    { class: 'wd-list', 'aria-label': 'Word list' },
    lists.length
      ? lists.map((l) => el('option', { value: String(l.id) }, l.enabled ? l.name : `${l.name} (off)`))
      : [el('option', { value: 'new' }, 'My words (a new list)')]
  );
  const preferred = look.lists.find((l) => l.enabled) ?? lists.find((l) => l.id === lastList()) ?? lists[0];
  if (preferred) select.value = String(preferred.id);
  const score = el('input', { class: 'wd-score', type: 'number', min: '0', max: '100', step: '1', 'aria-label': 'Score' });
  const offNote = el('p', { class: 'wd-note' });
  const sync = () => {
    const id = Number(select.value);
    score.value = String(scoreIn(id) ?? look.score ?? 50);
    const list = lists.find((l) => l.id === id);
    offNote.textContent = list && !list.enabled ? 'This list is off, so it won’t change your suggestions until you turn it on.' : '';
  };
  select.addEventListener('change', sync);
  sync();

  const save = async (value) => {
    const s = String(value).trim() === '' ? NaN : Math.min(100, Math.max(0, Math.round(Number(value))));
    if (!Number.isFinite(s)) {
      toast('A score is a number from 0 to 100.', { error: true });
      return false;
    }
    try {
      let id = Number(select.value);
      if (select.value === 'new') {
        id = (await api.post('word-lists', { name: 'My words', set: [[look.word, s]] })).list.id;
      } else {
        await api.post(`word-lists/${id}/words`, { set: [[look.word, s]] });
      }
      rememberList(id);
      const name = select.selectedOptions[0].textContent.replace(/ \((off|a new list)\)$/, '');
      toast(s === 0 ? `${look.word} is hidden (score 0 in “${name}”).` : `${look.word} scores ${s} in “${name}”.`);
      onSaved?.();
      return true;
    } catch (err) {
      toast(err.message, { error: true });
      return false;
    }
  };

  const close = showModal({
    title: look.word,
    body: [
      el('p', { class: 'wd-now' }, sourceOf(look)),
      el('div', { class: 'wd-row' }, [
        el('label', { class: 'wd-field' }, ['Score ', score]),
        el('label', { class: 'wd-field' }, ['in ', select]),
      ]),
      el('p', { class: 'wd-hint' }, '0 to 100; higher comes first. 0 hides the word from your suggestions.'),
      offNote,
      el('p', { class: 'wd-hint' }, [el('a', { href: './wordlists.html', target: '_blank' }, 'All your word lists')]),
    ],
    actions: [
      { label: 'Cancel' },
      { label: 'Hide it', keepOpen: true, onClick: async () => (await save(0)) && close() },
      { label: 'Save', primary: true, keepOpen: true, onClick: async () => (await save(score.value)) && close() },
    ],
  });
  score.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save(score.value).then((ok) => ok && close());
    }
  });
  score.focus();
  score.select();
}
