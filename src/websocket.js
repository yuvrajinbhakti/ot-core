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
import { encode, decodeClientMessage, decodeServerMessage, error, serverOp, ERRORS } from './protocol.js';

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
 * Point an existing `Client` at a socket.
 *
 * Separate from `connect` because a reconnect needs it: the socket is new, the
 * client is not. Building the playground is what surfaced that — `connect`
 * always made a fresh `Client`, so coming back from offline meant throwing away
 * the buffered edits that were the entire reason the client had state.
 *
 * Call this on a socket that has not opened yet. A server writes the document —
 * or, for a returning client, everything it missed — the moment the connection
 * lands, and a message that arrives before there is a listener is simply gone.
 * Waiting for `open` and attaching afterwards loses it, and the loss is silent:
 * the client carries on a revision behind and rebases everything after it
 * against a history that is missing a step.
 *
 * @param {Client} client
 * @param {SocketLike} socket
 * @param {object} [options]
 * @param {(client: Client) => void} [options.onChange]
 * @param {(client: Client) => void} [options.onReady]  after `init` arrives
 * @returns {Client} the same client
 */
export function attach(client, socket, { onChange, onReady } = {}) {
  client.send = (message) => socket.send(encode(message));

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
 * Wire a socket to a new `Client`.
 *
 * The document arrives from the server as `init`, so the client starts empty
 * and fills in. Anything typed before then is not lost — it goes through the
 * state machine like any other edit — but it will be rebased onto whatever the
 * server actually has, which is rarely what a user expects. Wait for `onReady`
 * before letting anyone type.
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
  const client = new Client({ id, send: () => {}, onRemote, onError });
  return attach(client, socket, { onChange, onReady });
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
   * @param {number} [options.retain=200]
   *   Revisions to keep *beyond* what connected members need, so a client that
   *   drops can rejoin where it left off.
   *
   *   This is not a tuning knob, it is the difference between a working
   *   reconnect and a user losing everything they typed on a train. Compacting
   *   to the slowest *connected* member means the instant somebody's socket
   *   dies, the history they will need is gone; they come back, get told
   *   `behind-history`, and are resynced from a snapshot that silently discards
   *   the edits the state machine was holding for exactly this moment. Keeping
   *   a couple of hundred operations costs almost nothing and buys the entire
   *   offline story.
   */
  constructor(server, { compact = true, retain = 200 } = {}) {
    this.server = server;
    this.autoCompact = compact;
    this.retain = retain;
    /** @type {Map<string, { socket: SocketLike, revision: number }>} */
    this.members = new Map();
    /** @type {Array<[string, unknown]>} messages waiting behind a synchronous send */
    this.pending = [];
    this.draining = false;
  }

  /**
   * @param {string} clientId
   * @param {SocketLike} socket
   * @param {object} [options]
   * @param {number} [options.revision]
   *   For a client that is coming back rather than arriving. Given one, the room
   *   sends the operations it missed instead of a fresh `init` — which would
   *   otherwise reset its document and discard the edits it made while offline,
   *   the exact work the state machine held on to.
   */
  join(clientId, socket, { revision } = {}) {
    if (this.members.has(clientId)) {
      throw new Error(`client ${clientId} is already in this room`);
    }

    if (revision === undefined) {
      this.members.set(clientId, { socket, revision: this.server.revision });
      socket.send(encode(this.server.snapshot()));
    } else {
      let missed;
      try {
        missed = this.server.since(revision);
      } catch (cause) {
        // Compacted past what this client is holding. It has to start over, and
        // saying so is better than sending it a document it cannot reconcile.
        socket.send(encode(error(ERRORS.BEHIND_HISTORY, cause.message)));
        this.members.set(clientId, { socket, revision: this.server.revision });
        socket.send(encode(this.server.snapshot()));
        this.#listen(clientId, socket);
        return;
      }
      this.members.set(clientId, { socket, revision });
      for (const entry of missed) {
        socket.send(encode(serverOp(entry.revision, entry.op, entry.author)));
      }
    }

    this.#listen(clientId, socket);
  }

  #listen(clientId, socket) {

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
      // Deliberately NOT `server.forget(clientId)`, which is what this used to
      // do. The server remembers the last sequence number each client had
      // accepted, and that memory exists for exactly one situation: a socket
      // that died between the operation landing and the acknowledgement getting
      // home, after which the client cannot tell "never arrived" from "never
      // acknowledged" and has to resend. Forgetting on close threw the memory
      // away at the precise moment it was about to matter — the client came
      // back, resent, and the server applied the edit a second time.
      //
      // Real sockets found this; fake ones could not, because the fake never
      // closed between a write and its delivery. The entry is two numbers per
      // participant, so keeping it is free. `Server.forget` is still there for
      // a caller that knows a client is gone for good.
      this.#compact();
    }
    return gone;
  }

  #handle(clientId, message) {
    // Never re-enter. `send` can be synchronous — an in-process transport, a
    // test double, or application code that edits from an onChange handler —
    // and a nested call would interleave one operation's fan-out with the
    // next's, putting revisions on the wire out of order.
    this.pending.push([clientId, message]);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const [id, m] = this.pending.shift();
        this.#dispatch(id, m);
      }
    } finally {
      this.draining = false;
    }
  }

  #dispatch(clientId, message) {
    const member = this.members.get(clientId);
    if (!member) return;   // raced with a close

    const { ack, broadcast } = this.server.receive(clientId, message);

    // Everybody else first, the author second. Acknowledging first was a real
    // bug: the author promotes its next buffered operation the moment it is
    // acknowledged, so with a synchronous transport that operation reached the
    // server and was broadcast *before* this one — and every other client saw
    // revision N+1 arrive ahead of revision N, then discarded N as a duplicate.
    // One operation lost per collision, silently.
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

    member.socket.send(encode(ack));
    if (ack.type === 'ack') member.revision = ack.revision;

    this.#compact();
  }

  #compact() {
    if (!this.autoCompact) return;

    let lowest = this.server.revision;
    for (const member of this.members.values()) lowest = Math.min(lowest, member.revision);

    // Never past the retention window, whoever is connected — including nobody.
    // An empty room is the *most* likely to see a reconnect, not the least.
    // Clamped at zero: early in a room's life the retention window reaches
    // back past the beginning, and `compact` quite rightly refuses a negative
    // revision rather than guessing what was meant.
    this.server.compact(Math.max(0, Math.min(lowest, this.server.revision - this.retain)));
  }
}
