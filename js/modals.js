/*
 * modals.js — overlay/modal helpers shared by all pages.
 * showModal() returns a close() function; only one closes itself —
 * stacking is allowed but rarely used.
 */

import { el } from './util.js';

/**
 * @param {{
 *   title?: string, body?: Node|string|Array,
 *   actions?: Array<{label:string, primary?:boolean, onClick?:Function,
 *                    keepOpen?:boolean}>,
 *   dismissible?: boolean,   // click-outside / × / Escape closes (default true)
 *   veil?: boolean,          // translucent white (true, NYT-style) vs dim
 *   onClose?: Function,
 * }} opts
 * @returns {() => void} close
 */
export function showModal(opts = {}) {
  const {
    title = '',
    body = null,
    actions = [],
    dismissible = true,
    veil = true,
    onClose = null,
  } = opts;

  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const overlay = el('div', { class: veil ? 'overlay' : 'overlay overlay-dim' }, [modal]);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      close();
    }
  };

  if (dismissible) {
    modal.style.position = 'relative';
    modal.append(
      el('button', { class: 'modal-close', 'aria-label': 'Close', onclick: close }, '×')
    );
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey, true);
  }

  if (title) modal.append(el('h2', {}, title));
  if (body != null) {
    modal.append(
      typeof body === 'string' ? el('p', {}, body) : el('div', { class: 'modal-body' }, body)
    );
  }
  if (actions.length) {
    modal.append(
      el(
        'div',
        { class: 'modal-actions' },
        actions.map((a) =>
          el(
            'button',
            {
              class: a.primary ? 'btn btn-primary' : 'btn',
              // Run the action BEFORE closing: close() fires onClose, which
              // is how confirmDialog detects a dismissal. Closing first made
              // every confirm resolve as "cancelled".
              onclick: (e) => {
                a.onClick?.(e);
                // keepOpen actions (e.g. "Test connection") act in place
                if (!a.keepOpen) close();
              },
            },
            a.label
          )
        )
      )
    );
  }

  document.body.append(overlay);
  modal.querySelector('.btn-primary')?.focus();
  return close;
}

/** Promise<boolean> confirm dialog. */
export function confirmDialog(message, { confirmLabel = 'OK', title = '' } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    showModal({
      title,
      body: message,
      dismissible: true,
      actions: [
        { label: 'Cancel', onClick: () => {} },
        {
          label: confirmLabel,
          primary: true,
          onClick: () => {
            decided = true;
            resolve(true);
          },
        },
      ],
      onClose: () => {
        if (!decided) resolve(false);
      },
    });
  });
}

/** Transient toast (bottom center). */
export function toast(message, { ms = 3000, error = false } = {}) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = el('div', { class: 'toast-host' });
    document.body.append(host);
  }
  const node = el('div', { class: 'toast' + (error ? ' toast-error' : '') }, message);
  host.append(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 400);
  }, ms);
}
