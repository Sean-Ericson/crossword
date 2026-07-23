/*
 * player-page.js — controller for puzzle.html. Loads the puzzle, wires the
 * engine to the views, and owns the keyboard, toolbar, overlays, timer,
 * autosave, and completion flows.
 */

import { parsePuz } from './puz.js';
import { PuzzleModel } from './model.js';
import { SolveEngine } from './engine.js';
import { GridView } from './grid-view.js';
import { CluesView } from './clues-view.js';
import { Timer } from './timer.js';
import { showModal, confirmDialog, toast } from './modals.js';
import {
  newProgress,
  loadLocal,
  saveLocal,
  recordFitsModel,
  hasAnyFill,
  mergeProgress,
  addSolveLocal,
  solveEntryFrom,
} from './state.js';
import { Sync } from './sync.js';
import { initSyncBadge } from './sync-ui.js';
import { loadSettings, saveSettings, SETTING_LABELS } from './settings.js';
import { getActiveUser } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import {
  el,
  qs,
  debounce,
  formatTime,
  formatDateLong,
  dateFromId,
} from './util.js';

const params = new URLSearchParams(location.search);
const user = getActiveUser();

async function main() {
  // ----- load puzzle -----
  const fileParam = params.get('file');
  const id = params.get('id') || (fileParam ? fileParam.replace(/.*\//, '').replace(/\.puz$/i, '') : null);
  if (!id) {
    showFatal('No puzzle specified. Pick one from the archive.');
    return;
  }
  const url = fileParam || `./puzzles/${id}.puz`;

  let puz;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    puz = parsePuz(await resp.arrayBuffer());
  } catch (err) {
    showFatal(`Couldn't load this puzzle (${err.message}).`);
    return;
  }

  const model = new PuzzleModel(puz);

  // ----- header text -----
  document.title = `${dateFromId(id) ? formatDateLong(id) : puz.title || id} — Crossword`;
  qs('#puzzle-date').textContent = dateFromId(id) ? formatDateLong(id) : puz.title || id;
  qs('#puzzle-byline').textContent = puz.author ? `By ${puz.author}` : '';
  initProfileChip(qs('#profile-chip'));

  // ----- progress record -----
  let record = loadLocal(user, id);
  if (!recordFitsModel(record, model)) record = newProgress(model, id, user);

  const settings = loadSettings(user);
  const engine = new SolveEngine(model, record, settings);
  const timer = new Timer(record.elapsed || 0);

  // ----- views -----
  const gridView = new GridView(qs('#board-wrap'), model, {
    onCellClick: (i) => {
      if (!record.completed && !timer.running) resumeGame();
      engine.clickCell(i);
    },
  });
  const cluesView = new CluesView({
    acrossEl: qs('#across-list'),
    downEl: qs('#down-list'),
    barEl: qs('#clue-bar'),
    model,
    onSelectWord: (word) => engine.selectWord(word),
    onBarNav: (delta) => engine.nextClue(delta),
  });

  gridView.updateAll(record);
  cluesView.updateFilled(record);
  gridView.setCompleted(record.completed);

  // keep the clue bar exactly as wide as the board
  new ResizeObserver(() => {
    qs('#clue-bar').style.width = `${gridView.board.offsetWidth}px`;
  }).observe(gridView.board);

  engine.on('selection', ({ index, word }) => {
    gridView.setSelection(index, word ? word.cells : []);
    cluesView.setActive(word, engine.crossWord());
  });
  engine.on('cells', (indexes) => {
    for (const i of indexes) gridView.updateCell(i, record);
    cluesView.updateFilled(record);
  });
  engine.emitSelection();

  // ----- autosave -----
  // Only persist once this session has actually touched the puzzle;
  // otherwise a pristine tab could clobber real progress on pagehide.
  let dirtySinceLoad = false;
  let remoteDirty = false;
  const persist = () => {
    if (!record.completed) record.elapsed = timer.seconds;
    saveLocal(record);
  };
  const autosave = debounce(persist, 800);
  engine.on('dirty', () => {
    dirtySinceLoad = true;
    remoteDirty = true;
    autosave();
  });

  // ----- GitHub sync -----
  const sync = new Sync(user);
  initSyncBadge(qs('#sync-badge'), sync, { onSyncNow: () => pushRemote({ force: true }) });

  /** Mutate `record` in place to match a merge winner and re-render. */
  function applyRemote(winner) {
    Object.assign(record, winner, {
      fill: [...winner.fill],
      marks: [...winner.marks],
    });
    gridView.updateAll(record);
    cluesView.updateFilled(record);
    timer.setElapsed(record.elapsed || 0);
    saveLocal(record);
    engine.emitSelection();
    if (record.completed) {
      gridView.setCompleted(true);
      timer.pause();
      if (gameOverlayClose) {
        gameOverlayClose();
        gameOverlayClose = null;
        veil(false);
      }
    } else if (gameOverlayClose) {
      // refresh the begin/resume overlay so its time/text match
      gameOverlayClose();
      showStartOverlay();
    }
  }

  function pushRemote({ keepalive = false, force = false } = {}) {
    if (!sync.active) return;
    if (!force && (!remoteDirty || !dirtySinceLoad)) return;
    persist();
    remoteDirty = false;
    sync.pushProgress(record, { keepalive }).then((remoteRecord) => {
      if (remoteRecord !== record) applyRemote(remoteRecord);
    });
  }

  if (sync.active) {
    sync.ensureProfile();
    sync.pullProgress(id).then((remote) => {
      if (!remote || !recordFitsModel(remote, model)) return;
      const winner = mergeProgress(record, remote);
      if (winner !== record) applyRemote(winner);
    });
    setInterval(() => {
      if (timer.running) pushRemote();
    }, 120000);
  }

  // ----- timer + game overlays -----
  const timerDisplay = qs('#timer-display');
  timer.onTick((s) => {
    timerDisplay.textContent = formatTime(s);
  });
  timerDisplay.textContent = formatTime(timer.seconds);
  applyTimerVisibility();

  let gameOverlayClose = null;
  const board = gridView.board;

  function veil(on) {
    board.classList.toggle('veiled', on);
  }

  function pauseGame() {
    if (record.completed || !timer.running) return;
    timer.pause();
    persist();
    pushRemote();
    showPauseOverlay();
  }

  function resumeGame() {
    gameOverlayClose?.();
    gameOverlayClose = null;
    veil(false);
    if (!record.completed) {
      timer.start();
      dirtySinceLoad = true; // elapsed time is progress worth saving
    }
  }

  function showPauseOverlay() {
    veil(true);
    gameOverlayClose?.();
    gameOverlayClose = showModal({
      title: 'Your game is paused',
      body: `Current time: ${formatTime(timer.seconds)}`,
      dismissible: false,
      actions: [{ label: 'Resume', primary: true, onClick: resumeGame }],
    });
  }

  function showStartOverlay() {
    veil(true);
    const fresh = !hasAnyFill(record) && record.elapsed === 0;
    gameOverlayClose = showModal({
      title: fresh ? 'Ready to get started?' : 'Keep going?',
      body: fresh
        ? dateFromId(id)
          ? `The ${formatDateLong(id)} crossword awaits.`
          : 'The crossword awaits.'
        : `You're at ${formatTime(record.elapsed)}. Pick up where you left off.`,
      dismissible: false,
      actions: [{ label: fresh ? 'Begin' : 'Resume', primary: true, onClick: resumeGame }],
    });
  }

  qs('#timer-btn').addEventListener('click', () => {
    if (record.completed) return;
    if (timer.running) pauseGame();
    else resumeGame();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (timer.running) pauseGame();
      autosave.flush();
      pushRemote({ keepalive: true });
    }
  });
  window.addEventListener('pagehide', () => {
    if (dirtySinceLoad) {
      persist();
      pushRemote({ keepalive: true });
    }
  });

  if (record.completed) {
    timerDisplay.textContent = formatTime(record.elapsed);
    qs('#timer-btn').title = 'Final time';
  } else {
    showStartOverlay();
  }

  // ----- completion -----
  let fullModalOpen = false;
  engine.on('full', ({ solved, clean }) => {
    if (solved) {
      timer.pause();
      record.elapsed = timer.seconds;
      persist();
      gridView.setCompleted(true);
      // record the solve in the local stats log and sync everything up
      const statsDoc = addSolveLocal(user, id, solveEntryFrom(record));
      if (sync.active) {
        sync.pushProgress(record);
        sync.pushStats(statsDoc);
        remoteDirty = false;
      }
      if (settings.playSound) playJingle();
      showModal({
        title: 'Congratulations!',
        body: el('div', {}, [
          el('p', {}, 'You solved the puzzle.'),
          el('div', { class: 'solve-time' }, formatTime(record.elapsed)),
          clean ? el('div', { class: 'gold-star' }, '★ Clean solve') : null,
        ]),
        actions: [
          { label: 'Back to archive', onClick: () => (location.href = './index.html') },
          { label: 'Admire the puzzle', primary: true },
        ],
      });
    } else if (!fullModalOpen) {
      fullModalOpen = true;
      showModal({
        title: 'Not quite.',
        body: 'The puzzle is filled, but at least one square is incorrect. Keep trying!',
        actions: [{ label: 'Keep trying', primary: true }],
        onClose: () => {
          fullModalOpen = false;
        },
      });
    }
  });

  // ----- keyboard -----
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.matches?.('input, textarea, select') || t.isContentEditable) return;
    if (document.querySelector('.overlay')) return; // a modal is up

    if (/^[a-zA-Z0-9]$/.test(e.key)) {
      e.preventDefault();
      if (!record.completed && !timer.running) resumeGame();
      engine.typeLetter(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      engine.backspace();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      engine.deleteKey();
    } else if (e.key === ' ') {
      e.preventDefault();
      engine.space();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      engine.moveArrow(0, -1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      engine.moveArrow(0, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      engine.moveArrow(-1, 0);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      engine.moveArrow(1, 0);
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      engine.nextClue(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' || e.key === 'Insert') {
      e.preventDefault();
      openRebusInput();
    }
  });

  // ----- rebus input -----
  let rebusInput = null;
  function openRebusInput() {
    if (record.completed || rebusInput) return;
    if (engine.isLocked(engine.sel.index)) return;
    if (!timer.running) resumeGame();
    const i = engine.sel.index;
    const rect = gridView.cellRect(i);
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
    input.value = record.fill[i] || '';
    let cancelled = false;
    const closeRebus = (commit) => {
      if (!rebusInput) return;
      const value = input.value;
      rebusInput = null;
      input.remove();
      if (commit) engine.typeRebus(value);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        closeRebus(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelled = true;
        closeRebus(false);
      }
    });
    input.addEventListener('blur', () => closeRebus(!cancelled));
    document.body.append(input);
    rebusInput = input;
    input.focus();
    input.select();
  }
  qs('#rebus-btn').addEventListener('click', () => openRebusInput());

  // ----- toolbar: pencil, menus, info, settings -----
  const pencilBtn = qs('#pencil-btn');
  pencilBtn.addEventListener('click', () => {
    engine.setPencil(!engine.pencil);
    pencilBtn.classList.toggle('on', engine.pencil);
  });

  makeMenu(qs('#clear-btn'), () => [
    { label: 'Clear word', action: () => engine.clearWord() },
    {
      label: 'Clear puzzle',
      action: async () => {
        if (await confirmDialog('Clear all your entries? The timer keeps running.', { confirmLabel: 'Clear puzzle' })) {
          engine.clearPuzzle();
        }
      },
    },
    'hr',
    {
      label: 'Reset puzzle & timer…',
      action: async () => {
        if (
          await confirmDialog('Erase all progress on this puzzle, including the timer? This cannot be undone.', {
            confirmLabel: 'Reset everything',
          })
        ) {
          localStorage.removeItem(`xw:${user}:progress:${id}`);
          location.reload();
        }
      },
    },
  ]);

  makeMenu(qs('#check-btn'), () => [
    {
      label: 'Autocheck',
      checked: record.autocheck,
      action: () => engine.setAutocheck(!record.autocheck),
    },
    'hr',
    { label: 'Check letter', action: () => engine.check('letter') },
    { label: 'Check word', action: () => engine.check('word') },
    { label: 'Check puzzle', action: () => engine.check('puzzle') },
  ]);

  makeMenu(qs('#reveal-btn'), () => [
    { label: 'Reveal letter', action: () => engine.reveal('letter') },
    { label: 'Reveal word', action: () => engine.reveal('word') },
    {
      label: 'Reveal puzzle',
      action: async () => {
        if (await confirmDialog('Reveal the entire puzzle? You will lose the clean-solve star.', { confirmLabel: 'Reveal all' })) {
          engine.reveal('puzzle');
        }
      },
    },
  ]);

  if (puz.notes) {
    const infoBtn = qs('#info-btn');
    infoBtn.hidden = false;
    infoBtn.addEventListener('click', () =>
      showModal({ title: puz.title || 'Puzzle notes', body: puz.notes })
    );
  }

  qs('#settings-btn').addEventListener('click', () => {
    const SHORTCUTS = [
      ['Type', 'fill square, advance'],
      ['Arrows', 'move · perpendicular arrow switches direction'],
      ['Click twice', 'switch direction'],
      ['Tab / Enter', 'next clue (Shift+Tab: previous)'],
      ['Backspace', 'clear square, walk backward'],
      ['Space', 'clear square, step forward'],
      ['Esc or Insert', 'rebus entry (multiple letters)'],
    ];
    const body = el('div', { style: 'text-align:left' }, [
      ...SETTING_LABELS.map(([key, label]) =>
        el('label', { style: 'display:flex;gap:10px;align-items:center;padding:6px 0;cursor:pointer' }, [
          el('input', {
            type: 'checkbox',
            ...(settings[key] ? { checked: true } : {}),
            onchange: (e) => {
              settings[key] = e.target.checked;
              saveSettings(user, settings);
              applyTimerVisibility();
            },
          }),
          label,
        ])
      ),
      el('h3', { style: 'font-size:14px;margin:16px 0 6px' }, 'Keyboard'),
      el(
        'div',
        { style: 'font-size:13px;color:var(--color-text-muted);line-height:1.7' },
        SHORTCUTS.map(([keys, what]) =>
          el('div', {}, [el('b', { style: 'color:var(--color-text)' }, keys + ' — '), what])
        )
      ),
    ]);
    showModal({ title: 'Settings', body });
  });

  function applyTimerVisibility() {
    timerDisplay.style.display = settings.showTimer ? '' : 'none';
  }

  if (puz.scrambled) {
    toast('This puzzle has a locked solution — check and reveal are unavailable.', { ms: 5000 });
    qs('#check-btn').disabled = true;
    qs('#reveal-btn').disabled = true;
  }
}

/* ---------- helpers ---------- */

function showFatal(message) {
  showModal({
    title: 'Hmm.',
    body: message,
    dismissible: false,
    actions: [{ label: 'Back to archive', primary: true, onClick: () => (location.href = './index.html') }],
  });
}

/** Dropdown menu on a toolbar button; items provided lazily each open. */
function makeMenu(button, getItems) {
  let panel = null;
  const close = () => {
    panel?.remove();
    panel = null;
    document.removeEventListener('mousedown', onOutside, true);
  };
  const onOutside = (e) => {
    if (panel && !panel.contains(e.target) && e.target !== button) close();
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
    document.addEventListener('mousedown', onOutside, true);
  });
}

/** Short completion jingle via WebAudio. */
function playJingle() {
  try {
    const ctx = new AudioContext();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, k) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + k * 0.12;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
  } catch {
    /* no audio available */
  }
}

main();
