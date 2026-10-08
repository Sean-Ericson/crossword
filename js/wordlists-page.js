/*
 * wordlists-page.js — your own word lists for the puzzle builder
 * (wordlists.html).
 *
 * Without ?list: the site's list and yours, each switched on or off, plus
 * New list and Upload a list. With ?list=ID: one list to rename, switch,
 * add words to (typed in, or from a file), search, rescore and trim, or
 * download or delete. In a list that's on, a word's score replaces the
 * site's in your Fill-tab suggestions, and 0 hides it.
 *
 * Everything goes through /api/word-lists (server/api.mjs);
 * js/word-lists.js holds what the builder shares.
 */

import { el, qs, debounce } from './util.js';
import { api } from './api.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { showModal, confirmDialog, toast } from './modals.js';
import { ago } from './custom-tab.js';
import { readListFile, nameFromFile, describeEdit, formatCount } from './word-lists.js';

const PAGE = 100;
const FILE_TYPES = '.txt,.dict,.dic,.csv,.tsv,.lst,text/plain';
const host = qs('#wl-main');

const words = (n) => `${formatCount(n)} word${n === 1 ? '' : 's'}`;

async function main() {
  await loadMe();
  initProfileChip(qs('#profile-chip'));
  window.addEventListener('popstate', () => route());
  route();
}

let shown = 0; // which route() is current: a slow load for an earlier one draws nothing

function route() {
  const id = Number(new URLSearchParams(location.search).get('list'));
  const view = ++shown;
  return id ? showList(id, view) : showOverview(view);
}

/** Another view without reloading the page (so a toast from the last one stays up). */
function go(search) {
  history.pushState(null, '', `./wordlists.html${search}`);
  window.scrollTo(0, 0);
  route();
}

/** An on/off switch that saves at once (and flips back if that fails). */
function onSwitch(checked, label, save) {
  const box = el('input', { type: 'checkbox', class: 'wl-switch', role: 'switch', 'aria-label': label, ...(checked ? { checked: true } : {}) });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await save(box.checked);
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message, { error: true });
    }
    box.disabled = false;
  });
  return box;
}

/** A button (or a file input's label) that shows it's working. */
async function busy(node, label, work) {
  const before = node.firstChild.textContent;
  node.firstChild.textContent = label;
  node.classList.add('busy');
  node.setAttribute('aria-disabled', 'true');
  try {
    return await work();
  } finally {
    node.firstChild.textContent = before;
    node.classList.remove('busy');
    node.removeAttribute('aria-disabled');
  }
}

function fileButton(label, onFile) {
  const input = el('input', { type: 'file', accept: FILE_TYPES, class: 'visually-hidden' });
  const node = el('label', { class: 'btn' }, [label, input]);
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = ''; // the same file again still counts as a change
    if (file && !node.classList.contains('busy')) onFile(file, node);
  });
  return node;
}

const formatHint = () =>
  el('p', { class: 'wl-hint' }, [
    'A list file has one word per line, with a score after a semicolon if you like: ',
    el('code', {}, 'CRANE;60'),
    '. Spread the Wordlist, Peter Broda’s list and Crossfire or XWord Info dictionaries work as they are. Words are kept as plain letters (“Ice-cream” is ICECREAM); lines with digits or a single letter are skipped.',
  ]);

// ---------- all your lists ----------

