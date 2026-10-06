/* room-error.mjs — an error a live room sends back to the one client that
 * caused it, as {type:'error', code, message} (see js/net.js). */

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
