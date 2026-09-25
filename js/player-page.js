/*
 * player-page.js — controller for puzzle.html. Loads the puzzle, joins the
 * live solve on the server (net.js), wires the engine to the views, and
 * owns the keyboard, toolbar, overlays, timer, presence, and completion.
 *
 * URL: puzzle.html?id=<puzzle>              your solo solve
 *      puzzle.html?id=<puzzle>&solve=<id>   a co-op solve you're in
 */

import { parsePuz } from './puz.js';
import { PuzzleModel } from './model.js';
import { SolveEngine } from './engine.js';
import { GridView } from './grid-view.js';
import { CluesView } from './clues-view.js';
import { Timer } from './timer.js';
import { LiveSolve } from './net.js';
import { api } from './api.js';
import { showModal, confirmDialog, toast } from './modals.js';
import { newProgress, hasAnyFill, fillPercent } from './state.js';
import { tryLoadPuzzle, fetchOnDemand, isFetchable } from './fetch-puzzle.js';
import { loadSettings, saveSettings, SETTING_LABELS } from './settings.js';
import { loadMe } from './profiles.js';
import { initProfileChip } from './profile-ui.js';
import { TouchKeyboard, isTouchDevice } from './touch-keyboard.js';
import {
  el,
  qs,
  formatTime,
  formatDateLong,
  parsePuzzleId,
  themeTitle,
  PUZZLE_TYPE_LABELS,
} from './util.js';

const params = new URLSearchParams(location.search);

const flagsOf = (r) => ({ used_check: !!r.used_check, used_reveal: !!r.used_reveal, autocheck: !!r.autocheck });
const listNames = (names) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

