/* room-error.mjs — an error a live room sends back to the one client that
 * caused it, as {type:'error', code, message, ...extra} (see js/net.js). */

export class RoomError extends Error {
  /** @param {object} [extra]  more fields for the client (a chat message's cid) */
  constructor(code, message, extra = null) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
