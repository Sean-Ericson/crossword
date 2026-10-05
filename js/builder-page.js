/*
 * builder-page.js — the puzzle builder (builder.html?id=custom-…).
 *
 * A custom puzzle's authors edit its working copy together, live. Every
 * change made here goes through LiveBuild (net.js) to the build room
 * (server/build-rooms.mjs), which keeps and saves it and passes it on;
 * changes from the room are applied with applyChange and never sent back.
 * Publishing copies the working copy to what solvers get (POST
 * /api/custom-puzzles/:id/publish); from then on the shape (size and black
 * squares) is locked, so every solve keeps fitting.
 *
 * The grid is the player's GridView with BuildEngine (the solver's keys).
 * Clues are written in the bar over the grid or in the lists beside it
 * (ClueEditor). The Check tab lists what must be fixed before publishing
 * and what's merely unusual (custom-puzzle.js problems()). The Fill tab
 * suggests words for the current entry from the server's word list
 * (/api/words), keeping only words that leave every crossing something;
 * each clue row says how many words fit its entry.
 *
 * Keys on the grid: letters fill and advance · arrows move (onto black
 * squares too) · Tab / Shift+Tab: next or previous entry · Enter: write the
 * clue · . : a black square (and its symmetric partner) · * : a circle ·
 * Esc or Insert: rebus · Backspace or Delete on a black square removes it ·
 * Ctrl+Z / Ctrl+Shift+Z: undo / redo (your own changes).
 */

import { GridView } from './grid-view.js';
import { BuildEngine } from './builder-engine.js';
import { ClueEditor } from './clue-editor.js';
import { LiveBuild } from './net.js';
import { api } from './api.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { showModal, confirmDialog, toast } from './modals.js';
import { makeMenu } from './menus.js';
import { openRebusInput } from './rebus-input.js';
import { pickPeople } from './people-picker.js';
import { listNames } from './people.js';
import { TouchKeyboard, isTouchDevice } from './touch-keyboard.js';
import { el, qs, qsa } from './util.js';
import {
  applyChange, valueAt, modelOf, docToPuz, problems, partnerOf, clueKey, entryName, isCustomId, SYMMETRIES,
} from './custom-puzzle.js';
import { downloadPuz, puzFileName } from './puz-write.js';

const params = new URLSearchParams(location.search);
const SYMMETRY_LABELS = { rotational: 'Rotational (standard)', mirror: 'Left–right mirror', none: 'None' };
const STATUS_LABELS = { draft: 'Draft', published: 'Published', withdrawn: 'Withdrawn' };
const maxChips = () => (matchMedia('(max-width: 600px)').matches ? 3 : 6);