async function showOverview(view) {
  let data;
  try {
    data = await api.get('word-lists');
  } catch (err) {
    if (view === shown) host.replaceChildren(el('p', { class: 'wl-error' }, err.message));
    return;
  }
  if (view !== shown) return;
  document.title = 'Word lists — Crossword';

  const siteRow = el('div', { class: 'wl-row' }, [
    onSwitch(data.use_site, 'Use the site’s list', async (on) => {
      await api.post('word-lists/prefs', { use_site: on });
      data.use_site = on;
    }),
    el('div', { class: 'wl-row-main' }, [
      el('span', { class: 'wl-row-name' }, 'The site’s list'),
      el(
        'span',
        { class: 'wl-row-meta' },
        `${data.site ? `${words(data.site.size)} · ` : ''}every answer in the archive and in puzzles published for everyone`
      ),
    ]),
  ]);

  const listRow = (l) => {
    const href = `./wordlists.html?list=${l.id}`;
    return el('div', { class: 'wl-row' }, [
      onSwitch(l.enabled, `Use “${l.name}”`, async (on) => {
        await api.post(`word-lists/${l.id}`, { enabled: on });
        l.enabled = on;
      }),
      el('a', { class: 'wl-row-main', href }, [
        el('span', { class: 'wl-row-name' }, l.name),
        el('span', { class: 'wl-row-meta' }, `${words(l.count)} · edited ${ago(l.updated_at)}`),
      ]),
      el('span', { class: 'wl-row-actions' }, [
        el('a', { class: 'btn btn-quiet', href }, 'Edit'),
        el('a', { class: 'btn btn-quiet', href: `./api/word-lists/${l.id}/file`, download: '' }, 'Download'),
      ]),
    ]);
  };

  const upload = (file, node) =>
    busy(node, 'Uploading…', async () => {
      try {
        const text = await readListFile(file);
        const res = await api.post('word-lists', { name: nameFromFile(file), text });
        toast(`“${res.list.name}”: ${describeEdit(res)}`, { ms: 5000 });
        go(`?list=${res.list.id}`);
      } catch (err) {
        toast(err.message, { error: true, ms: 6000 });
      }
    });

  host.replaceChildren(
    el('h1', {}, 'Word lists'),
    el(
      'p',
      { class: 'wl-intro' },
      'The puzzle builder’s Fill tab suggests (and counts) words from the lists switched on here. In your own lists, a word’s score replaces the site’s: scores run from 0 to 100, higher first, and 0 hides a word. Your lists are yours alone; co-authors get suggestions from their own.'
    ),
    el('div', { class: 'wl-lists' }, [
      siteRow,
      ...data.lists.map(listRow),
      data.lists.length ? null : el('p', { class: 'wl-empty' }, 'You don’t have any lists yet.'),
    ]),
    el('div', { class: 'wl-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => newList() }, 'New list'),
      fileButton('Upload a list…', upload),
    ]),
    formatHint()
  );
}

