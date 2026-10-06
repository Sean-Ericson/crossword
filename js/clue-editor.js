/*
 * clue-editor.js — the builder's Across and Down lists: each entry's
 * number, a box for its clue, its answer so far, and (with word lists on
 * the server) how many words fit it. Rows are keyed by entry ('A0' is the
 * across entry starting at square 0), so when blocks change, a box keeps
 * its text, focus and caret; the other rows move around it.
 */

import { el } from './util.js';
import { clueKey, LIMITS } from './custom-puzzle.js';

export class ClueEditor {
  /**
   * @param {{
   *   acrossEl: HTMLElement, downEl: HTMLElement,
   *   onSelect: (word: object) => void,           a row was clicked or its box focused
   *   onInput: (key: string, text: string) => void,
   *   onFocus: (key: string|null) => void,        typing in a box starts / stops
   *   onKey: (e: KeyboardEvent, word: object) => void,
   * }} opts
   */
  constructor({ acrossEl, downEl, onSelect, onInput, onFocus, onKey }) {
    this.opts = { onSelect, onInput, onFocus, onKey };
    this.lists = { A: this.list(acrossEl, 'Across'), D: this.list(downEl, 'Down') };
    this.rows = new Map(); // key -> row
    this.active = null;
    this.cross = null;
    this.dots = [];
  }

  list(host, title) {
    host.textContent = '';
    const ol = el('ol', { class: 'clue-items' });
    host.append(el('h3', { class: 'clue-list-title' }, title), ol);
    return ol;
  }

  /** A new numbering (the shape changed, or the first snapshot). */
  setModel(model, doc) {
    const old = this.rows;
    this.rows = new Map();
    for (const dir of ['A', 'D']) {
      const ordered = model.words[dir].map((word) => {
        const key = clueKey(word);
        const row = old.get(key) ?? this.row(key);
        row.word = word;
        row.num.textContent = String(word.num);
        row.input.setAttribute('aria-label', `${word.num} ${dir === 'A' ? 'Across' : 'Down'} clue`);
        if (document.activeElement !== row.input) row.input.value = doc.clues[key] ?? '';
        this.rows.set(key, row);
        return row;
      });
      // re-order without moving the row being typed in (moving a node blurs it)
      const ol = this.lists[dir];
      const focused = ordered.find((r) => r.li.contains(document.activeElement));
      for (const child of [...ol.children]) if (child !== focused?.li) child.remove();
      if (!focused) {
        ol.append(...ordered.map((r) => r.li));
      } else {
        const at = ordered.indexOf(focused);
        for (const r of ordered.slice(0, at)) ol.insertBefore(r.li, focused.li);
        ol.append(...ordered.slice(at + 1).map((r) => r.li));
      }
    }
    this.updateAnswers(doc);
  }

  row(key) {
    const num = el('span', { class: 'clue-item-num' });
    const input = el('input', {
      class: 'clue-input',
      type: 'text',
      maxlength: String(LIMITS.clue),
      placeholder: 'Write a clue',
      spellcheck: 'true',
      autocomplete: 'off',
    });
    const answer = el('span', { class: 'clue-answer' });
    const count = el('span', { class: 'clue-count' });
    const dots = el('span', { class: 'clue-remotes' });
    const li = el('li', { class: 'clue-item builder-clue', dataset: { key } }, [
      num,
      el('div', { class: 'clue-body' }, [input, el('div', { class: 'clue-sub' }, [answer, count])]),
      dots,
    ]);
    const row = { key, li, num, input, answer, count, dots, word: null };
    li.addEventListener('mousedown', (e) => {
      if (e.target === input) return;
      e.preventDefault(); // the grid keeps the keyboard...
      if (document.activeElement?.matches?.('input, textarea')) document.activeElement.blur(); // ...even from a clue box
      this.opts.onSelect(row.word);
    });
    input.addEventListener('focus', () => {
      this.opts.onSelect(row.word);
      this.opts.onFocus(key);
    });
    input.addEventListener('blur', () => this.opts.onFocus(null));
    input.addEventListener('input', () => this.opts.onInput(key, input.value));
    input.addEventListener('keydown', (e) => this.opts.onKey(e, row.word));
    return row;
  }

  /** Each row's answer so far: letters, '·' for blanks, (REBUS) squares. */
  updateAnswers(doc) {
    for (const row of this.rows.values()) {
      const parts = row.word.cells.map((i) => doc.grid[i] || '·');
      row.answer.textContent = parts.map((p) => (p.length > 1 ? `(${p})` : p)).join('');
      row.li.classList.toggle('unclued', !(doc.clues[row.key] ?? '').trim());
    }
  }

  /** A clue changed elsewhere (a co-author, or the clue bar). */
  updateClue(key, text) {
    const input = this.rows.get(key)?.input;
    if (!input || input.value === text) return;
    if (document.activeElement === input) {
      const { selectionStart: a, selectionEnd: b } = input;
      input.value = text;
      input.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
    } else {
      input.value = text;
    }
  }

  /** Mark rows by clue text without touching answers. */
  markClued(doc) {
    for (const row of this.rows.values()) row.li.classList.toggle('unclued', !(doc.clues[row.key] ?? '').trim());
  }

  setActive(word, crossWord) {
    this.active?.li.classList.remove('active');
    this.cross?.li.classList.remove('cross');
    this.active = word ? this.rows.get(clueKey(word)) ?? null : null;
    this.cross = crossWord ? this.rows.get(clueKey(crossWord)) ?? null : null;
    this.active?.li.classList.add('active');
    this.cross?.li.classList.add('cross');
    if (this.active) this.reveal(this.active.li);
  }

  /** Scroll a row into view inside its panel (scrollIntoView would move the page too). */
  reveal(li) {
    const panel = li.closest('.side-panel');
    if (!panel || panel.hidden) return;
    const top = li.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    const bottom = top + li.offsetHeight;
    if (top < panel.scrollTop) panel.scrollTop = top - 4;
    else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight + 4;
  }

  focus(key) {
    const input = this.rows.get(key)?.input;
    input?.focus();
    input?.select();
  }

  /** How many words fit each entry (null clears them). @param {Map<string, number>|null} counts */
  setCounts(counts) {
    for (const row of this.rows.values()) {
      const n = counts?.get(row.key);
      row.count.textContent = n == null ? '' : n === 0 ? 'nothing fits' : `${n >= 1000 ? '1000+' : n} fit${n === 1 ? 's' : ''}`;
      row.count.classList.toggle('none', n === 0);
    }
  }

  /** Co-authors typing a clue: a colored dot on its row. @param {Array<{key, color, label}>} markers */
  setRemoteMarkers(markers) {
    for (const row of this.rows.values()) row.dots.textContent = '';
    for (const m of markers) {
      const row = this.rows.get(m.key);
      if (row) row.dots.append(el('span', { class: 'clue-remote', style: `background:${m.color}`, title: `${m.label} is writing this clue` }));
    }
  }
}
