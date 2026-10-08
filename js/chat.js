/*
 * chat.js — messages between the people in a co-op solve (player-page.js)
 * or a custom puzzle's authors (builder-page.js). The toolbar's chat button
 * opens a panel; while it's closed, new messages show an unread count on
 * the button (and in the tab's title) and pop up briefly in a corner.
 *
 * Works on any LiveChannel (net.js documents the messages; server/chat.mjs
 * stores them). The page hands it each snapshot (load) once its own state
 * is in place, and says whether there's anyone to talk to (setAvailable). A message names an entry like "12A" or "34-Down"; it
 * becomes a link that selects that entry.
 *
 * What's been read is remembered per browser (localStorage), by solve or
 * puzzle; reading it on another device doesn't clear it here.
 */

import { el } from './util.js';
import { listNames } from './people.js';

const REF_RE = /\b(\d{1,3})(?:-?([ad])|[\s-]?(across|down))\b/gi;
const GROUP_MS = 5 * 60_000; // one sender's messages this close together share a heading
const PEEK_MS = 6000;
const SEEN_KEY = (room) => `xw:chat-seen:${room}`;
const OPEN_KEY = 'xw:chat-open';

/**
 * Split a message into plain text and entry references.
 * "is 12a right?" -> ['is ', {num:12, dir:'A', text:'12a'}, ' right?']
 * @returns {Array<string|{num:number, dir:'A'|'D', text:string}>}
 */
