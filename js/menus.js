/*
 * menus.js — dropdown menus on toolbar buttons (the player and the builder).
 */

import { el } from './util.js';

/**
 * Dropdown menu on a toolbar button; items provided lazily each open.
 * An item is 'hr', {label, action, checked?}, or {info: node} for a line
 * of text that isn't clickable.
 */
export function makeMenu(button, getItems) {
  let panel = null;
  const close = () => {
    panel?.remove();
    panel = null;
    document.removeEventListener('mousedown', onOutside, true);
  };
  const onOutside = (e) => {
    if (panel && !panel.contains(e.target) && !button.contains(e.target)) close();
  };
  button.addEventListener('click', () => {
    if (panel) {
      close();
      return;
    }
    panel = el(
      'div',
      { class: 'menu-panel' },
      getItems().map((item) =>
        item === 'hr'
          ? el('hr')
          : item.info
          ? item.info
          : el(
              'button',
              {
                onclick: () => {
                  close();
                  item.action();
                },
              },
              [el('span', { class: 'menu-check' }, item.checked ? '✓' : ''), item.label]
            )
      )
    );
    button.parentElement.append(panel);
    // keep it on screen (the people list opens near the right edge on phones);
    // not innerWidth: on phones the overflowing panel itself widens that
    const { left, right } = panel.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const shift = Math.max(Math.min(0, width - 8 - right), 8 - left);
    if (shift) panel.style.transform = `translateX(${shift}px)`;
    document.addEventListener('mousedown', onOutside, true);
  });
}
