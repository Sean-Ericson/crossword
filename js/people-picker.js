/*
 * people-picker.js — a dialog for choosing people: co-op partners, or
 * whom to compare stats with. It stays usable however many accounts there
 * are. The list scrolls inside the dialog, so the buttons never leave the
 * screen. With more than a handful of people it adds a search box and
 * lists the people you solved with recently first.
 */

import { el } from './util.js';
import { showModal } from './modals.js';
import { byDisplayName, listNames, pickerGroups } from './people.js';
import { isTouchDevice } from './touch-keyboard.js';

const SEARCH_ABOVE = 8; // longer lists get the search box and the "Solved with recently" group

/**
 * @param {{
 *   title: string,
 *   users: Array<{name, display_name, color, last_together?}>,
 *   confirmLabel: string,
 *   selected?: Iterable<string>,   // checked when the dialog opens
 *   you?: string,                  // marked "(you)" if they're in the list
 * }} opts
 * @returns {Promise<string[]|null>} the checked names in the order they were
 *   checked (the pre-checked ones first), or null if the dialog was closed
 */
export function pickPeople({ title, users, confirmLabel, selected = [], you = null }) {
  const chosen = new Set(selected);
  const long = users.length > SEARCH_ABOVE;
  const mine = users.find((u) => u.name === you); // listed first, outside the groups
  const others = users.filter((u) => u !== mine);
  const { recent, rest } = long ? pickerGroups(others) : { recent: [], rest: [...others].sort(byDisplayName) };
  const nameOf = new Map(users.map((u) => [u.name, u.display_name || u.name]));

  const rows = []; // {row, box, text}
  const groups = []; // {head, rows}

  function personRow(u) {
    const box = el('input', {
      type: 'checkbox',
      ...(chosen.has(u.name) ? { checked: true } : {}),
      onchange: () => {
        if (box.checked) chosen.add(u.name);
        else chosen.delete(u.name);
        update();
      },
    });
    const row = el('label', { class: 'person-row' }, [
      box,
      el('span', { class: 'user-dot', style: `background:${u.color}` }),
      el('span', { class: 'person-name' }, u.display_name || u.name),
      u.name === you ? el('span', { class: 'person-note' }, '(you)') : null,
      // the sign-in name, unless it's just the display name in lowercase
      u.display_name && u.display_name.toLowerCase() !== u.name ? el('span', { class: 'person-login' }, u.name) : null,
    ]);
    rows.push({ row, box, text: `${u.display_name || ''} ${u.name}`.toLowerCase() });
    return row;
  }

  function group(heading, people) {
    if (!people.length) return [];
    const head = heading ? el('div', { class: 'people-group' }, heading) : null;
    const members = people.map(personRow);
    groups.push({ head, rows: members });
    return [head, ...members];
  }

  const empty = el('div', { class: 'people-empty', hidden: true }, 'Nobody by that name.');
  const list = el('div', { class: long ? 'people-list searchable' : 'people-list' }, [
    mine ? personRow(mine) : null,
    ...group(recent.length ? 'Solved with recently' : null, recent),
    ...group(recent.length ? 'Everyone else' : null, rest),
    empty,
  ]);

  const search = long
    ? el('input', {
        type: 'search',
        class: 'people-search',
        placeholder: 'Search by name',
        'aria-label': 'Search people',
        autocomplete: 'off',
        spellcheck: 'false',
        oninput: () => applyFilter(),
        // Enter checks (or unchecks) the first match and clears the box,
        // so a few names can be picked without touching the mouse.
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const first = rows.find((r) => !r.row.hidden);
          if (!first || !search.value.trim()) return;
          first.box.click();
          search.value = '';
          applyFilter();
        },
      })
    : null;

  function applyFilter() {
    const q = search?.value.trim().toLowerCase() ?? '';
    for (const r of rows) r.row.hidden = !!q && !r.text.includes(q);
    for (const g of groups) if (g.head) g.head.hidden = g.rows.every((row) => row.hidden);
    empty.hidden = rows.some((r) => !r.row.hidden);
  }

  const summary = el('div', { class: 'people-summary', 'aria-live': 'polite' });
  let confirmBtn = null;
  function update() {
    const names = [...chosen].filter((n) => nameOf.has(n)).map((n) => nameOf.get(n));
    summary.textContent = names.length ? `Picked: ${listNames(names, 4)}` : 'Nobody picked yet.';
    if (confirmBtn) confirmBtn.disabled = !names.length;
  }

  return new Promise((resolve) => {
    let done = false;
    showModal({
      title,
      body: el('div', { class: 'people-picker' }, [search, list, summary]),
      actions: [
        { label: 'Cancel' },
        {
          label: confirmLabel,
          primary: true,
          onClick: () => {
            done = true;
            resolve([...chosen].filter((n) => nameOf.has(n)));
          },
        },
      ],
      onClose: () => !done && resolve(null),
    });
    confirmBtn = list.closest('.modal')?.querySelector('.modal-actions .btn-primary') ?? null;
    update();
    // not on phones: focusing would pop the keyboard over half the list
    if (search && !isTouchDevice()) search.focus();
  });
}
