/*
 * chat.mjs — what the people in a co-op solve (Room in rooms.mjs), or a
 * custom puzzle's authors (BuildRoom in build-rooms.mjs), say to each
 * other. Each message is written to chat_messages as it arrives and passed
 * on to everyone in the room; the room keeps the newest ones in memory and
 * every snapshot carries them, so someone who opens the solve later, or
 * comes back from a dropped connection, sees the conversation so far.
 *
 * Senders name each message (`cid`) and send it again if their connection
 * dropped before it came back to them; a repeat isn't stored twice.
 *
 * Wire messages are documented in js/net.js.
 */

import { RoomError } from './room-error.mjs';

export const CHAT_MAX_LEN = 1000;
export const CHAT_HISTORY = 200; // messages in a snapshot
const CID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// a stuck key or a runaway script, not a person typing
const BURST = 20;
const BURST_MS = 10_000;

/**
 * Tidy what someone typed: line breaks kept (at most one blank line in a
 * row), other control characters dropped, trimmed, at most CHAT_MAX_LEN.
 */
export function cleanChatText(text) {
  if (typeof text !== 'string') return '';
  let out = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[  ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > CHAT_MAX_LEN) out = out.slice(0, CHAT_MAX_LEN).replace(/[\ud800-\udbff]$/, '').trimEnd();
  return out;
}

export class ChatLog {
  /**
   * @param {{hub: import('./rooms.mjs').Hub, broadcast: (msg: object) => void}} room
   * @param {{solveId?: string, puzzleId?: string}} where  whose conversation
   */
  constructor(room, where) {
    this.room = room;
    this.where = where;
    this.messages = room.hub.store.chatMessages(where, CHAT_HISTORY);
  }

  /** The newest messages, oldest first: {id, user, cid, at, text}. */
  recent() {
    return this.messages;
  }

  /** `conn` said {text, cid}: store it, then everyone here gets it. */
  post(conn, { text, cid } = {}) {
    if (typeof cid !== 'string' || !CID_RE.test(cid)) throw new RoomError('bad-chat', 'A message needs an id.');
    const already = this.messages.find((m) => m.cid === cid && m.user === conn.user.name);
    if (already) {
      conn.send({ type: 'chat', message: already }); // a resend: it's here already
      return;
    }
    const clean = cleanChatText(text);
    if (!clean) throw new RoomError('bad-chat', 'That message is empty.', { cid });
    const now = this.room.hub.now();
    const recent = (conn.chatTimes ?? []).filter((t) => now - t < BURST_MS);
    if (recent.length >= BURST) {
      conn.chatTimes = recent;
      throw new RoomError('chat-flood', 'That’s a lot of messages at once. Give it a few seconds.', { cid });
    }
    conn.chatTimes = [...recent, now];
    const at = Math.round(now);
    const id = this.room.hub.store.addChatMessage(this.where, { userId: conn.user.id, cid, at, text: clean });
    const message = { id, user: conn.user.name, cid, at, text: clean };
    this.messages.push(message);
    if (this.messages.length > CHAT_HISTORY) this.messages.shift();
    this.room.broadcast({ type: 'chat', message });
  }
}
