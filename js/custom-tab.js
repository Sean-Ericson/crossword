/*
 * custom-tab.js — the archive's Custom tab: puzzles people made on the
 * site. "Your puzzles" (drafts, published, withdrawn; co-authored ones
 * too) with how they're doing, and everyone else's puzzles you can see,
 * newest first, with your status on each. New puzzle starts a draft in the
 * builder (builder.html).
 *
 * Data: GET /api/custom-puzzles (archive-page.js fetches it once), and the
 * archive's /api/progress for your status on each puzzle.
 */

import { el, formatTime } from './util.js';
import { api } from './api.js';
import { showModal, toast } from './modals.js';
import { listNames } from './people.js';
import { parsePuz, PuzParseError } from './puz.js';
import { MIN_SIZE, MAX_SIZE, docFromPuz } from './custom-puzzle.js';

const FILTER_ABOVE = 12; // more of everyone's puzzles than this: search and a status filter

const PRESETS = [
  ['mini', 'Mini', 5, 5],
  ['midi', 'Midi', 9, 9],
  ['daily', 'Daily', 15, 15],
  ['sunday', 'Sunday', 21, 21],
  ['other', 'Another size', null, null],
];

/** "just now", "5 min ago", "3 h ago", "yesterday", "Oct 5" */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const min = Math.round((now - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  if (min < 48 * 60) return 'yesterday';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Others' published puzzles you've never opened. */
export function isNew(p, progress) {
  return !p.mine && p.status === 'published' && !progress.solo[p.id] && !progress.coop[p.id]?.length;
}

const stars = (s) => (s ? `★ ${s.avg.toFixed(1)} (${s.n})` : null);

/**
 * @param {HTMLElement} host
 * @param {{me: object, puzzles: object[], progress: {solo, coop}, nameOf: (n:string) => string,
 *          statusOf: (id:string) => {status:string}, icons: object, coopMarker: (id:string) => Node|null}} ctx
 */
export function renderCustomTab(host, ctx) {
  const { puzzles, progress, nameOf } = ctx;
  host.textContent = '';
  host.append(
    el('div', { class: 'custom-actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => openNewPuzzle() }, 'New puzzle'),
      el('label', { class: 'btn', title: 'Bring in a puzzle you made with another program (Crossfire, Phil, Crosshare…)' }, [
        'Upload a .puz',
        el('input', { type: 'file', accept: '.puz', class: 'visually-hidden', onchange: (e) => uploadPuz(e.target.files[0]) }),
      ]),
      el('a', { class: 'btn', href: './wordlists.html', title: 'Your own words for the builder’s suggestions' }, 'Word lists'),
      el('p', { class: 'custom-intro' }, 'Make a crossword alone or with friends, live, and share it here.'),
    ])
  );

  // ----- yours -----
  const mine = puzzles.filter((p) => p.mine);
  const yours = el('section', { class: 'custom-section' }, [el('h2', {}, 'Your puzzles')]);
  if (!mine.length) yours.append(el('p', { class: 'custom-empty' }, 'Nothing yet. New puzzle starts one.'));
  const order = { draft: 0, published: 1, withdrawn: 2 };
  mine.sort((a, b) => order[a.status] - order[b.status] || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  for (const p of mine) yours.append(yourRow(p));
  host.append(yours);

  function yourRow(p) {
    const others = p.authors.filter((n) => n !== ctx.me.name);
    const bits = [];
    if (p.status === 'draft') bits.push(`Draft · edited ${ago(p.updated_at)}`);
    else if (p.status === 'withdrawn') bits.push('Withdrawn');
    else bits.push(`Published ${ago(p.published_at)}`);
    bits.push(`${p.width}×${p.height}`);
    if (p.status !== 'draft') {
      bits.push(p.solved ? `${p.solved} solved` : 'no solves yet');
      if (p.solving) bits.push(`${p.solving} solving`);
      if (stars(p.stars)) bits.push(stars(p.stars));
      if (p.notes) bits.push(`${p.notes} note${p.notes === 1 ? '' : 's'}`);
    }
    const notes = [];
    if (others.length) notes.push(`with ${listNames(others.map(nameOf), 3)}`);
    if (p.status !== 'draft' && p.visibility === 'people') {
      notes.push(p.shared_with.length ? `shared with ${listNames(p.shared_with.map(nameOf), 3)}` : 'shared with nobody yet');
    }
    if (p.changed) notes.push('newer changes not published');
    return el('div', { class: `custom-item mine st-${p.status}` }, [
      el('a', { class: 'ci-main', href: `./builder.html?id=${encodeURIComponent(p.id)}` }, [
        el('span', { class: 'ci-title' }, p.title || 'Untitled'),
        el('span', { class: 'ci-meta' }, bits.join(' · ')),
        notes.length ? el('span', { class: 'ci-note' }, notes.join(' · ')) : null,
      ]),
      el('span', { class: 'ci-links' }, [
        el('a', { class: 'btn btn-quiet', href: `./builder.html?id=${encodeURIComponent(p.id)}` }, 'Edit'),
        p.status !== 'draft'
          ? el('a', { class: 'btn btn-quiet', href: `./analysis.html?puzzle=${encodeURIComponent(p.id)}` }, 'Results')
          : null,
      ]),
    ]);
  }

  // ----- everyone else's -----
  const theirs = puzzles.filter((p) => !p.mine && (p.status === 'published' || progress.solo[p.id] || progress.coop[p.id]?.length));
  const section = el('section', { class: 'custom-section' }, [el('h2', {}, 'Puzzles by everyone else')]);
  host.append(section);
  if (!theirs.length) {
    section.append(el('p', { class: 'custom-empty' }, 'None yet. When someone publishes a puzzle, it shows up here.'));
    return;
  }
  const list = el('div', { class: 'custom-list' });
  let query = '';
  let show = 'all';
  if (theirs.length > FILTER_ABOVE) {
    const search = el('input', {
      class: 'custom-search',
      type: 'search',
      placeholder: 'Find a puzzle or a constructor',
      'aria-label': 'Find a puzzle',
      oninput: () => {
        query = search.value.trim().toLowerCase();
        draw();
      },
    });
    const filter = el(
      'select',
      {
        class: 'custom-filter',
        'aria-label': 'Show',
        onchange: () => {
          show = filter.value;
          draw();
        },
      },
      [['all', 'All'], ['new', 'New to you'], ['started', 'In progress'], ['solved', 'Solved']].map(([v, label]) =>
        el('option', { value: v }, label)
      )
    );
    section.append(el('div', { class: 'custom-tools' }, [search, filter]));
  }
  section.append(list);
  draw();

  function draw() {
    list.textContent = '';
    const shown = theirs.filter((p) => {
      const { status } = ctx.statusOf(p.id);
      if (show === 'new' && !isNew(p, progress)) return false;
      if (show === 'started' && status !== 'in-progress') return false;
      if (show === 'solved' && !status.startsWith('solved')) return false;
      return !query || `${p.title} ${p.author}`.toLowerCase().includes(query);
    });
    if (!shown.length) list.append(el('p', { class: 'custom-empty' }, 'Nothing matches.'));
    for (const p of shown) list.append(theirRow(p));
  }

  function theirRow(p) {
    const { status, record } = ctx.statusOf(p.id);
    const [icon, iconClass, tip] = ctx.icons[status];
    const bits = [p.author && `By ${p.author}`, `${p.width}×${p.height}`, ago(p.published_at), stars(p.stars)];
    if (record?.completed) bits.push(formatTime(record.elapsed));
    return el(
      'a',
      {
        class: `custom-item${p.status === 'withdrawn' ? ' withdrawn' : ''}`,
        href: `./puzzle.html?id=${encodeURIComponent(p.id)}`,
        title: [p.title, tip].filter(Boolean).join(' — '),
      },
      [
        el('span', { class: 'ci-main' }, [
          el('span', { class: 'ci-title' }, [
            p.title || 'Untitled',
            isNew(p, progress) ? el('span', { class: 'ci-tag new' }, 'new') : null,
            p.visibility === 'people' ? el('span', { class: 'ci-tag' }, 'shared with you') : null,
            p.status === 'withdrawn' ? el('span', { class: 'ci-tag' }, 'withdrawn') : null,
          ]),
          el('span', { class: 'ci-meta' }, bits.filter(Boolean).join(' · ')),
        ]),
        ctx.coopMarker(p.id),
        el('span', { class: `sp-status ${iconClass}` }, icon),
      ]
    );
  }
}

/** A .puz from another program becomes a draft here (it's checked and published from the builder). */
async function uploadPuz(file) {
  if (!file) return;
  if (file.size > 1_000_000) {
    toast('That file is too big for a crossword.', { error: true });
    return;
  }
  let doc;
  try {
    doc = docFromPuz(parsePuz(await file.arrayBuffer()));
  } catch (err) {
    toast(err instanceof PuzParseError ? 'That doesn’t look like a .puz file.' : err.message, { error: true });
    return;
  }
  try {
    const { puzzle } = await api.post('custom-puzzles', { doc });
    location.href = `./builder.html?id=${encodeURIComponent(puzzle.id)}`;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

/** The New puzzle dialog: a size, a symmetry and maybe a title, then the builder. */
export function openNewPuzzle() {
  const sizeRows = PRESETS.map(([key, label, w, h], k) =>
    el('label', { class: 'size-row' }, [
      el('input', { type: 'radio', name: 'size', value: key, ...(k === 0 ? { checked: true } : {}) }),
      el('span', {}, [el('b', {}, label), w ? ` ${w}×${h}` : '']),
    ])
  );
  const num = (value) =>
    el('input', { type: 'number', min: String(MIN_SIZE), max: String(MAX_SIZE), value: String(value), class: 'size-num' });
  const widthIn = num(13);
  const heightIn = num(13);
  const other = el('div', { class: 'size-other' }, [widthIn, '×', heightIn]);
  const symmetry = el('select', { class: 'field' }, [
    el('option', { value: 'rotational' }, 'Rotational (the standard)'),
    el('option', { value: 'mirror' }, 'Left–right mirror'),
    el('option', { value: 'none' }, 'None'),
  ]);
  const title = el('input', { class: 'field', maxlength: '120', placeholder: 'Optional; you can name it later' });
  const close = showModal({
    title: 'New puzzle',
    body: el('div', { class: 'new-puzzle' }, [
      el('div', { class: 'field-label' }, 'Size'),
      el('div', { class: 'size-grid' }, sizeRows),
      other,
      el('label', { class: 'field-label' }, ['Symmetry', symmetry]),
      el('label', { class: 'field-label' }, ['Title', title]),
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Start building',
        primary: true,
        keepOpen: true,
        onClick: async (e) => {
          const key = document.querySelector('input[name=size]:checked')?.value ?? 'mini';
          const [, , w, h] = PRESETS.find(([k]) => k === key);
          const width = w ?? Number(widthIn.value);
          const height = h ?? Number(heightIn.value);
          e.target.disabled = true;
          try {
            const { puzzle } = await api.post('custom-puzzles', { width, height, symmetry: symmetry.value, title: title.value });
            close();
            location.href = `./builder.html?id=${encodeURIComponent(puzzle.id)}`;
          } catch (err) {
            e.target.disabled = false;
            toast(err.message, { error: true });
          }
        },
      },
    ],
  });
  const syncOther = () => (other.hidden = document.querySelector('input[name=size]:checked')?.value !== 'other');
  for (const row of sizeRows) row.querySelector('input').addEventListener('change', syncOther);
  syncOther();
}
