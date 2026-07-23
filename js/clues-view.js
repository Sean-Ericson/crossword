/*
 * clues-view.js — Across/Down clue lists and the current-clue bar.
 */

import { el } from './util.js';

export class CluesView {
  /**
   * @param {{
   *   acrossEl: HTMLElement, downEl: HTMLElement,
   *   barEl: HTMLElement, model: import('./model.js').PuzzleModel,
   *   onSelectWord: (word: object) => void,
   *   onBarNav: (delta: number) => void,
   * }} opts
   */
  constructor({ acrossEl, downEl, barEl, model, onSelectWord, onBarNav }) {
    this.model = model;
    this.itemsByWordId = new Map();
    this.active = null;
    this.cross = null;

    const buildList = (host, title, words) => {
      const ol = el('ol', { class: 'clue-items' });
      for (const word of words) {
        const li = el(
          'li',
          {
            class: 'clue-item',
            dataset: { wordId: word.id },
            onmousedown: (e) => {
              e.preventDefault();
              onSelectWord(word);
            },
          },
          [
            el('span', { class: 'clue-item-num' }, String(word.num)),
            el('span', { class: 'clue-item-text' }, word.clueText),
          ]
        );
        this.itemsByWordId.set(word.id, li);
        ol.append(li);
      }
      host.append(el('h3', { class: 'clue-list-title' }, title), ol);
    };

    buildList(acrossEl, 'Across', model.words.A);
    buildList(downEl, 'Down', model.words.D);

    // current-clue bar: ‹ [num+dir  text] ›
    this.barNum = el('span', { class: 'clue-bar-num' });
    this.barText = el('span', { class: 'clue-bar-text' });
    barEl.append(
      el(
        'button',
        { class: 'clue-bar-nav', 'aria-label': 'Previous clue', onclick: () => onBarNav(-1) },
        '‹'
      ),
      el('div', { class: 'clue-bar-main' }, [this.barNum, this.barText]),
      el(
        'button',
        { class: 'clue-bar-nav', 'aria-label': 'Next clue', onclick: () => onBarNav(1) },
        '›'
      )
    );
  }

  setActive(word, crossWord) {
    if (this.active) this.active.classList.remove('active');
    if (this.cross) this.cross.classList.remove('cross');
    this.active = word ? this.itemsByWordId.get(word.id) : null;
    this.cross = crossWord ? this.itemsByWordId.get(crossWord.id) : null;
    if (this.active) {
      this.active.classList.add('active');
      this.scrollTo(this.active);
    }
    if (this.cross) {
      this.cross.classList.add('cross');
      this.scrollTo(this.cross);
    }
    if (word) {
      this.barNum.textContent = `${word.num}${word.dir === 'A' ? 'A' : 'D'}`;
      this.barText.textContent = word.clueText;
    }
  }

  scrollTo(li) {
    const list = li.closest('.clue-items');
    if (!list) return;
    const top = li.offsetTop - list.offsetTop;
    const bottom = top + li.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top - 4;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight + 4;
    }
  }

  /** Gray out clues whose words are completely filled (NYT style). */
  updateFilled(record) {
    for (const word of this.model.clueOrder) {
      const filled = word.cells.every((i) => record.fill[i] !== '');
      this.itemsByWordId.get(word.id).classList.toggle('filled', filled);
    }
  }
}
