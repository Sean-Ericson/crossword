/*
 * move-banner.js — dismissible "we're moving" notice at the top of every
 * page, for the switch-over to the self-hosted site. Once closed it stays
 * closed on this browser. Delete this file (and its <script> tags) when the
 * GitHub Pages site is retired.
 */

const NEW_SITE = 'https://cross.ho.house';
const DISMISSED_KEY = 'xw:site:move-banner-dismissed';

function dismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function show() {
  if (dismissed()) return;
  const banner = document.createElement('div');
  banner.className = 'move-banner';
  banner.setAttribute('role', 'status');

  const text = document.createElement('span');
  const link = document.createElement('a');
  link.href = NEW_SITE;
  link.textContent = NEW_SITE.replace(/^https:\/\//, '');
  text.append('Warning: crosswords are moving! Contact Sean for login info and go to ', link);

  const close = document.createElement('button');
  close.className = 'move-banner-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';

  banner.append(text, close);
  document.body.prepend(banner);

  // the player page sizes itself to the window; make room for the banner
  const root = document.documentElement;
  const fit = () => root.style.setProperty('--banner-height', `${banner.offsetHeight}px`);
  const observer = new ResizeObserver(fit);
  observer.observe(banner);
  fit();

  close.addEventListener('click', () => {
    observer.disconnect();
    banner.remove();
    root.style.setProperty('--banner-height', '0px');
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* private mode: it just comes back next visit */
    }
  });
}

show();