async function main() {
  const me = await loadMe();
  initProfileChip(qs('#profile-chip'));
  const id = params.get('id');
  if (!isCustomId(id)) {
    showFatal('There’s no puzzle to build here. Start one from the Custom tab of the archive.');
    return;
  }

  // ----- state -----
  let doc = null; // the working copy, as this tab has it
  let info = null; // {status, visibility, shape_locked, changed, created_by, authors}
  let model = null;
  let record = null; // the engine's copy of doc.grid
  let engine = null;
  let gridView = null;
  let presence = [];
  let ready = false;
  let blockMode = false;
  let typingClue = null; // the clue being typed here, for co-authors' screens
  let barKey = null; // the entry the clue bar is showing
  let directory = new Map(); // every account, for names
  const pendingClues = new Map(); // key -> text typed but not sent yet
  const undoStack = [];
  const redoStack = [];
  const live = new LiveBuild({ puzzleId: id });

  const boardWrap = qs('#board-wrap');
  const barInput = qs('#bar-input');
  const titleInput = qs('#title-input');
  const bylineInput = qs('#byline-input');

  const nameOf = (name) =>
    info?.authors.find((a) => a.name === name)?.display_name || directory.get(name)?.display_name || name || 'Someone';

  const clueEditor = new ClueEditor({
    acrossEl: qs('#across-list'),
    downEl: qs('#down-list'),
    onSelect: (word) => word && engine.selectWord(word),
    onInput: (key, text) => editClue(key, text),
    onFocus: (key) => {
      if (!key) flushClues();
      typingClue = key;
      sendCursor();
    },
    onKey: (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.target.blur(); // back to the grid
      }
    },
  });

  // ----- the grid -----

  const recordFor = (d) => ({
    fill: d.grid.slice(),
    marks: new Array(d.grid.length).fill(0),
    completed: false,
    autocheck: false,
    used_check: false,
    used_reveal: false,
  });

  /** A new numbering: the first snapshot, or the shape changed. */
  function rebuild() {
    const sel = engine ? { ...engine.sel } : null;
    model = modelOf(doc);
    record = recordFor(doc);
    engine = new BuildEngine(model, record);
    engine.on('selection', onSelection);
    engine.on('cells', onEngineCells);
    gridView?.destroy();
    gridView = new GridView(boardWrap, model, { onCellClick, clickBlack: true });
    gridView.board.classList.toggle('block-mode', blockMode);
    gridView.updateAll(record);
    clueEditor.setModel(model, doc);
    if (sel) engine.selectSquare(Math.min(sel.index, model.cells.length - 1), sel.dir);
    else engine.emitSelection();
    drawAllRemote();
    scheduleCheck();
    scheduleCounts();
  }

  function onSelection({ index, word }) {
    gridView.setSelection(index, word ? word.cells : []);
    clueEditor.setActive(word, engine.crossWord());
    renderBar(word);
    if (!typingClue) sendCursor();
    scheduleFill();
  }

  /** Letters typed here go to the doc and the room. */
  function onEngineCells(indexes, meta) {
    for (const i of indexes) gridView.updateCell(i, record);
    if (meta.remote) return;
    commit(indexes.map((i) => ({ k: `cell:${i}`, v: record.fill[i] })));
    // something a square can't hold (a rebus with symbols) goes back to what it holds
    const fix = indexes.filter((i) => record.fill[i] !== doc.grid[i]);
    if (fix.length) {
      engine.applyRemoteCells(fix.map((i) => ({ i, fill: doc.grid[i], marks: 0 })));
      toast('A square takes letters and digits only (up to 12 for a rebus).', { error: true });
    }
  }

  function onCellClick(i) {
    if (!ready) return;
    leaveFields(); // the grid's mousedown keeps focus where it was
    if (blockMode) {
      engine.selectSquare(i);
      toggleBlock(i);
      return;
    }
    engine.clickCell(i);
  }

  /** Typing goes back to the grid. */
  function leaveFields() {
    if (document.activeElement?.matches?.('input, textarea')) document.activeElement.blur();
  }

  // ----- changes -----

  /**
   * Apply this tab's changes: to the doc, the screen and the room. Each
   * returned step is {k, before, after}; `undoable` ones can be undone.
   */
  function commit(changes, { undoable = true } = {}) {
    if (!ready) return [];
    const steps = [];
    for (const ch of changes) {
      const before = valueAt(doc, ch.k);
      const done = applyChange(doc, ch, { shapeLocked: info.shape_locked });
      if (!done || done.v === before) continue;
      steps.push({ k: done.k, before, after: done.v });
    }
    if (!steps.length) return steps;
    live.sendEdit(steps.map(({ k, after }) => ({ k, v: after })));
    if (undoable) {
      undoStack.push(steps);
      if (undoStack.length > 500) undoStack.shift();
      redoStack.length = 0;
      renderUndo();
    }
    refresh(steps);
    return steps;
  }

  /** Bring the screen up to date after these keys changed ({k, before}). */
  function refresh(changed) {
    let shape = false;
    const cells = [];
    for (const { k, before } of changed) {
      let m;
      if ((m = /^cell:(\d+)$/.exec(k))) {
        const i = Number(m[1]);
        if ((before === '.') !== (doc.grid[i] === '.')) shape = true;
        cells.push(i);
      } else if ((m = /^circle:(\d+)$/.exec(k))) {
        gridView.setCircled(Number(m[1]), !!doc.circles[Number(m[1])]);
      } else if ((m = /^clue:(\w+)$/.exec(k))) {
        if (pendingClues.has(m[1])) continue; // what's being typed here wins on screen
        const text = doc.clues[m[1]] ?? '';
        clueEditor.updateClue(m[1], text);
        if (barKey === m[1] && document.activeElement !== barInput) barInput.value = text;
      } else if (k === 'title' && document.activeElement !== titleInput) {
        titleInput.value = doc.title;
      } else if (k === 'byline' && document.activeElement !== bylineInput) {
        bylineInput.value = doc.byline;
      }
    }
    if (shape) rebuild();
    else if (cells.length) engine.applyRemoteCells(cells.map((i) => ({ i, fill: doc.grid[i], marks: 0 })));
    clueEditor.updateAnswers(doc);
    renderTitle();
    scheduleCheck();
    if (cells.length) {
      scheduleCounts();
      scheduleFill();
    }
  }

  live.on('edit', (changes) => {
    const changed = [];
    for (const ch of changes) {
      const before = valueAt(doc, ch.k);
      if (applyChange(doc, ch)) changed.push({ k: ch.k, before });
    }
    if (changed.length) refresh(changed);
  });

  function toggleBlock(i) {
    if (info.shape_locked) {
      toast('Black squares stay put once a puzzle is published, so solves in progress still fit.', { error: true, ms: 4500 });
      return;
    }
    const black = doc.grid[i] !== '.';
    const cells = [...new Set([i, partnerOf(i, doc.width, doc.height, doc.symmetry)])];
    commit(cells.map((c) => ({ k: `cell:${c}`, v: black ? '.' : '' })));
  }

  function toggleCircle(i = engine.sel.index) {
    if (doc.grid[i] === '.') return;
    commit([{ k: `circle:${i}`, v: doc.circles[i] ? 0 : 1 }]);
  }

  function setBlockMode(on) {
    blockMode = on;
    qs('#block-btn').classList.toggle('on', on);
    gridView?.board.classList.toggle('block-mode', on);
  }

  // ----- undo (your own changes; a co-author's later change to a square stands) -----

  function undo() {
    const steps = undoStack.pop();
    if (!steps) return;
    const still = steps.filter((s) => valueAt(doc, s.k) === s.after);
    const done = commit(still.map((s) => ({ k: s.k, v: s.before })), { undoable: false });
    if (done.length) redoStack.push(still.filter((s) => done.some((d) => d.k === s.k)));
    showStep(done);
    renderUndo();
  }

  function redo() {
    const steps = redoStack.pop();
    if (!steps) return;
    const still = steps.filter((s) => valueAt(doc, s.k) === s.before);
    const done = commit(still.map((s) => ({ k: s.k, v: s.after })), { undoable: false });
    if (done.length) undoStack.push(still.filter((s) => done.some((d) => d.k === s.k)));
    showStep(done);
    renderUndo();
  }

  /** Put the cursor where an undo or redo happened. */
  function showStep(steps) {
    const cell = steps.map((s) => /^cell:(\d+)$/.exec(s.k)).find(Boolean);
    if (cell) engine.selectSquare(Number(cell[1]));
  }

  function renderUndo() {
    qs('#undo-btn').disabled = !undoStack.length;
    qs('#redo-btn').disabled = !redoStack.length;
  }

  // ----- clues -----

  /** Typing in a clue box: shown at once, sent once the typing pauses. */
  let clueTimer = null;
  function editClue(key, text) {
    pendingClues.set(key, text);
    clueEditor.updateClue(key, text);
    if (barKey === key && document.activeElement !== barInput) barInput.value = text;
    clearTimeout(clueTimer);
    clueTimer = setTimeout(flushClues, 300);
    renderSaveState();
  }

  function flushClues() {
    clearTimeout(clueTimer);
    if (!pendingClues.size) return;
    const changes = [...pendingClues].map(([key, v]) => ({ k: `clue:${key}`, v }));
    pendingClues.clear();
    commit(changes, { undoable: false });
    renderSaveState();
  }

  function renderBar(word) {
    barKey = word ? clueKey(word) : null;
    qs('#bar-num').textContent = word ? `${word.num}${word.dir}` : '';
    barInput.disabled = !word;
    barInput.placeholder = word
      ? 'Write this entry’s clue (Enter)'
      : model.isBlack(engine.sel.index)
      ? 'A black square'
      : 'This square isn’t in an entry yet';
    const text = barKey ? pendingClues.get(barKey) ?? doc.clues[barKey] ?? '' : '';
    if (barInput.value !== text) barInput.value = text;
  }

  barInput.addEventListener('input', () => barKey && editClue(barKey, barInput.value));
  barInput.addEventListener('focus', () => {
    typingClue = barKey;
    sendCursor();
  });
  barInput.addEventListener('blur', () => {
    flushClues();
    typingClue = null;
    sendCursor();
  });
  barInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      barInput.blur();
    } else if (e.key === 'Tab') {
      // on to the next entry's clue without leaving the bar
      e.preventDefault();
      flushClues();
      engine.nextClue(e.shiftKey ? -1 : 1);
      typingClue = barKey;
      sendCursor();
      barInput.select();
    }
  });
  qs('#bar-prev').addEventListener('click', () => engine?.nextClue(-1));
  qs('#bar-next').addEventListener('click', () => engine?.nextClue(1));

  // title and byline
  for (const [input, k] of [[titleInput, 'title'], [bylineInput, 'byline']]) {
    let timer = null;
    const send = () => {
      clearTimeout(timer);
      commit([{ k, v: input.value }], { undoable: false });
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(send, 400);
      if (k === 'title') renderTitle(input.value);
    });
    input.addEventListener('blur', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        input.blur();
      }
    });
  }

  function renderTitle(title = doc?.title) {
    document.title = `${(title ?? '').trim() || 'Untitled'} — Puzzle builder`;
  }

  // ----- keyboard -----

  function handleKey(key, { shift = false } = {}) {
    if (!ready || document.querySelector('.overlay')) return false;
    const i = engine.sel.index;
    const onBlock = model.isBlack(i);
    if (/^[a-zA-Z0-9]$/.test(key)) {
      if (onBlock) {
        if (info.shape_locked) return true;
        toggleBlock(i); // un-block it, then type into it
      }
      engine.typeLetter(key);
    } else if (key === '.') {
      toggleBlock(i);
    } else if (key === '*') {
      toggleCircle(i);
    } else if (key === 'Backspace' || key === 'Delete') {
      if (onBlock) toggleBlock(i);
      else if (key === 'Backspace') engine.backspace();
      else engine.deleteKey();
    } else if (key === ' ') {
      if (onBlock) engine.moveArrow(engine.sel.dir === 'A' ? 0 : 1, engine.sel.dir === 'A' ? 1 : 0);
      else engine.space();
    } else if (key === 'ArrowLeft') {
      engine.moveArrow(0, -1);
    } else if (key === 'ArrowRight') {
      engine.moveArrow(0, 1);
    } else if (key === 'ArrowUp') {
      engine.moveArrow(-1, 0);
    } else if (key === 'ArrowDown') {
      engine.moveArrow(1, 0);
    } else if (key === 'Tab') {
      engine.nextClue(shift ? -1 : 1);
    } else if (key === 'Enter') {
      if (barKey) {
        barInput.focus();
        barInput.select();
      }
    } else if (key === 'Escape' || key === 'Insert') {
      openRebus();
    } else {
      return false;
    }
    return true;
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const inField = t.matches?.('input, textarea, select') || t.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (inField || !ready) return;
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) redo();
        else undo();
      }
      return;
    }
    if (e.altKey || inField) return;
    if (handleKey(e.key, { shift: e.shiftKey })) e.preventDefault();
  });

  let rebusOpen = false;
  function openRebus() {
    const i = engine.sel.index;
    if (rebusOpen || model.isBlack(i)) return;
    rebusOpen = true;
    openRebusInput({
      rect: gridView.cellRect(i),
      value: doc.grid[i],
      onCommit: (value) => engine.typeRebus(value),
      onClose: () => (rebusOpen = false),
    });
  }

  if (isTouchDevice()) {
    document.body.classList.add('touch');
    const dock = el('div', { class: 'kb-dock' });
    dock.append(qs('#clue-bar'));
    new TouchKeyboard(dock, { onKey: (key) => handleKey(key) });
    document.body.append(dock);
  }

  // ----- toolbar -----

  qs('#undo-btn').addEventListener('click', () => undo());
  qs('#redo-btn').addEventListener('click', () => redo());
  qs('#block-btn').addEventListener('click', () => setBlockMode(!blockMode));
  qs('#circle-btn').addEventListener('click', () => ready && toggleCircle());
  qs('#rebus-btn').addEventListener('click', () => ready && openRebus());

  makeMenu(qs('#symmetry-btn'), () =>
    SYMMETRIES.map((s) => ({
      label: SYMMETRY_LABELS[s],
      checked: doc?.symmetry === s,
      action: () => commit([{ k: 'symmetry', v: s }], { undoable: false }),
    }))
  );

  makeMenu(qs('#clear-btn'), () => {
    const white = model.cells.filter((c) => !c.isBlack).map((c) => c.index);
    return [
      {
        label: 'Clear this entry’s letters',
        action: () => {
          const word = engine.currentWord();
          if (word) commit(word.cells.map((i) => ({ k: `cell:${i}`, v: '' })));
        },
      },
      {
        label: 'Clear all letters',
        action: () => commit(white.map((i) => ({ k: `cell:${i}`, v: '' }))),
      },
      ...(info.shape_locked
        ? []
        : [
            {
              label: 'Clear the whole grid',
              action: async () => {
                const ok = await confirmDialog(
                  'Clear every letter, black square and circle? Clues stay, and come back with their entries. Undo brings it all back.',
                  { confirmLabel: 'Clear the grid' }
                );
                if (!ok) return;
                commit([
                  ...doc.grid.map((_, i) => ({ k: `cell:${i}`, v: '' })),
                  ...doc.circles.map((_, i) => ({ k: `circle:${i}`, v: 0 })),
                ]);
              },
            },
          ]),
    ];
  });

  qs('#notes-btn').addEventListener('click', () => {
    if (!ready) return;
    const area = el('textarea', { class: 'notes-input', rows: '6', maxlength: '2000' });
    area.value = doc.notes;
    showModal({
      title: 'Notes',
      body: [
        el('p', {}, 'Solvers can read these under ⓘ while they solve: a hint about the theme, a dedication, thanks to a test solver.'),
        area,
      ],
      actions: [
        { label: 'Cancel' },
        { label: 'Save', primary: true, onClick: () => commit([{ k: 'notes', v: area.value }], { undoable: false }) },
      ],
    });
    area.focus();
  });

  makeMenu(qs('#more-btn'), () => {
    if (!ready) return [];
    const creator = info.created_by === me.name;
    return [
      { label: 'Authors…', action: () => openAuthors() },
      ...(info.status !== 'draft'
        ? [
            { label: 'Who can solve it…', action: () => openSharing() },
            { label: 'See how people did', action: () => (location.href = `./analysis.html?puzzle=${encodeURIComponent(id)}`) },
          ]
        : []),
      'hr',
      {
        label: 'Test solve',
        action: () => {
          flushClues();
          window.open(`./puzzle.html?id=${encodeURIComponent(id)}&test=1`, '_blank');
        },
      },
      { label: 'Download .puz', action: () => downloadPuz(docToPuz(doc), puzFileName(doc.title, id)) },
      'hr',
      creator
        ? { label: info.status === 'draft' ? 'Delete this draft…' : 'Delete this puzzle…', action: () => deletePuzzle() }
        : { label: 'Leave this puzzle…', action: () => leave() },
    ];
  });

  qs('#publish-btn').addEventListener('click', () => openPublish());

  // ----- the Check tab -----

  let checkTimer = null;
  let flagTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(renderCheck, 200);
  }

  function renderCheck() {
    if (!doc) return;
    const { blockers, warnings } = problems(doc, model);
    if (noFit.length) {
      const names = noFit.map(entryName);
      warnings.push({
        code: 'no-fit',
        message: `Nothing in the word list fits ${names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : listNames(names)}.`,
        cells: noFit.flatMap((w) => w.cells),
      });
    }
    qs('#check-count').textContent = blockers.length ? String(blockers.length) : '';
    const panel = qs('#check-panel');
    panel.textContent = '';
    const item = (p, kind) =>
      el('button', { class: `problem ${kind}`, type: 'button', onclick: () => showCells(p.cells) }, p.message);
    if (blockers.length) {
      panel.append(el('h3', {}, 'Before you can publish'), ...blockers.map((p) => item(p, 'blocker')));
    } else {
      panel.append(el('p', { class: 'check-ok' }, info?.status === 'draft' ? 'Ready to publish.' : 'Nothing to fix.'));
    }
    if (warnings.length) panel.append(el('h3', {}, 'Worth a look'), ...warnings.map((p) => item(p, 'warning')));
  }

  /** Select a problem's squares and flash them. */
  function showCells(cells) {
    if (!cells?.length) return;
    engine.selectSquare(cells[0]);
    gridView.setCellClass('flagged', cells);
    clearTimeout(flagTimer);
    flagTimer = setTimeout(() => gridView?.setCellClass('flagged', []), 2500);
  }

  function showPanel(name) {
    for (const tab of qsa('.side-tab')) {
      tab.classList.toggle('active', tab.dataset.panel === name);
      tab.setAttribute('aria-selected', String(tab.dataset.panel === name));
    }
    for (const panel of qsa('.side-panel')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'check') renderCheck();
    if (name === 'fill') renderFill();
  }
  for (const tab of qsa('.side-tab')) tab.addEventListener('click', () => showPanel(tab.dataset.panel));

  // ----- words: what fits each entry, and suggestions in the Fill tab -----

  const fillPanel = qs('#fill-panel');
  let noFit = []; // entries with blanks that nothing in the list fits
  let countsTimer = null;
  let countsSeq = 0;
  let fillTimer = null;
  let fillSeq = 0;
  let onlyFits = true;

  /** An entry's squares as a pattern ('C?T'); null if a rebus or digit is in it. */
  function patternOf(word) {
    const parts = word.cells.map((i) => doc.grid[i] || '?');
    return parts.every((p) => /^[A-Z?]$/.test(p)) ? parts.join('') : null;
  }

  function scheduleCounts() {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(refreshCounts, 500);
  }

  async function refreshCounts() {
    if (!model) return;
    const words = model.clueOrder;
    const patterns = words.map((w) => patternOf(w));
    const seq = ++countsSeq;
    let res;
    try {
      res = await api.post('words/counts', { patterns: patterns.map((p) => p ?? '') });
    } catch {
      return;
    }
    if (seq !== countsSeq || !res.ready) {
      if (!res?.ready) setTimeout(scheduleCounts, 3000); // still building
      return;
    }
    // only entries still being filled: a finished one is whatever its authors chose
    const counts = new Map(words.map((w, k) => [clueKey(w), patterns[k]?.includes('?') ? res.counts[k] : null]));
    clueEditor.setCounts(counts);
    noFit = words.filter((w) => counts.get(clueKey(w)) === 0);
    gridView.setCellClass('dead', noFit.flatMap((w) => w.cells.filter((i) => doc.grid[i] === '')));
    scheduleCheck();
  }

  function scheduleFill() {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(renderFill, 150);
  }

  async function renderFill() {
    if (fillPanel.hidden || !engine) return;
    const word = engine.currentWord();
    const note = (text) => el('p', { class: 'fill-note' }, text);
    if (!word) {
      fillPanel.replaceChildren(note('Pick an entry to see the words that fit it.'));
      return;
    }
    const pattern = patternOf(word);
    const head = el('div', { class: 'fill-head' }, [
      el('b', {}, entryName(word)),
      el('span', { class: 'fill-pattern' }, word.cells.map((i) => doc.grid[i] || '·').join(' ')),
    ]);
    if (!pattern) {
      fillPanel.replaceChildren(head, note('Suggestions are for plain letters; this entry has a rebus or a digit in it.'));
      return;
    }
    if (!pattern.includes('?')) {
      fillPanel.replaceChildren(head, note('This entry is full. Clear some squares (or pick another entry) to see what else fits.'));
      return;
    }
    const cross = word.cells.map((i) => {
      if (doc.grid[i] !== '') return null;
      const other = model.wordAt(i, word.dir === 'A' ? 'D' : 'A');
      const p = other && patternOf(other);
      return p ? { pattern: p, at: other.cells.indexOf(i) } : null;
    });
    const seq = ++fillSeq;
    let res;
    try {
      res = await api.post('words/suggest', { pattern, cross: onlyFits ? cross : [], limit: 150 });
    } catch (err) {
      if (seq === fillSeq) fillPanel.replaceChildren(head, note(err.message));
      return;
    }
    if (seq !== fillSeq) return;
    const toggle = el('label', { class: 'fill-only' }, [
      el('input', {
        type: 'checkbox',
        ...(onlyFits ? { checked: true } : {}),
        onchange: (e) => {
          onlyFits = e.target.checked;
          renderFill();
        },
      }),
      'Only words that leave every crossing something to fit',
    ]);
    const parts = [head, toggle];
    if (!res.ready) {
      parts.push(note('The word list is still loading. One moment…'));
      setTimeout(scheduleFill, 2000);
    } else if (!res.words.length) {
      parts.push(
        note(
          onlyFits && res.loose
            ? `${res.loose} word${res.loose === 1 ? ' fits' : 's fit'} here, but none leaves every crossing a word. Try changing a crossing entry.`
            : 'Nothing in the word list fits. That’s fine if it’s your own word; the list doesn’t know everything.'
        )
      );
    } else {
      parts.push(
        el(
          'div',
          { class: 'fill-words' },
          res.words.map(([w, score]) =>
            el(
              'button',
              { class: 'fill-word', type: 'button', title: `Fill in ${w}`, onclick: () => useWord(word, w) },
              [
                el('span', {}, [...w].map((ch, k) => (pattern[k] === '?' ? el('span', { class: 'fw-new' }, ch) : ch))),
                el('span', { class: 'fw-score', style: `--s:${Math.max(0, Math.min(100, score))}`, title: `score ${score}` }),
              ]
            )
          )
        ),
        el(
          'p',
          { class: 'fill-total' },
          `${res.total} word${res.total === 1 ? '' : 's'}${onlyFits && res.loose > res.total ? ` (of ${res.loose} that fit the entry alone)` : ''}${res.total > res.words.length ? `; the best ${res.words.length} shown` : ''}.`
        )
      );
    }
    fillPanel.replaceChildren(...parts);
  }

  /** Fill an entry's blanks with a word (one undoable step). */
  function useWord(word, w) {
    commit(word.cells.map((i, k) => ({ k: `cell:${i}`, v: doc.grid[i] === '' ? w[k] : doc.grid[i] })));
  }

  // ----- co-authors: presence, cursors -----

  let cursorTimer = null;
  function sendCursor() {
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (!engine) return;
      live.sendCursor(typingClue ? { clue: typingClue } : { index: engine.sel.index, dir: engine.sel.dir });
    }, 50);
  }

  function drawRemote(p) {
    const c = p.cursor;
    if (p.conn === live.connId || c?.index == null || c.index >= model.cells.length) {
      gridView.clearRemoteCursor(p.conn);
      return;
    }
    const word = model.wordAt(c.index, c.dir);
    gridView.setRemoteCursor(p.conn, {
      index: c.index,
      cells: word ? word.cells : [],
      color: p.color,
      label: p.user === me.name ? 'you (other tab)' : p.display_name,
    });
  }

  function drawAllRemote() {
    if (!gridView) return;
    gridView.pruneRemoteCursors(new Set(presence.filter((p) => p.conn !== live.connId).map((p) => p.conn)));
    for (const p of presence) drawRemote(p);
    clueEditor.setRemoteMarkers(
      presence
        .filter((p) => p.conn !== live.connId && p.cursor?.clue)
        .map((p) => ({ key: p.cursor.clue, color: p.color, label: p.display_name }))
    );
  }

  const presenceBtn = qs('#presence');
  function authorStates() {
    return info.authors
      .map((a) => ({
        ...a,
        here: presence.some((p) => p.user === a.name),
        who: a.name === me.name ? `${a.display_name} (you)` : a.display_name,
      }))
      .sort((x, y) => Number(y.here) - Number(x.here));
  }

  function renderPresence() {
    presenceBtn.textContent = '';
    presenceBtn.hidden = !info || info.authors.length < 2;
    if (presenceBtn.hidden) return;
    const list = authorStates();
    const max = maxChips();
    const shown = list.length > max ? list.slice(0, max - 1) : list;
    for (const a of shown) {
      presenceBtn.append(
        el(
          'span',
          { class: `presence-chip${a.here ? '' : ' offline'}`, style: `--pc:${a.color}`, title: `${a.who} — ${a.here ? 'here' : 'away'}` },
          (a.display_name || a.name).slice(0, 1)
        )
      );
    }
    if (list.length > shown.length) presenceBtn.append(el('span', { class: 'presence-chip more' }, `+${list.length - shown.length}`));
    presenceBtn.title = `${list.length} authors, ${list.filter((a) => a.here).length} here now`;
    presenceBtn.setAttribute('aria-label', `${presenceBtn.title}. Show everyone.`);
  }

  makeMenu(presenceBtn, () => {
    const list = authorStates();
    return [
      { info: el('div', { class: 'menu-heading' }, `${list.length} authors · ${list.filter((a) => a.here).length} here now`) },
      ...list.map((a) => ({
        info: el('div', { class: 'menu-person' }, [
          el('span', { class: 'user-dot', style: `background:${a.color}` }),
          el('span', { class: 'menu-person-name' }, a.who),
          el('span', { class: `menu-person-status ${a.here ? 'solving' : 'away'}` }, a.here ? 'here' : 'away'),
        ]),
      })),
      'hr',
      { label: 'Authors…', action: () => openAuthors() },
    ];
  });

  // ----- the live connection -----

  const badge = qs('#sync-badge');
  badge.hidden = false;
  live.on('status', (status) => {
    badge.className = `live-dot ${status === 'live' ? 'live' : status === 'offline' ? 'offline' : ''}`;
    badge.textContent = status === 'live' ? 'Live' : status === 'offline' ? 'Reconnecting…' : 'Connecting…';
    badge.title = status === 'live' ? 'Connected — changes save as you make them' : 'Not connected — your changes are kept and sent when the connection returns';
    if (status === 'offline') setTimeout(() => live.status === 'offline' && api.get('me').catch(() => {}), 4000);
    renderSaveState();
  });
  live.on('pending', () => renderSaveState());

  function renderSaveState() {
    const out = qs('#save-state');
    if (live.status === 'offline') out.textContent = 'Offline — changes are kept';
    else if (live.pending.length || pendingClues.size) out.textContent = 'Saving…';
    else out.textContent = ready ? 'Saved' : '';
  }

  live.on('snapshot', (msg, overlay) => {
    doc = msg.doc;
    for (const ch of overlay) applyChange(doc, ch);
    info = msg.puzzle;
    presence = msg.presence;
    const first = !ready;
    ready = true;
    rebuild();
    if (document.activeElement !== titleInput) titleInput.value = doc.title;
    if (document.activeElement !== bylineInput) bylineInput.value = doc.byline;
    renderTitle();
    renderStatus();
    renderPresence();
    renderSaveState();
    flushClues();
    if (first) loadDirectory();
  });

  live.on('presence', (msg) => {
    presence = msg.presence;
    renderPresence();
    drawAllRemote();
  });

  live.on('cursor', (msg) => {
    const p = presence.find((x) => x.conn === msg.conn);
    if (!p) return;
    p.cursor = msg.index != null ? { index: msg.index, dir: msg.dir } : msg.clue ? { clue: msg.clue } : null;
    drawAllRemote();
  });

  live.on('puzzle-state', (msg) => {
    const was = info.status;
    Object.assign(info, {
      status: msg.status,
      visibility: msg.visibility,
      shape_locked: msg.shape_locked,
      changed: msg.changed,
    });
    renderStatus();
    if (msg.by && msg.by !== me.name) {
      if (msg.status === 'published' && was !== 'published') toast(`${nameOf(msg.by)} published the puzzle.`);
      else if (msg.status === 'withdrawn' && was !== 'withdrawn') toast(`${nameOf(msg.by)} withdrew the puzzle.`);
      else if (msg.status === 'published' && !msg.changed) toast(`${nameOf(msg.by)} updated what solvers see.`);
    }
  });

  live.on('authors', (msg) => {
    info.authors = msg.authors;
    if (msg.created_by) info.created_by = msg.created_by;
    renderPresence();
    redrawAuthors?.();
  });

  live.on('deleted', (msg) => {
    live.close();
    showFatal(msg.by && msg.by !== me.name ? `${nameOf(msg.by)} deleted this puzzle.` : 'This puzzle was deleted.');
  });

  live.on('error', (msg) => {
    if (msg.code === 'not-author') {
      live.close();
      showFatal(msg.message);
    } else {
      toast(msg.message, { error: true });
    }
  });

  function renderStatus() {
    const pill = qs('#status-pill');
    pill.textContent =
      info.status === 'published' && info.changed ? 'Published · newer changes not published' : STATUS_LABELS[info.status];
    pill.className = `status-pill ${info.status}${info.changed ? ' changed' : ''}`;
    const publish = qs('#publish-btn');
    publish.disabled = false;
    publish.textContent = info.status === 'draft' ? 'Publish…' : info.status === 'withdrawn' ? 'Republish…' : 'Update…';
    publish.title =
      info.status === 'published' && !info.changed ? 'Solvers already have everything here' : '';
    const block = qs('#block-btn');
    block.disabled = info.shape_locked;
    block.title = info.shape_locked
      ? 'Black squares stay put once a puzzle is published'
      : 'Block mode: tapping a square turns it black or white. Or press . on any square';
    if (info.shape_locked && blockMode) setBlockMode(false);
    scheduleCheck();
  }

  async function loadDirectory() {
    try {
      const { users } = await api.get('users');
      directory = new Map(users.map((u) => [u.name, u]));
    } catch {
      /* names fall back to account names */
    }
    return [...directory.values()];
  }

  // ----- publishing, sharing, authors -----

  /** "Who can solve it?": everyone, or chosen people. */
  async function audiencePicker() {
    let picked = [];
    if (info.visibility === 'people') {
      try {
        picked = (await api.get(`custom-puzzles/${encodeURIComponent(id)}`)).puzzle.shared_with ?? [];
      } catch {
        picked = [];
      }
    }
    const users = (await loadDirectory()).filter((u) => !info.authors.some((a) => a.name === u.name));
    const everyone = el('input', { type: 'radio', name: 'audience', value: 'everyone' });
    const some = el('input', { type: 'radio', name: 'audience', value: 'people' });
    (info.visibility === 'people' ? some : everyone).checked = true;
    const summary = el('span', { class: 'audience-summary' });
    const render = () => {
      summary.textContent = picked.length ? listNames(picked.map(nameOf), 4) : 'nobody picked yet';
    };
    render();
    const choose = el(
      'button',
      {
        class: 'btn btn-quiet',
        type: 'button',
        onclick: async () => {
          const names = await pickPeople({ title: 'Who can solve it?', users, selected: picked, confirmLabel: 'Done' });
          if (!names) return;
          picked = names;
          some.checked = true;
          render();
        },
      },
      'Choose people…'
    );
    const node = el('div', { class: 'audience' }, [
      el('div', { class: 'audience-title' }, 'Who can solve it?'),
      el('label', { class: 'audience-row' }, [everyone, 'Everyone on the site']),
      el('label', { class: 'audience-row' }, [some, el('span', {}, ['Only people I choose: ', summary])]),
      el('div', { class: 'audience-choose' }, choose),
    ]);
    return {
      node,
      value: () => (some.checked ? { visibility: 'people', people: picked } : { visibility: 'everyone' }),
    };
  }

  async function openPublish() {
    if (!ready) return;
    flushClues();
    const { blockers, warnings } = problems(doc, model);
    const first = info.status !== 'published';
    if (blockers.length) {
      showModal({
        title: first ? 'Not quite ready' : 'Can’t update yet',
        body: [el('ul', { class: 'publish-list blockers' }, blockers.map((p) => el('li', {}, p.message)))],
        actions: [
          {
            label: 'Show me',
            primary: true,
            onClick: () => {
              showPanel('check');
              showCells(blockers[0].cells);
            },
          },
        ],
      });
      return;
    }
    const body = [];
    if (warnings.length) {
      body.push(
        el('p', {}, 'Worth a look first, though nothing here stops you:'),
        el('ul', { class: 'publish-list' }, warnings.map((p) => el('li', {}, p.message)))
      );
    }
    const audience = first ? await audiencePicker() : null;
    if (audience) body.push(audience.node);
    else body.push(el('p', {}, 'Solvers get your changes. Anyone who has it open is asked to reload; their progress stays.'));
    if (first) body.push(el('p', { class: 'publish-note' }, 'Once it’s published the black squares stay put; letters and clues can still change.'));
    const close = showModal({
      title: first ? 'Publish your puzzle' : 'Update the puzzle',
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: first ? 'Publish' : 'Update',
          primary: true,
          keepOpen: true,
          onClick: async (e) => {
            const choice = audience?.value() ?? {};
            if (choice.visibility === 'people' && !choice.people.length) {
              toast('Choose at least one person, or pick Everyone.', { error: true });
              return;
            }
            e.target.disabled = true;
            try {
              await api.post(`custom-puzzles/${encodeURIComponent(id)}/publish`, choice);
              close();
              if (first) published(choice);
              else toast('Updated. Solvers get the new version.');
            } catch (err) {
              e.target.disabled = false;
              toast(err.message, { error: true });
            }
          },
        },
      ],
    });
  }

  function published(choice) {
    const link = `${location.origin}/puzzle.html?id=${encodeURIComponent(id)}`;
    const who = choice.visibility === 'people' ? listNames(choice.people.map(nameOf), 4) : 'everyone';
    showModal({
      title: 'Published!',
      body: `It’s on the Custom tab of the archive for ${who}. Solves, times and replays show up on its breakdown page.`,
      actions: [
        {
          label: 'Copy link',
          onClick: () => navigator.clipboard?.writeText(link).then(() => toast('Link copied.')),
        },
        { label: 'Keep editing', primary: true },
      ],
    });
  }

  async function openSharing() {
    const audience = await audiencePicker();
    const close = showModal({
      title: 'Who can solve it?',
      body: [audience.node, el('p', { class: 'publish-note' }, 'People who already started it keep their solve either way.')],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save',
          primary: true,
          keepOpen: true,
          onClick: async () => {
            const choice = audience.value();
            if (choice.visibility === 'people' && !choice.people.length) {
              toast('Choose at least one person, or pick Everyone.', { error: true });
              return;
            }
            try {
              await api.post(`custom-puzzles/${encodeURIComponent(id)}/sharing`, choice);
              close();
              toast('Saved.');
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
      ],
    });
  }

  let redrawAuthors = null;
  function openAuthors() {
    const list = el('div', { class: 'author-list' });
    redrawAuthors = () => {
      const creator = info.created_by === me.name;
      list.textContent = '';
      for (const a of info.authors) {
        list.append(
          el('div', { class: 'author-row' }, [
            el('span', { class: 'user-dot', style: `background:${a.color}` }),
            el('span', { class: 'author-name' }, a.name === me.name ? `${a.display_name} (you)` : a.display_name),
            a.name === info.created_by ? el('span', { class: 'author-note' }, 'started it') : null,
            creator && a.name !== me.name
              ? el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => removeAuthor(a) }, 'Remove')
              : null,
          ])
        );
      }
    };
    redrawAuthors();
    showModal({
      title: 'Authors',
      body: [
        el('p', {}, 'Authors build the puzzle together, live, and any of them can publish it. Authors can’t solve their own puzzle.'),
        list,
      ],
      actions: [
        { label: 'Add co-authors…', keepOpen: true, onClick: () => addAuthors() },
        { label: 'Done', primary: true },
      ],
      onClose: () => (redrawAuthors = null),
    });
  }

  async function addAuthors() {
    const users = (await loadDirectory()).filter((u) => !info.authors.some((a) => a.name === u.name));
    if (!users.length) {
      toast('Everyone is an author already.');
      return;
    }
    const names = await pickPeople({ title: 'Add co-authors', users, confirmLabel: 'Add' });
    if (!names?.length) return;
    try {
      await api.post(`custom-puzzles/${encodeURIComponent(id)}/authors`, { add: names });
      toast(`Added ${listNames(names.map(nameOf), 3)}.`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function removeAuthor(a) {
    if (!(await confirmDialog(`Remove ${a.display_name} as an author? They can be added again later.`, { confirmLabel: 'Remove' }))) return;
    try {
      await api.del(`custom-puzzles/${encodeURIComponent(id)}/authors/${encodeURIComponent(a.name)}`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function leave() {
    const ok = await confirmDialog('Stop being an author of this puzzle? Another author can add you back.', { confirmLabel: 'Leave' });
    if (!ok) return;
    try {
      flushClues();
      await api.del(`custom-puzzles/${encodeURIComponent(id)}/authors/${encodeURIComponent(me.name)}`);
      live.close();
      location.href = './index.html#custom';
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function deletePuzzle() {
    const draft = info.status === 'draft';
    const ok = await confirmDialog(
      draft
        ? 'Delete this draft for good? This can’t be undone.'
        : 'Delete this puzzle? If anyone has opened it, it’s withdrawn instead: they keep their solves and stats, and nobody new can start it.',
      { confirmLabel: 'Delete' }
    );
    if (!ok) return;
    try {
      const result = await api.del(`custom-puzzles/${encodeURIComponent(id)}`);
      if (result.deleted) {
        live.close();
        location.href = './index.html#custom';
      } else {
        toast('People have opened it, so it was withdrawn: they keep their solves, and nobody new can start it.', { ms: 6000 });
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // ----- leaving the page -----

  window.addEventListener('beforeunload', (e) => {
    flushClues();
    if (live.pending.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushClues();
    else live.nudge();
  });
  window.addEventListener('online', () => live.nudge());
  matchMedia('(max-width: 600px)').addEventListener('change', () => ready && renderPresence());

  renderUndo();
  live.connect();
}

function showFatal(message) {
  showModal({
    title: 'Hmm.',
    body: message,
    dismissible: false,
    actions: [{ label: 'Back to puzzles', primary: true, onClick: () => (location.href = './index.html#custom') }],
  });
}

main();