function newList() {
  const name = el('input', { class: 'wl-input', maxlength: '60', value: 'My words', 'aria-label': 'Name' });
  const create = async () => {
    try {
      const { list } = await api.post('word-lists', { name: name.value });
      go(`?list=${list.id}`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  showModal({
    title: 'New word list',
    body: [el('p', {}, 'What should it be called? Themers, favorites, words to avoid…'), name],
    actions: [{ label: 'Cancel' }, { label: 'Make it', primary: true, onClick: create }],
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create();
    }
  });
  name.focus();
  name.select();
}

// ---------- one list ----------

async function showList(id, view) {
  const state = { match: '', sort: 'word', offset: 0 };
  let page;
  const fetchPage = () =>
    api.get(`word-lists/${id}/words?${new URLSearchParams({ ...state, limit: String(PAGE) })}`);
  try {
    page = await fetchPage();
  } catch (err) {
    if (view !== shown) return;
    host.replaceChildren(
      el('p', { class: 'wl-back' }, el('a', { href: './wordlists.html' }, '← All word lists')),
      el('p', { class: 'wl-error' }, err.status === 404 ? 'There’s no such word list. It may have been deleted.' : err.message)
    );
    return;
  }
  if (view !== shown) return;
  let list = page.list;

  // ----- name, on/off, download, delete -----

  const nameInput = el('input', { class: 'wl-title', maxlength: '60', value: list.name, 'aria-label': 'List name', autocomplete: 'off' });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      if (e.key === 'Escape') nameInput.value = list.name;
      nameInput.blur();
    }
  });
  nameInput.addEventListener('change', async () => {
    try {
      list = (await api.post(`word-lists/${id}`, { name: nameInput.value })).list;
      renderHead();
    } catch (err) {
      nameInput.value = list.name;
      toast(err.message, { error: true });
    }
  });
  const switchLabel = el('span', { class: 'wl-switch-label' });
  const meta = el('span', { class: 'wl-meta-text' });
  const renderHead = () => {
    document.title = `${list.name} — Word lists`;
    if (document.activeElement !== nameInput) nameInput.value = list.name;
    switchLabel.textContent = list.enabled ? 'On: your suggestions use it' : 'Off: your suggestions ignore it';
    meta.textContent = `${words(list.count)} · edited ${ago(list.updated_at)}`;
  };
  const head = el('div', { class: 'wl-head' }, [
    nameInput,
    el('label', { class: 'wl-switch-row' }, [
      onSwitch(list.enabled, 'Use this list', async (on) => {
        list = (await api.post(`word-lists/${id}`, { enabled: on })).list;
        renderHead();
      }),
      switchLabel,
    ]),
  ]);
  const metaRow = el('p', { class: 'wl-meta' }, [
    meta,
    el('a', { class: 'btn btn-quiet', href: `./api/word-lists/${id}/file`, download: '' }, 'Download'),
    el('button', { class: 'btn btn-quiet wl-danger', type: 'button', onclick: () => deleteList() }, 'Delete list…'),
  ]);

  async function deleteList() {
    const ok = await confirmDialog(`Delete “${list.name}” and its ${words(list.count)}? This can’t be undone.`, { confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.del(`word-lists/${id}`);
      toast(`Deleted “${list.name}”.`);
      go('');
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // ----- adding words -----

  const area = el('textarea', {
    class: 'wl-input wl-area',
    rows: '4',
    placeholder: 'One per line: WORD, or WORD;SCORE',
    'aria-label': 'Words to add',
    spellcheck: 'false',
  });
  const fallback = el('input', { class: 'wl-input wl-num', type: 'number', min: '0', max: '100', step: '1', value: '50', 'aria-label': 'Score for words without one' });
  const addBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Add');

  /** Add lines of words (typed or a file's); a word already here takes the new score. */
  async function add(text, node) {
    const score = Number(fallback.value);
    if (fallback.value.trim() === '' || !(score >= 0 && score <= 100)) {
      toast('The score for words without one is a number from 0 to 100.', { error: true });
      return false;
    }
    return busy(node, 'Adding…', async () => {
      try {
        const res = await api.post(`word-lists/${id}/words`, { text, score });
        list = res.list;
        renderHead();
        toast(describeEdit(res), { ms: 5000 });
        await load();
        return true;
      } catch (err) {
        toast(err.message, { error: true, ms: 6000 });
        return false;
      }
    });
  }
  addBtn.addEventListener('click', async () => {
    if (!area.value.trim() || addBtn.classList.contains('busy')) return;
    if (await add(area.value, addBtn)) area.value = '';
  });
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addBtn.click();
  });
  const addSection = el('section', { class: 'wl-add' }, [
    el('h2', {}, 'Add words'),
    area,
    el('div', { class: 'wl-add-row' }, [
      el('label', { class: 'wl-field' }, ['Score for words without one', fallback]),
      el('span', { class: 'spacer' }),
      fileButton('Add from a file…', async (file, node) => {
        try {
          await add(await readListFile(file), node);
        } catch (err) {
          toast(err.message, { error: true });
        }
      }),
      addBtn,
    ]),
    formatHint(),
  ]);

  // ----- the words -----

  const search = el('input', {
    class: 'wl-input wl-search',
    type: 'search',
    placeholder: 'Find: letters, or a pattern like C?T or *ING',
    'aria-label': 'Find words',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const sort = el('select', { class: 'wl-input wl-sort', 'aria-label': 'Order' }, [
    el('option', { value: 'word' }, 'A to Z'),
    el('option', { value: 'best' }, 'Highest score first'),
    el('option', { value: 'worst' }, 'Lowest score first'),
  ]);
  const tbody = el('tbody');
  const table = el('table', { class: 'wl-table' }, [
    el('thead', {}, el('tr', {}, [el('th', {}, 'Word'), el('th', { class: 'wl-score-col' }, 'Score'), el('th', {})])),
    tbody,
  ]);
  const empty = el('p', { class: 'wl-empty' });
  const count = el('span', { class: 'wl-count' });
  const prev = el('button', { class: 'btn btn-quiet', type: 'button' }, '‹ Previous');
  const next = el('button', { class: 'btn btn-quiet', type: 'button' }, 'Next ›');
  const pager = el('div', { class: 'wl-pager' }, [prev, count, next]);

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    try {
      const got = await fetchPage();
      if (seq !== loadSeq) return;
      page = got;
      // removing words can leave a page past the end
      if (!page.words.length && state.offset > 0) {
        state.offset = Math.max(0, Math.floor((page.total - 1) / PAGE) * PAGE);
        return load();
      }
    } catch (err) {
      toast(err.message, { error: true });
      return;
    }
    renderWords();
  }
  const reload = debounce(() => {
    state.offset = 0;
    load();
  }, 250);
  search.addEventListener('input', () => {
    state.match = search.value.trim();
    reload();
  });
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    state.offset = 0;
    load();
  });
  prev.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE);
    load();
  });
  next.addEventListener('click', () => {
    state.offset += PAGE;
    load();
  });

  function renderWords() {
    tbody.replaceChildren(...page.words.map(([w, s]) => wordRow(w, s)));
    const to = state.offset + page.words.length;
    count.textContent = page.total ? `${formatCount(state.offset + 1)}–${formatCount(to)} of ${formatCount(page.total)}` : '';
    prev.disabled = state.offset === 0;
    next.disabled = to >= page.total;
    pager.hidden = page.total <= PAGE && state.offset === 0;
    table.hidden = !page.words.length;
    empty.hidden = !!page.words.length;
    empty.textContent = state.match ? 'Nothing in this list matches.' : 'No words yet. Add some above.';
  }

  /** A word's row: change its score in place; × removes it (and Undo puts it back). */
  function wordRow(word, score) {
    let current = score;
    let removed = false;
    const input = el('input', { class: 'wl-input wl-num', type: 'number', min: '0', max: '100', step: '1', value: String(score), 'aria-label': `Score for ${word}` });
    const tag = el('span', { class: 'wl-tag' });
    const remove = el('button', { class: 'btn btn-quiet wl-remove', type: 'button' });
    const tr = el('tr', {}, [el('td', { class: 'wl-word' }, [word, tag]), el('td', { class: 'wl-score-col' }, input), el('td', { class: 'wl-remove-col' }, remove)]);
    const render = () => {
      tag.textContent = removed ? 'removed' : current === 0 ? 'hidden' : '';
      tr.classList.toggle('removed', removed);
      input.disabled = removed;
      remove.textContent = removed ? 'Undo' : '×';
      remove.title = removed ? `Put ${word} back` : `Remove ${word}`;
      remove.setAttribute('aria-label', remove.title);
    };
    const edit = async (body) => {
      const res = await api.post(`word-lists/${id}/words`, body);
      list = res.list;
      renderHead();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    input.addEventListener('change', async () => {
      const v = input.value.trim() === '' ? NaN : Number(input.value);
      if (!(v >= 0 && v <= 100)) {
        toast('A score is a number from 0 to 100.', { error: true });
        input.value = String(current);
        return;
      }
      try {
        await edit({ set: [[word, Math.round(v)]] });
        current = Math.round(v);
        input.value = String(current);
        render();
      } catch (err) {
        input.value = String(current);
        toast(err.message, { error: true });
      }
    });
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await edit(removed ? { set: [[word, current]] } : { remove: [word] });
        removed = !removed;
        render();
      } catch (err) {
        toast(err.message, { error: true });
      }
      remove.disabled = false;
    });
    render();
    return tr;
  }

  host.replaceChildren(
    el('p', { class: 'wl-back' }, el('a', { href: './wordlists.html' }, '← All word lists')),
    head,
    metaRow,
    addSection,
    el('section', { class: 'wl-words' }, [el('h2', {}, 'Words'), el('div', { class: 'wl-tools' }, [search, sort]), table, empty, pager])
  );
  renderHead();
  renderWords();
}

main();
