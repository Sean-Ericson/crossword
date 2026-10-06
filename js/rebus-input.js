/*
 * rebus-input.js — the box for typing several letters into one square (a
 * rebus), shown over that square. Enter or clicking away commits; Esc
 * cancels. Used by the player and the builder.
 */

import { el } from './util.js';

/**
 * @param {{rect: DOMRect, value?: string, onCommit: (value: string) => void,
 *          onClose?: () => void}} opts  rect: the square's viewport rect
 */
export function openRebusInput({ rect, value = '', onCommit, onClose }) {
  const input = el('input', {
    class: 'rebus-input',
    type: 'text',
    maxlength: '12',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'aria-label': 'Rebus entry',
  });
  const width = Math.max(rect.width * 1.8, 96);
  Object.assign(input.style, {
    left: `${rect.left + rect.width / 2 - width / 2}px`,
    top: `${rect.top - 2}px`,
    width: `${width}px`,
    height: `${rect.height + 4}px`,
    fontSize: `${rect.height * 0.55}px`,
  });
  input.value = value;
  let open = true;
  let cancelled = false;
  const close = (commit) => {
    if (!open) return;
    open = false;
    const text = input.value;
    input.remove();
    onClose?.();
    if (commit) onCommit(text);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      close(false);
    }
  });
  input.addEventListener('blur', () => close(!cancelled));
  document.body.append(input);
  input.focus();
  input.select();
}
