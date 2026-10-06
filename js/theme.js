/*
 * theme.js — light/dark mode and the header toggle (.theme-toggle).
 *
 * A classic script, not a module, loaded from <head> so the theme is set
 * before the first paint (modules run after parsing and the page would
 * flash white). The choice is per browser, not per account (the login page
 * has no user yet). Until someone toggles, the page follows the system.
 */
(() => {
  const KEY = 'xw:theme';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch {
      return null;
    }
  }

  let choice = saved();

  function apply() {
    const theme = choice ?? (system.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    for (const btn of document.querySelectorAll('.theme-toggle')) {
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }

  apply();
  system.addEventListener('change', apply);
  // toggled in another tab
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    choice = saved();
    apply();
  });

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    for (const btn of document.querySelectorAll('.theme-toggle')) {
      btn.addEventListener('click', () => {
        choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem(KEY, choice);
        } catch {
          /* private mode: this page only */
        }
        apply();
      });
    }
  });
})();
