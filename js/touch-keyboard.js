/*
 * touch-keyboard.js — on-screen keyboard for phones and tablets. The grid
 * is plain divs, so tapping a square never raises the system keyboard;
 * this stands in for it, NYT-app style. Keys report the same names as
 * KeyboardEvent.key ('A', 'Backspace', 'Escape' for rebus) so the page
 * routes them through its normal key handler.
 */

import { el } from './util.js';

const ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  [{ key: 'Escape', label: 'Rebus', wide: true }, 'Z', 'X', 'C', 'V', 'B', 'N', 'M', { key: 'Backspace', label: '⌫', wide: true, repeat: true }],
];

/** True on devices whose main input is a finger (phones, tablets). */
export const isTouchDevice = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

export class TouchKeyboard {
  /**
   * @param {HTMLElement} host   gets the keys appended
   * @param {{onKey: (key: string) => void}} opts
   */
  constructor(host, { onKey }) {
    this.el = el('div', { class: 'touch-kb', role: 'group', 'aria-label': 'Keyboard' });
    for (const row of ROWS) {
      const rowEl = el('div', { class: 'touch-kb-row' });
      for (const spec of row) {
        const { key, label = key, wide, repeat } = typeof spec === 'string' ? { key: spec } : spec;
        const btn = el('button', { class: 'touch-kb-key' + (wide ? ' wide' : ''), type: 'button', tabindex: '-1' }, label);
        this.bind(btn, () => onKey(key), repeat);
        rowEl.append(btn);
      }
      this.el.append(rowEl);
    }
    host.append(this.el);
  }

  /** Fire on press, not release (typing feels laggy otherwise); hold to repeat. */
  bind(btn, fire, repeat) {
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      timer = null;
      btn.classList.remove('down');
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // no focus change, no double-tap zoom
      btn.classList.add('down');
      fire();
      if (repeat) {
        const again = (delay) => {
          timer = setTimeout(() => {
            fire();
            again(70);
          }, delay);
        };
        again(400);
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(type, stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menu
  }
}