export function chatSegments(text) {
  text = String(text);
  const out = [];
  let at = 0;
  for (const m of text.matchAll(REF_RE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const dir = (m[2] ?? m[3]).toLowerCase().startsWith('a') ? 'A' : 'D';
    out.push({ num: Number(m[1]), dir, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private window: nothing is remembered */
  }
}

const dayOf = (ms) => new Date(ms).toDateString();
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

const narrow = () => matchMedia('(max-width: 600px)').matches;
const touch = () => document.body.classList.contains('touch');

export class ChatPanel {
  /**
   * @param {{
   *   channel: import('./net.js').LiveSolve|import('./net.js').LiveBuild,
   *   button: HTMLButtonElement,     the toolbar's chat button (starts hidden)
   *   me: string,                    the signed-in account's name
   *   people: () => Array<{name:string, display_name:string, color:string}>,
   *                                  everyone in the solve, or every author,
   *                                  with their colors here
   *   personOf?: (name: string) => {display_name?:string, color?:string}|null|undefined,
   *                                  someone who isn't any more (a former author)
   *   entry?: (num: number, dir: 'A'|'D') => object|null|undefined,
   *                                  the puzzle's word with that number, if any
   *   onEntry?: (word: object) => void,
   *                                  a reference was clicked
   * }} opts
   */
  constructor({ channel, button, me, people, personOf = () => null, entry = () => null, onEntry = () => {} }) {
    this.channel = channel;
    this.button = button;
    this.me = me;
    this.people = people;
    this.personOf = personOf;
    this.entry = entry;
    this.onEntry = onEntry;
    this.messages = []; // from the server, oldest first
    this.room = null; // 'solve:<id>' | 'build:<id>', for the read marker
    this.seen = 0; // newest message id read here
    this.unread = 0;
    this.available = false;
    this.isOpen = false;
    this.last = null; // the newest message drawn, for grouping

    this.badge = el('span', { class: 'chat-unread', hidden: true });
    button.append(this.badge);
    button.addEventListener('click', () => this.toggle());

    this.whoEl = el('span', { class: 'chat-who' });
    this.listEl = el('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
    this.pendingEl = el('div', { class: 'chat-pending' });
    this.input = el('textarea', {
      class: 'chat-input',
      rows: 1,
      maxlength: 1000,
      'aria-label': 'Message',
      autocomplete: 'off',
      enterkeyhint: 'send',
      oninput: () => this.autosize(),
      onkeydown: (e) => this.onKey(e),
    });
    this.panel = el('section', { class: 'chat-panel', 'aria-label': 'Messages', hidden: true }, [
      el('div', { class: 'chat-head' }, [
        el('div', { class: 'chat-head-text' }, [el('span', { class: 'chat-title' }, 'Messages'), this.whoEl]),
        el('button', { class: 'chat-close', type: 'button', 'aria-label': 'Close messages', title: 'Close (Esc)', onclick: () => this.close() }, '×'),
      ]),
      this.listEl,
      el('form', { class: 'chat-form', onsubmit: (e) => (e.preventDefault(), this.send()) }, [
        this.input,
        el('button', { class: 'btn btn-primary chat-send', type: 'submit' }, 'Send'),
      ]),
    ]);
    this.listEl.append(this.pendingEl);
    this.peeks = el('div', { class: 'chat-peeks', 'aria-hidden': 'true' });
    document.body.append(this.panel, this.peeks);

    channel.on('chat', (m) => this.receive(m));
    channel.on('chat-out', () => this.renderPending());
    channel.on('status', () => this.renderPending());
    channel.on('chat-failed', (out) => {
      // nothing lost: it goes back in the box, unless something new is there
      if (!this.input.value.trim()) {
        this.input.value = out.text;
        this.autosize();
      }
      this.renderPending();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isOpen) this.markSeen();
    });
    // the tab title says "(2) …" while there are unread messages; pages
    // rename the tab now and then, so put it back when they do
    this.titleWatch = new MutationObserver(() => this.renderTitle());
    if (document.querySelector('title')) this.titleWatch.observe(document.querySelector('title'), { childList: true });
    this.fitKeyboard();
  }

  // ---------- page-facing ----------

  /** Is there anyone to talk to here (a co-op solve, two or more authors)? */
  setAvailable(on) {
    on = !!on;
    if (on === this.available) return;
    this.available = on;
    this.button.hidden = !on;
    if (!on) this.close({ remember: false });
    else if (storageGet(OPEN_KEY) === '1' && !narrow() && !touch()) this.open({ focus: false });
    this.renderUnread();
  }

  /** The people changed (someone was added): names, colors, the heading. */
  refreshPeople() {
    this.renderWho();
    this.renderAll();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open({ focus = true } = {}) {
    if (!this.available) return;
    this.isOpen = true;
    this.panel.hidden = false;
    this.button.classList.add('on');
    this.button.setAttribute('aria-expanded', 'true');
    document.body.classList.add('chat-open');
    this.peeks.textContent = '';
    storageSet(OPEN_KEY, '1');
    this.renderWho();
    this.fitKeyboard();
    this.scrollToEnd();
    this.markSeen();
    // on a phone, typing raises its keyboard over half the screen; wait to be asked
    if (focus && !touch()) this.input.focus();
  }

  close({ remember = true } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.button.classList.remove('on');
    this.button.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('chat-open');
    if (remember) storageSet(OPEN_KEY, null);
    if (this.panel.contains(document.activeElement)) document.activeElement.blur();
  }

  // ---------- messages ----------

  /** A snapshot arrived: the conversation so far (none in a solo solve). */
  load(msg) {
    if (!msg.chat) return;
    const room = msg.solve?.id ? `solve:${msg.solve.id}` : msg.puzzle?.id ? `build:${msg.puzzle.id}` : null;
    if (room !== this.room) {
      this.room = room;
      this.seen = Number(storageGet(SEEN_KEY(room))) || 0;
    }
    this.messages = msg.chat.slice();
    this.renderWho();
    this.renderAll();
    if (this.isOpen && !document.hidden) this.markSeen();
    else this.countUnread();
  }

  receive(m) {
    if (!m || this.messages.some((x) => x.id === m.id)) {
      this.renderPending(); // our own resend coming back
      return;
    }
    const stick = this.nearEnd();
    this.messages.push(m);
    this.listEl.querySelector('.chat-empty')?.remove();
    this.pendingEl.before(...this.messageNodes(m));
    this.renderPending();
    if (stick || m.user === this.me) this.scrollToEnd();
    if (this.isOpen && !document.hidden) {
      this.markSeen();
    } else if (m.user !== this.me) {
      this.countUnread();
      this.peek(m);
    }
  }

  send() {
    const text = this.input.value.trim();
    if (!text) return;
    this.channel.sendChat(text);
    this.input.value = '';
    this.autosize();
    this.renderPending();
    this.scrollToEnd();
    this.markSeen();
  }

  onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  // ---------- read / unread ----------

  markSeen() {
    const newest = this.messages.at(-1)?.id ?? 0;
    if (newest > this.seen) {
      this.seen = newest;
      if (this.room) storageSet(SEEN_KEY(this.room), String(newest));
    }
    this.countUnread();
  }

  countUnread() {
    this.unread = this.messages.filter((m) => m.id > this.seen && m.user !== this.me).length;
    this.renderUnread();
  }

  renderUnread() {
    const n = this.available ? this.unread : 0;
    this.badge.hidden = !n;
    this.badge.textContent = n > 9 ? '9+' : String(n);
    const label = n ? `Messages, ${n} unread` : 'Messages';
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
    this.renderTitle();
  }

  renderTitle() {
    const n = this.available ? this.unread : 0;
    const base = document.title.replace(/^\(\d+\+?\) /, '');
    const want = n ? `(${n > 9 ? '9+' : n}) ${base}` : base;
    if (document.title !== want) document.title = want;
  }

  // ---------- drawing ----------

  person(name) {
    if (name == null) return { display_name: 'Former member', color: 'var(--color-text-faint)' };
    const p = this.people().find((x) => x.name === name) ?? this.personOf(name) ?? {};
    return { display_name: p.display_name || name, color: p.color || 'var(--color-text-faint)' };
  }

  renderWho() {
    const others = this.people().filter((p) => p.name !== this.me);
    const names = others.map((p) => p.display_name || p.name);
    this.whoEl.textContent = names.length ? `with ${listNames(names, 3)}` : '';
    this.input.placeholder = names.length === 1 ? `Message ${names[0]}` : 'Message everyone';
  }

  renderAll() {
    const stick = this.nearEnd();
    this.listEl.textContent = '';
    this.last = null;
    if (!this.messages.length) {
      this.listEl.append(
        el('p', { class: 'chat-empty' }, [
          'No messages yet. Name an entry, like ',
          el('b', {}, '12A'),
          ' or ',
          el('b', {}, '34-Down'),
          ', and it becomes a link to it.',
        ])
      );
    }
    for (const m of this.messages) this.listEl.append(...this.messageNodes(m));
    this.listEl.append(this.pendingEl);
    this.renderPending();
    if (stick) this.scrollToEnd();
  }

  /** A message, after a date line if it's the first of its day. */
  messageNodes(m) {
    const nodes = [];
    const day = dayOf(m.at);
    if (day !== this.last?.day) nodes.push(el('div', { class: 'chat-day' }, dayLabel(m.at)));
    const grouped = this.last && this.last.day === day && this.last.user === m.user && m.at - this.last.at < GROUP_MS;
    const mine = m.user === this.me;
    const who = this.person(m.user);
    const when = el('time', { datetime: new Date(m.at).toISOString(), title: new Date(m.at).toLocaleString() }, clock(m.at));
    nodes.push(
      el('div', { class: `chat-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}` }, [
        grouped
          ? null
          : el('div', { class: 'chat-meta' }, [
              mine ? null : el('span', { class: 'user-dot', style: `background:${who.color}` }),
              mine ? null : el('span', { class: 'chat-name' }, who.display_name),
              when,
            ]),
        el('div', { class: 'chat-text', dir: 'auto', title: grouped ? when.title : null }, this.textNodes(m.text)),
      ])
    );
    this.last = { day, user: m.user, at: m.at };
    return nodes;
  }

  /** Text with entry references as links (only to entries this puzzle has). */
  textNodes(text) {
    return chatSegments(text).map((seg) => {
      if (typeof seg === 'string' || !this.entry(seg.num, seg.dir)) return seg.text ?? seg;
      return el(
        'button',
        {
          type: 'button',
          class: 'chat-ref',
          title: `Go to ${seg.num}-${seg.dir === 'A' ? 'Across' : 'Down'}`,
          onclick: () => {
            // looked up now: a builder's grid may have been renumbered since
            const word = this.entry(seg.num, seg.dir);
            if (word) this.onEntry(word);
            if (narrow()) this.close(); // the panel covers the grid
          },
        },
        seg.text
      );
    });
  }

  /** Messages of ours that haven't come back from the server yet. */
  renderPending() {
    this.pendingEl.textContent = '';
    const status = this.channel.live ? 'Sending…' : 'Not sent yet — waiting for the connection';
    for (const out of this.channel.chatOut ?? []) {
      this.pendingEl.append(
        el('div', { class: 'chat-msg mine pending' }, [
          el('div', { class: 'chat-text', dir: 'auto' }, out.text),
          el('div', { class: 'chat-status' }, status),
        ])
      );
    }
  }

  /** A new message while the panel is closed: show it for a moment. */
  peek(m) {
    if (document.hidden) return; // the count waits for them
    const who = this.person(m.user);
    const text = m.text.length > 140 ? `${m.text.slice(0, 140).trimEnd()}…` : m.text;
    const node = el(
      'button',
      {
        type: 'button',
        class: 'chat-peek',
        onclick: () => {
          node.remove();
          this.open();
        },
      },
      [
        el('span', { class: 'user-dot', style: `background:${who.color}` }),
        el('span', { class: 'chat-peek-body' }, [el('b', {}, who.display_name), ' ', el('span', { dir: 'auto' }, text)]),
      ]
    );
    this.peeks.append(node);
    while (this.peeks.children.length > 3) this.peeks.firstElementChild.remove();
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 400);
    }, PEEK_MS);
  }

  nearEnd() {
    const l = this.listEl;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 48;
  }

  scrollToEnd() {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  /** Up to five lines, then it scrolls. */
  autosize() {
    const t = this.input;
    t.style.height = '';
    if (!t.value) return;
    t.style.height = 'auto';
    const border = t.offsetHeight - t.clientHeight;
    t.style.height = `${Math.min(t.scrollHeight + border, 5 * 20 + 16 + border)}px`;
  }

  /**
   * Phones: keep the panel above the system keyboard, which covers the
   * page rather than shrinking it.
   */
  fitKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      if (!this.isOpen) return;
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      this.panel.style.setProperty('--kb-inset', `${Math.round(covered)}px`);
      this.panel.style.setProperty('--vv-height', `${Math.round(vv.height)}px`);
    };
    if (!this.fitting) {
      this.fitting = true;
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
    }
    fit();
  }
}
