/**
 * The wire, and nothing else.
 *
 * This file is small on purpose. Everything hard already happened: the Client
 * and Server take a decoded message and return what to send, so a transport is
 * `JSON.stringify` in one direction, validation in the other, and a fan-out
 * loop. Building the socket into the state machine would have made all of it
 * untestable without a network — which is why the 45,000 simulated sessions in
 * test/client-server.test.js run in under a second and this module has almost
 * nothing left to get wrong.
 *
 * It takes anything with `send`, `addEventListener` and `close`, which is the
 * browser `WebSocket` and, near enough, `ws` on the server. Nothing here
 * imports either.
 */

import { Client } from './client.js';
import { encode, decodeClientMessage, decodeServerMessage, error, ERRORS } from './protocol.js';

/**
 * @typedef {{
 *   send(data: string): void,
 *   close?(code?: number, reason?: string): void,
 *   addEventListener?(type: string, listener: (event: any) => void): void,
 *   on?(type: string, listener: (...args: any[]) => void): void,
 * }} SocketLike
 */

/**
 * `ws` uses Node's EventEmitter and the browser uses EventTarget, and they
 * disagree about both the method name and the shape of what the listener gets.
 */
function listen(socket, type, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, (event) =>
      handler(type === 'message' ? event.data : event)
    );
    return;
  }
  if (typeof socket.on === 'function') {
    socket.on(type, handler);
    return;
  }
  throw new TypeError('socket must have addEventListener or on');
}

/** Node's `ws` hands a Buffer to message handlers; the browser hands a string. */
const asText = (data) =>
  typeof data === 'string' ? data : new TextDecoder().decode(data);

/**
 * Wire a socket to a new `Client`.
 *
 * The document arrives from the server as `init`, so the client starts empty
 * and fills in. Anything typed before then is not lost — it goes through the
 * state machine like any other edit — but it will be rebased onto whatever the
 * server actually has, which is rarely what a user expects. Wait for
 * `onReady` before letting anyone type.
 *
 * @param {SocketLike} socket
 * @param {object} options
 * @param {string} options.id
 * @param {(op: import('./operation.js').Operation) => void} [options.onRemote]
 * @param {(client: Client) => void} [options.onChange]  after anything moves
 * @param {(client: Client) => void} [options.onReady]   after `init` arrives
 * @param {(e: { code: string, reason: string, discarded?: unknown[] }) => void} [options.onError]
 * @returns {Client}
 */
export function connect(socket, { id, onRemote, onChange, onReady, onError } = {}) {
  const client = new Client({
    id,
    send: (message) => socket.send(encode(message)),
    onRemote,
    onError,
  });

  listen(socket, 'message', (data) => {
    let message;
    try {
      message = decodeServerMessage(asText(data));
    } catch (cause) {
      // A server sending nonsense is not something a client can recover from by
      // guessing. Say so and drop it; do not apply half of it.
      client.onError({ code: ERRORS.MALFORMED, reason: cause.message });
      return;
    }
    const first = message.type === 'init';
    client.receive(message);
    if (first) onReady?.(client);
    onChange?.(client);
  });

  return client;
}

/**
 * A room: one `Server`, several sockets, and the fan-out between them.
 *
 * Deliberately not a `Server` subclass. The server is a pure state machine that
 * can be tested exhaustively without a network; this is the part that cannot,
 * and keeping the boundary visible is what stops the two blurring together.
 */
export class Room {
  /**
   * @param {import('./server.js').Server} server
   * @param {object} [options]
   * @param {boolean} [options.compact=true]
   *   Drop history no connected client still needs, whenever one leaves or
   *   catches up. Rebasing is linear in history depth — 22µs at a thousand
   *   entries against 0.016µs at one — so a room that never compacts gets
   *   slower for as long as it stays open.
   */
  constructor(server, { compact = true } = {}) {
    this.server = server;
    this.autoCompact = compact;
    /** @type {Map<string, { socket: SocketLike, revision: number }>} */
    this.members = new Map();
  }

  /**
   * @param {string} clientId
   * @param {SocketLike} socket
   */
  join(clientId, socket) {
    if (this.members.has(clientId)) {
      throw new Error(`client ${clientId} is already in this room`);
    }
    this.members.set(clientId, { socket, revision: this.server.revision });
    socket.send(encode(this.server.snapshot()));

    listen(socket, 'message', (data) => {
      let message;
      try {
        message = decodeClientMessage(asText(data));
      } catch (cause) {
        socket.send(encode(error(ERRORS.MALFORMED, cause.message)));
        return;
      }
      this.#handle(clientId, message);
    });

    listen(socket, 'close', () => this.leave(clientId));
  }

  leave(clientId) {
    const gone = this.members.delete(clientId);
    if (gone) {
      this.server.forget(clientId);
      this.#compact();
    }
    return gone;
  }

  #handle(clientId, message) {
    const member = this.members.get(clientId);
    if (!member) return;   // raced with a close

    const { ack, broadcast } = this.server.receive(clientId, message);
    member.socket.send(encode(ack));
    if (ack.type === 'ack') member.revision = ack.revision;

    if (broadcast) {
      const payload = encode(broadcast);
      for (const [id, other] of this.members) {
        if (id === clientId) continue;
        other.socket.send(payload);
        // Optimistic: the operation is on its way. If the socket dies before it
        // arrives, that client reconnects and catches up through since(), which
        // needs history back to *its* revision — so this only ever moves
        // forward for members still here, and leave() re-runs the calculation.
        other.revision = broadcast.revision;
      }
    }
    this.#compact();
  }

  #compact() {
    if (!this.autoCompact) return;
    if (this.members.size === 0) {
      // Nobody left to catch up. Keeping history for a client that may never
      // return is what makes an idle room expensive.
      this.server.compact(this.server.revision);
      return;
    }
    let lowest = Infinity;
    for (const member of this.members.values()) lowest = Math.min(lowest, member.revision);
    this.server.compact(lowest);
  }
}