async function main() {
  const me = await loadMe();
  const user = me.name;
  initProfileChip(qs('#profile-chip'));

  // ----- load puzzle -----
  const id = params.get('id');
  const solveParam = params.get('solve');
  if (!id) {
    showFatal('No puzzle specified. Pick one from the archive.');
    return;
  }
  let buffer = await tryLoadPuzzle(id);
  if (!buffer) buffer = await obtainMissingPuzzle(id);
  if (!buffer) return; // obtainMissingPuzzle explained why

  let puz;
  try {
    puz = parsePuz(buffer);
  } catch (err) {
    showFatal(`This puzzle file looks corrupt (${err.message}).`);
    return;
  }

  const model = new PuzzleModel(puz);

  // ----- header text -----
  const idInfo = parsePuzzleId(id);
  const typeLabel = PUZZLE_TYPE_LABELS[idInfo.type] ?? 'The Crossword';
  // Themed puzzles carry a title ("LOST IN TRANSLATION") that clues
  // sometimes point at, so it needs to be on screen while solving.
  const theme = themeTitle(puz.title);
  let dateText;
  if (idInfo.type === 'bonus' && idInfo.date) {
    dateText = new Date(idInfo.date + 'T12:00:00Z').toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } else {
    dateText = idInfo.date ? formatDateLong(idInfo.date) : theme || id;
  }
  qs('.puzzle-title').textContent = typeLabel;
  document.title = [dateText, theme, typeLabel].filter(Boolean).join(' — ');
  qs('#puzzle-date').textContent = dateText;
  const themeEl = qs('#puzzle-theme');
  themeEl.textContent = theme && theme !== dateText ? `“${theme}”` : '';
  qs('#puzzle-byline').textContent = puz.author ? `By ${puz.author}` : '';

  // ----- solve state -----
  // A blank grid until the server's snapshot arrives (a few ms, normally).
  const record = newProgress(model, id, user);
  const settings = loadSettings(user);
  const engine = new SolveEngine(model, record, settings);
  engine.deferCompletion = true; // the server decides when it's solved
  const timer = new Timer(0);
  const live = new LiveSolve({ puzzleId: id, solveId: solveParam });

  let solve = null; // snapshot.solve: {id, kind, puzzle_id, members}
  let presence = []; // [{conn, user, display_name, color, cursor, active}]
  let active = false; // this tab is solving (drives the shared timer)
  let ready = false; // first snapshot applied
  let sentFlags = flagsOf(record);
  const isCoop = () => solve?.kind === 'coop';

  // ----- views -----
  const gridView = new GridView(qs('#board-wrap'), model, {
    onCellClick: (i) => {
      if (ready && !record.completed && !active) resumeGame();
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
    onBarTap: () => engine.toggleDirection(),
  });

  const progressEl = qs('#progress-pct');
  const updateProgress = () => {
    progressEl.textContent = `${fillPercent(record)}%`;
  };

  gridView.updateAll(record);
  cluesView.updateFilled(record);
  updateProgress();

  // keep the clue bar exactly as wide as the board
  new ResizeObserver(() => {
    qs('#clue-bar').style.width = `${gridView.board.offsetWidth}px`;
  }).observe(gridView.board);

  // cursor positions go out at most every 50ms (the last one always does)
  let cursorTimer = null;
  const sendCursor = () => {
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      live.sendCursor(engine.sel.index, engine.sel.dir);
    }, 50);
  };

  engine.on('selection', ({ index, word }) => {
    gridView.setSelection(index, word ? word.cells : []);
    cluesView.setActive(word, engine.crossWord());
    // Shade whatever this clue points at, e.g. "With 23-Down, ..."
    const referenced = model.referencesOf(word);
    gridView.setReferenced(referenced.flatMap((w) => w.cells));
    cluesView.setReferenced(referenced);
    sendCursor();
  });
  engine.on('cells', (indexes, meta) => {
    for (const i of indexes) gridView.updateCell(i, record);
    cluesView.updateFilled(record);
    updateProgress();
    if (!meta.remote) {
      live.sendCells(indexes.map((i) => ({ i, fill: record.fill[i], marks: record.marks[i] })));
    }
  });
  // check / reveal / autocheck change the assist flags
  engine.on('dirty', () => {
    const now = flagsOf(record);
    const diff = {};
    for (const k of Object.keys(now)) if (now[k] !== sentFlags[k]) diff[k] = now[k];
    if (Object.keys(diff).length) {
      live.sendFlags(diff);
      sentFlags = now;
    }
  });
  engine.emitSelection();

  // ----- live connection -----
  const liveBadge = qs('#sync-badge');
  liveBadge.hidden = false;
  liveBadge.className = 'live-dot';
  let sessionCheck = null;
  live.on('status', (status) => {
    liveBadge.className = `live-dot ${status === 'live' ? 'live' : status === 'offline' ? 'offline' : ''}`;
    liveBadge.textContent = status === 'live' ? 'Live' : status === 'offline' ? 'Reconnecting…' : 'Connecting…';
    liveBadge.title =
      status === 'live'
        ? 'Connected — changes save as you type'
        : 'Not connected — your changes are kept and sent when the connection returns';
    if (status === 'offline' && !sessionCheck) {
      // an expired session looks like a dropped socket; api.get sends
      // the visitor to the login page if that's what it is
      sessionCheck = setTimeout(() => api.get('me').catch(() => {}), 4000);
    } else if (status === 'live') {
      clearTimeout(sessionCheck);
      sessionCheck = null;
    }
  });

  live.on('snapshot', (msg, overlay) => {
    const firstTime = !ready;
    const wasCompleted = record.completed;
    solve = msg.solve;
    engine.replaceRecord(msg.record);
    if (overlay.length) engine.applyRemoteCells(overlay);
    sentFlags = flagsOf(record);
    presence = msg.presence;
    applyTimer(msg.timer);
    gridView.setCompleted(record.completed);
    document.body.classList.toggle('solved', record.completed); // hides the touch keyboard
    ready = true;
    renderSolveInfo();
    renderPresence();
    drawAllRemote();
    if (firstTime) loadSolveList();
    if (record.completed) {
      showFinalTime();
      if (!firstTime && !wasCompleted) toast('Solved!');
    } else if (firstTime || msg.reset) {
      // a fresh start (or someone reset the puzzle): wait for Begin
      active = false;
      qs('#timer-btn').title = 'Pause';
      showStartOverlay();
    }
  });
  live.on('cells', (changes) => engine.applyRemoteCells(changes));
  live.on('flags', (msg) => {
    engine.applyRemoteFlags(msg);
    sentFlags = flagsOf(record);
  });
  live.on('cursor', (msg) => {
    const p = presence.find((x) => x.conn === msg.conn);
    if (!p) return;
    p.cursor = { index: msg.index, dir: msg.dir };
    drawRemote(p);
    updateClueMarkers();
  });
  live.on('presence', (msg) => {
    const before = new Set(presence.filter((p) => p.user !== user).map((p) => p.user));
    presence = msg.presence;
    const after = new Set(presence.filter((p) => p.user !== user).map((p) => p.user));
    if (ready && isCoop()) {
      for (const name of after) if (!before.has(name)) toast(`${displayName(name)} joined`);
      for (const name of before) if (!after.has(name)) toast(`${displayName(name)} left`);
    }
    renderPresence();
    drawAllRemote();
    // "Ready to get started?" becomes "Devon is solving" and back
    if (overlayKind === 'start') showStartOverlay();
  });
  live.on('timer', (msg) => applyTimer(msg));
  live.on('paused', (msg) => {
    if (msg.conn === live.connId || record.completed) return;
    active = false;
    showPauseOverlay(`${displayName(msg.by)} paused the game.`);
  });
  live.on('completed', (msg) => {
    timer.pause();
    timer.setElapsed(msg.elapsed);
    engine.markCompleted(msg);
  });
  live.on('members', (msg) => {
    if (solve) solve.members = msg.members;
    renderSolveInfo();
    renderPresence();
  });
  live.on('error', (msg) => {
    if (['not-member', 'no-solve', 'no-puzzle'].includes(msg.code)) {
      live.close();
      showFatal(msg.message);
    } else {
      toast(msg.message, { error: true });
    }
  });

  const displayName = (name) =>
    solve?.members.find((m) => m.name === name)?.display_name ||
    presence.find((p) => p.user === name)?.display_name ||
    name;

  // ----- presence + remote cursors -----
  const presenceEl = qs('#presence');

  function renderPresence() {
    presenceEl.textContent = '';
    if (!isCoop()) return;
    for (const m of solve.members) {
      const conns = presence.filter((p) => p.user === m.name);
      const online = conns.length > 0;
      const solving = conns.some((p) => p.active);
      const who = m.name === user ? `${m.display_name} (you)` : m.display_name;
      presenceEl.append(
        el(
          'span',
          {
            class: `presence-chip${online ? '' : ' offline'}${online && !solving ? ' idle' : ''}`,
            style: `--pc:${m.color}`,
            title: `${who} — ${solving ? 'solving' : online ? 'here, paused' : 'away'}`,
          },
          (m.display_name || m.name).slice(0, 1)
        )
      );
    }
  }

  function drawRemote(p) {
    if (p.conn === live.connId || !p.cursor) {
      gridView.clearRemoteCursor(p.conn);
      return;
    }
    const word = model.wordAt(p.cursor.index, p.cursor.dir);
    gridView.setRemoteCursor(p.conn, {
      index: p.cursor.index,
      cells: word ? word.cells : [],
      color: p.color,
      label: p.user === user ? 'you (other tab)' : p.display_name,
    });
  }

  function drawAllRemote() {
    gridView.pruneRemoteCursors(new Set(presence.filter((p) => p.conn !== live.connId).map((p) => p.conn)));
    for (const p of presence) drawRemote(p);
    updateClueMarkers();
  }

  function updateClueMarkers() {
    const markers = [];
    for (const p of presence) {
      if (p.conn === live.connId || !p.cursor) continue;
      const word = model.wordAt(p.cursor.index, p.cursor.dir);
      if (word) markers.push({ wordId: word.id, color: p.color, label: p.display_name });
    }
    cluesView.setRemoteMarkers(markers);
  }

  // ----- solo / co-op switcher -----
  const solveBtn = qs('#solve-btn');
  let mySolves = [];

  async function loadSolveList() {
    try {
      mySolves = (await api.get(`solves?puzzle=${encodeURIComponent(id)}`)).solves;
    } catch {
      mySolves = [];
    }
  }

  function renderSolveInfo() {
    if (!solve) return;
    const others = solve.members.filter((m) => m.name !== user).map((m) => m.display_name);
    solveBtn.textContent = '';
    solveBtn.append(
      el('span', { class: 'solve-kind' }, isCoop() ? `Co-op with ${listNames(others)}` : 'Solo'),
      ' ▾'
    );
    document.title = [isCoop() ? 'Co-op' : null, dateText, theme, typeLabel].filter(Boolean).join(' — ');
  }

  const solveHref = (s) =>
    `./puzzle.html?id=${encodeURIComponent(id)}${s?.kind === 'coop' ? `&solve=${encodeURIComponent(s.id)}` : ''}`;

  makeMenu(solveBtn, () => {
    const coops = mySolves.filter((s) => s.kind === 'coop');
    const items = [
      { label: 'Solo', checked: !isCoop(), action: () => isCoop() && (location.href = solveHref(null)) },
      ...coops.map((s) => ({
        label: `With ${listNames(s.members.filter((n) => n !== user))} · ${s.completed ? 'solved' : `${s.pct}%`}`,
        checked: solve?.id === s.id,
        action: () => solve?.id !== s.id && (location.href = solveHref(s)),
      })),
      'hr',
      { label: 'New co-op solve…', action: () => openNewCoop() },
    ];
    if (isCoop()) {
      items.push({ label: 'Add people to this solve…', action: () => openAddPeople() });
      items.push({
        label: 'Copy link',
        action: () =>
          navigator.clipboard
            ?.writeText(location.origin + solveHref(solve).slice(1))
            .then(() => toast('Link copied — anyone in this solve can open it.')),
      });
    }
    return items;
  });

  async function pickPeople({ title, exclude, confirmLabel }) {
    let users;
    try {
      users = (await api.get('users')).users.filter((u) => !exclude.has(u.name));
    } catch (err) {
      toast(err.message, { error: true });
      return null;
    }
    if (!users.length) {
      toast('Nobody else to invite — the admin can add accounts.', { error: true });
      return null;
    }
    const chosen = new Set();
    return new Promise((resolve) => {
      let done = false;
      showModal({
        title,
        body: el(
          'div',
          { style: 'text-align:left' },
          users.map((u) =>
            el('label', { style: 'display:flex;gap:10px;align-items:center;padding:6px 0;cursor:pointer;font-size:15px' }, [
              el('input', {
                type: 'checkbox',
                onchange: (e) => (e.target.checked ? chosen.add(u.name) : chosen.delete(u.name)),
              }),
              el('span', { class: 'user-dot', style: `background:${u.color}` }),
              u.display_name,
              u.display_name !== u.name ? el('span', { style: 'color:var(--color-text-muted);font-size:12px' }, u.name) : null,
            ])
          )
        ),
        actions: [
          { label: 'Cancel' },
          {
            label: confirmLabel,
            primary: true,
            onClick: () => {
              done = true;
              resolve([...chosen]);
            },
          },
        ],
        onClose: () => !done && resolve(null),
      });
    });
  }

  async function openNewCoop() {
    const names = await pickPeople({
      title: 'Solve with…',
      exclude: new Set([user]),
      confirmLabel: 'Start co-op solve',
    });
    if (!names?.length) return;
    try {
      const { solve: created } = await api.post('solves', { puzzle_id: id, members: names });
      location.href = solveHref({ ...created, kind: 'coop' });
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  async function openAddPeople() {
    const names = await pickPeople({
      title: 'Add people to this solve',
      exclude: new Set(solve.members.map((m) => m.name)),
      confirmLabel: 'Add',
    });
    if (!names?.length) return;
    try {
      await api.post(`solves/${encodeURIComponent(solve.id)}/members`, { add: names });
      toast(`Added ${listNames(names)}.`);
      loadSolveList();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  // ----- timer + game overlays -----
  const timerDisplay = qs('#timer-display');
  timer.onTick((s) => {
    timerDisplay.textContent = formatTime(s);
  });
  timerDisplay.textContent = formatTime(timer.seconds);
  applyTimerVisibility();

  /** The server owns the clock; this just mirrors it. */
  function applyTimer({ elapsed, running }) {
    timer.pause();
    timer.setElapsed(elapsed);
    if (running) timer.start();
  }

  let gameOverlayClose = null;
  let overlayKind = null; // 'start' | 'pause' while one is up
  const board = gridView.board;
  veil(true); // until the first snapshot

  function veil(on) {
    board.classList.toggle('veiled', on);
  }

  function closeOverlay() {
    gameOverlayClose?.();
    gameOverlayClose = null;
    overlayKind = null;
  }

  function setActive(on) {
    active = on;
    live.setActive(on);
  }

  /** Pause button: in a co-op solve it pauses everyone. */
  function pauseGame() {
    if (record.completed || !active) return;
    active = false;
    if (isCoop()) live.pauseAll();
    else live.setActive(false);
    showPauseOverlay();
  }

  function resumeGame() {
    closeOverlay();
    veil(false);
    if (!record.completed) setActive(true);
  }

  function showPauseOverlay(reason = '') {
    veil(true);
    closeOverlay();
    overlayKind = 'pause';
    gameOverlayClose = showModal({
      title: 'Your game is paused',
      body: [reason, `Current time: ${formatTime(timer.seconds)}`].filter(Boolean).join(' '),
      dismissible: false,
      actions: [{ label: 'Resume', primary: true, onClick: resumeGame }],
    });
  }

  function showStartOverlay() {
    veil(true);
    closeOverlay();
    const solvingNow = [...new Set(presence.filter((p) => p.active && p.user !== user).map((p) => displayName(p.user)))];
    const fresh = !hasAnyFill(record) && Math.floor(timer.seconds) === 0;
    let title;
    let body;
    let label;
    if (solvingNow.length) {
      title = `${listNames(solvingNow)} ${solvingNow.length === 1 ? 'is' : 'are'} solving`;
      body = 'Jump in — everyone’s edits show up live.';
      label = 'Join';
    } else if (fresh) {
      title = 'Ready to get started?';
      body =
        idInfo.date && idInfo.type !== 'bonus'
          ? `The ${formatDateLong(idInfo.date)} ${idInfo.type === 'daily' ? 'crossword' : idInfo.type} awaits.`
          : 'The puzzle awaits.';
      if (isCoop()) body += ` You’re solving with ${listNames(solve.members.filter((m) => m.name !== user).map((m) => m.display_name))}.`;
      label = 'Begin';
    } else {
      title = 'Keep going?';
      body = `You're at ${formatTime(timer.seconds)}. Pick up where you left off.`;
      label = 'Resume';
    }
    overlayKind = 'start';
    gameOverlayClose = showModal({
      title,
      body,
      dismissible: false,
      actions: [{ label, primary: true, onClick: resumeGame }],
    });
  }

  function showFinalTime() {
    closeOverlay();
    veil(false);
    timerDisplay.textContent = formatTime(record.elapsed);
    qs('#timer-btn').title = 'Final time';
  }

  qs('#timer-btn').addEventListener('click', () => {
    if (!ready || record.completed) return;
    if (active) pauseGame();
    else resumeGame();
  });

  // Stepping away stops *your* clock; in co-op, the others keep going.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (active && !record.completed) {
        setActive(false);
        showPauseOverlay();
      }
    } else {
      live.nudge();
    }
  });
  window.addEventListener('online', () => live.nudge());

  // ----- completion -----
  let fullModalOpen = false;
  engine.on('full', ({ solved, clean }) => {
    if (solved) {
      active = false;
      closeOverlay();
      veil(false);
      gridView.setCompleted(true);
      document.body.classList.add('solved');
      showFinalTime();
      if (settings.playSound) playJingle();
      const partners = isCoop() ? solve.members.filter((m) => m.name !== user).map((m) => m.display_name) : [];
      showModal({
        title: 'Congratulations!',
        body: el('div', {}, [
          el('p', {}, partners.length ? `You solved it with ${listNames(partners)}.` : 'You solved the puzzle.'),
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
  // Physical keys and the on-screen keyboard both land here. Returns true
  // if the key did something.
  function handleKey(key, shift = false) {
    if (document.querySelector('.overlay')) return false; // a modal is up
    if (!ready) return false;

    if (/^[a-zA-Z0-9]$/.test(key)) {
      if (!record.completed && !active) resumeGame();
      engine.typeLetter(key);
    } else if (key === 'Backspace') {
      engine.backspace();
    } else if (key === 'Delete') {
      engine.deleteKey();
    } else if (key === ' ') {
      engine.space();
    } else if (key === 'ArrowLeft') {
      engine.moveArrow(0, -1);
    } else if (key === 'ArrowRight') {
      engine.moveArrow(0, 1);
    } else if (key === 'ArrowUp') {
      engine.moveArrow(-1, 0);
    } else if (key === 'ArrowDown') {
      engine.moveArrow(1, 0);
    } else if (key === 'Tab' || key === 'Enter') {
      engine.nextClue(shift ? -1 : 1);
    } else if (key === 'Escape' || key === 'Insert') {
      openRebusInput();
    } else {
      return false;
    }
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.matches?.('input, textarea, select') || t.isContentEditable) return;
    if (handleKey(e.key, e.shiftKey)) e.preventDefault();
  });

  // Phones and tablets: tapping a square can't raise the system keyboard
  // (the grid isn't a text field), so dock our own under the play area,
  // with the current clue just above it.
  if (isTouchDevice()) {
    document.body.classList.add('touch');
    const dock = el('div', { class: 'kb-dock' });
    dock.append(qs('#clue-bar'));
    new TouchKeyboard(dock, { onKey: (key) => handleKey(key) });
    document.body.append(dock);
  }

  // ----- rebus input -----
  let rebusInput = null;
  function openRebusInput() {
    if (!ready || record.completed || rebusInput) return;
    if (engine.isLocked(engine.sel.index)) return;
    if (!active) resumeGame();
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
        const msg = isCoop()
          ? 'Clear every entry — everyone’s? The timer keeps running.'
          : 'Clear all your entries? The timer keeps running.';
        if (await confirmDialog(msg, { confirmLabel: 'Clear puzzle' })) {
          engine.clearPuzzle();
        }
      },
    },
    'hr',
    {
      label: 'Reset puzzle & timer…',
      action: async () => {
        const msg = isCoop()
          ? 'Erase this co-op solve for everyone, including the timer? This cannot be undone.'
          : 'Erase all progress on this puzzle, including the timer? This cannot be undone. Your first solve stays in your stats.';
        if (await confirmDialog(msg, { confirmLabel: 'Reset everything' })) {
          active = false;
          live.reset();
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

  live.connect();
}

/* ---------- helpers ---------- */

/**
 * The archive doesn't have this puzzle. If it's something NYT published,
 * have the server download it; otherwise explain why it can't be had.
 * Returns the bytes, or null after showing a message of its own.
 */
async function obtainMissingPuzzle(id) {
  const { type, date } = parsePuzzleId(id);
  const pretty = date ? formatDateLong(date) : id;

  if (!isFetchable(id)) {
    showFatal(
      date
        ? `The ${PUZZLE_TYPE_LABELS[type] ?? 'puzzle'} for ${pretty} isn't in the archive, and NYT doesn't have one for that date.`
        : `“${id}” isn't in the archive.`
    );
    return null;
  }

  const closeWaiting = showModal({
    title: 'Fetching this puzzle',
    body: el('div', {}, [
      el('p', {}, `${pretty} isn’t in the archive yet, so it’s being downloaded now.`),
      el('p', { style: 'font-size:12px;color:var(--color-text-muted)' }, 'This usually takes a few seconds.'),
    ]),
    dismissible: false,
  });
  const result = await fetchOnDemand(id);
  closeWaiting();

  if (result.ok) {
    if (result.id !== id) {
      // a monthly bonus that ran on another day than the 1st
      const url = new URL(location.href);
      url.searchParams.set('id', result.id);
      location.replace(url);
      return null;
    }
    return result.buffer;
  }
  showFatal(
    result.reason === 'missing'
      ? result.message || `NYT doesn’t have a ${type} puzzle for ${pretty}.`
      : `Something went wrong fetching it. ${result.message ?? ''}`.trim()
  );
  return null;
}

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
