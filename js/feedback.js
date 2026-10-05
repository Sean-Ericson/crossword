/*
 * feedback.js — what solvers think of a custom puzzle: stars and a note
 * for its constructors (POST /api/custom-puzzles/:id/feedback), and the
 * list of what everyone said (GET). The player offers the form after a
 * solve; the breakdown page shows the list to the authors and to people
 * who finished it (notes can give answers away).
 */

import { el } from './util.js';
import { api } from './api.js';
import { toast } from './modals.js';

/** GET the puzzle's feedback; null if it can't be had. */
export async function loadFeedback(puzzleId) {
  try {
    return await api.get(`custom-puzzles/${encodeURIComponent(puzzleId)}/feedback`);
  } catch {
    return null;
  }
}

/**
 * Stars and a note box with a Send button.
 * @param {string} puzzleId
 * @param {{byline?: string, existing?: {stars:number|null, comment:string}|null, onSaved?: Function}} opts
 */
export function feedbackForm(puzzleId, { byline = '', existing = null, onSaved = null } = {}) {
  let stars = existing?.stars ?? null;
  let saved = !!existing;
  const send = el('button', { class: 'btn', type: 'button' }, existing ? 'Saved' : 'Send');
  const dirty = () => {
    send.disabled = false;
    send.textContent = saved ? 'Update' : 'Send';
  };
  const starButtons = [1, 2, 3, 4, 5].map((n) =>
    el(
      'button',
      {
        type: 'button',
        class: 'star-btn',
        'aria-label': `${n} star${n === 1 ? '' : 's'}`,
        onclick: () => {
          stars = stars === n ? null : n; // clicking your rating again clears it
          drawStars();
          dirty();
        },
      },
      '★'
    )
  );
  const drawStars = () =>
    starButtons.forEach((b, k) => {
      b.classList.toggle('on', stars != null && k < stars);
      b.setAttribute('aria-pressed', String(stars === k + 1));
    });
  drawStars();
  const note = el('textarea', {
    class: 'feedback-note',
    rows: '2',
    maxlength: '1000',
    placeholder: byline ? `A note for ${byline} (optional)` : 'A note for the constructors (optional)',
    oninput: dirty,
  });
  note.value = existing?.comment ?? '';
  send.disabled = !!existing;
  send.addEventListener('click', async () => {
    if (stars == null && !note.value.trim()) {
      toast('Pick some stars or write a note first.', { error: true });
      return;
    }
    send.disabled = true;
    try {
      await api.post(`custom-puzzles/${encodeURIComponent(puzzleId)}/feedback`, { stars, comment: note.value });
      saved = true;
      send.textContent = 'Saved';
      toast(byline ? `Thanks! ${byline} will see it.` : 'Thanks!');
      onSaved?.();
    } catch (err) {
      send.disabled = false;
      toast(err.message, { error: true });
    }
  });
  return el('div', { class: 'feedback-form' }, [
    el('div', { class: 'feedback-title' }, 'How was it?'),
    el('div', { class: 'stars', role: 'group', 'aria-label': 'Your rating' }, starButtons),
    note,
    el('div', { class: 'feedback-actions' }, send),
  ]);
}

/** "★ 4.3 from 6 solvers" */
export const starsText = (s) => (s ? `★ ${s.avg.toFixed(1)} from ${s.n} rating${s.n === 1 ? '' : 's'}` : 'No ratings yet');

/**
 * The notes people left, newest first.
 * @param {Array<{user, display_name, stars, comment, updated_at}>} notes
 */
export function feedbackNotes(notes) {
  if (!notes?.length) return el('p', { class: 'feedback-empty' }, 'No notes yet.');
  return el(
    'ul',
    { class: 'feedback-notes' },
    notes.map((f) =>
      el('li', {}, [
        el('div', { class: 'feedback-who' }, [
          el('b', {}, f.display_name || f.user),
          f.stars ? el('span', { class: 'feedback-stars', title: `${f.stars} of 5` }, '★'.repeat(f.stars)) : null,
          el('span', { class: 'feedback-when' }, new Date(f.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
        ]),
        el('p', {}, f.comment),
      ])
    )
  );
}
