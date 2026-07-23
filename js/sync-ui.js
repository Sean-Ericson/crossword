/*
 * sync-ui.js — the header sync badge and the GitHub settings modal.
 */

import { el } from './util.js';
import { showModal, toast } from './modals.js';
import { loadGhConfig, saveGhConfig } from './sync.js';
import { GitHubClient } from './github.js';

const BADGE_STATES = {
  'local-only': ['Local only', ''],
  idle: ['✓ Synced', 'badge-ok'],
  syncing: ['⟳ Syncing…', ''],
  error: ['⚠ Sync error', 'badge-error'],
  'auth-error': ['⚠ Token problem', 'badge-error'],
};

/**
 * @param {HTMLElement} badgeEl
 * @param {import('./sync.js').Sync} sync
 * @param {{onSyncNow?: Function}} opts
 */
export function initSyncBadge(badgeEl, sync, opts = {}) {
  badgeEl.hidden = false;
  badgeEl.style.cursor = 'pointer';
  sync.onStatus((status, error) => {
    const [label, cls] = BADGE_STATES[status] ?? [status, ''];
    badgeEl.textContent = label;
    badgeEl.className = `badge ${cls}`.trim();
    badgeEl.title = error || 'GitHub sync settings';
  });
  badgeEl.addEventListener('click', () => openSyncSettings(sync, opts));
}

export function openSyncSettings(sync, { onSyncNow } = {}) {
  const cfg = loadGhConfig();

  const field = (label, key, type = 'text', placeholder = '') => {
    const input = el('input', {
      type,
      value: cfg[key] ?? '',
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
      style:
        'width:100%;padding:8px 10px;border:1px solid var(--color-border);border-radius:6px;font-size:14px;font-family:monospace',
    });
    const row = el('label', { style: 'display:block;margin-bottom:10px;font-size:13px' }, [
      el('div', { style: 'margin-bottom:3px;font-weight:600' }, label),
      input,
    ]);
    return [row, input];
  };

  const [ownerRow, ownerIn] = field('GitHub owner (username)', 'owner', 'text', 'your-username');
  const [repoRow, repoIn] = field('Data repo name', 'repo', 'text', 'crossword-data');
  const [branchRow, branchIn] = field('Branch', 'branch', 'text', 'main');
  const [tokenRow, tokenIn] = field(
    'Fine-grained access token',
    'token',
    'password',
    'github_pat_…'
  );

  const result = el('div', { style: 'min-height:20px;font-size:13px;margin:4px 0 8px' });

  const readCfg = () => ({
    owner: ownerIn.value.trim(),
    repo: repoIn.value.trim(),
    branch: branchIn.value.trim() || 'main',
    token: tokenIn.value.trim(),
  });

  const testBtn = el(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        const c = readCfg();
        if (!c.owner || !c.repo || !c.token) {
          result.textContent = 'Owner, repo, and token are all required.';
          result.style.color = '#b3261e';
          return;
        }
        result.textContent = 'Testing…';
        result.style.color = '';
        const check = await new GitHubClient(c).testAuth();
        if (check.ok) {
          result.textContent = `✓ Connected${check.private ? ' (private repo)' : ' — WARNING: repo is public!'}${
            check.pushAllowed ? '' : ' — token has no write access!'
          }`;
          result.style.color = check.private && check.pushAllowed ? '#256029' : '#b3261e';
        } else {
          result.textContent = `✗ ${check.error}`;
          result.style.color = '#b3261e';
        }
      },
    },
    'Test connection'
  );

  const body = el('div', { style: 'text-align:left' }, [
    el(
      'p',
      { style: 'font-size:13px;margin-top:0' },
      'Progress and stats sync through a (private) GitHub repo. Paste a fine-grained token that can read/write Contents on that one repo.'
    ),
    ownerRow,
    repoRow,
    branchRow,
    tokenRow,
    result,
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
      testBtn,
      sync?.active && onSyncNow
        ? el(
            'button',
            {
              class: 'btn',
              onclick: () => {
                onSyncNow();
                toast('Syncing…');
              },
            },
            'Sync now'
          )
        : null,
    ]),
  ]);

  showModal({
    title: 'GitHub sync',
    body,
    actions: [
      {
        label: 'Disconnect',
        onClick: () => {
          const c = readCfg();
          c.token = '';
          saveGhConfig(c);
          location.reload();
        },
      },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          saveGhConfig(readCfg());
          location.reload();
        },
      },
    ],
  });
}
