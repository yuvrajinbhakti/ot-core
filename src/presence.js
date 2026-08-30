/**
 * Where everybody else's cursor is.
 *
 * This is the half of collaborative editing that has nothing to do with
 * convergence and everything to do with whether the result feels alive. The
 * document can be perfectly synchronised and the experience still be wrong: you
 * watch a name appear in a corner and have no idea where that person is, or
 * worse, their caret is drawn three characters off because somebody typed above
 * them and nothing moved it.
 *
 * `transformPosition` has been in this library since the beginning, and the
 * CodeMirror binding carried a comment saying it did not invent presence just to
 * have somewhere to use it. This is that somewhere.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a data structure plus the arithmetic: who is where, and how those
 * positions move when the document changes. It is **not** a transport. Nothing
 * here opens a socket or defines a message, because presence has different
 * requirements from operations and pretending otherwise makes both worse —
 * presence is ephemeral, lossy-tolerant, high-frequency and needs no ordering
 * guarantee, whereas an operation is none of those things. Shipping cursors
 * through the operation channel would put an unordered, droppable, ten-a-second
 * message class inside a state machine built to never drop or reorder anything.
 *
 * So: you send cursors however you like, and hand what arrives to `see`.
 *
 * ## The staleness problem, and how much of it is actually solved
 *
 * A peer reports "I am at 40" as of some revision. By the time it reaches you,
 * you may have applied two more operations, and position 40 means something
 * else. Reporting a position without the revision it was true at is the bug
 * almost every naive implementation ships, and it shows up as cursors that drift
 * whenever anyone types quickly.
 *
 * A short ring of recent operations fixes most of it exactly: a report that
 * arrives stale is transformed forward through precisely the operations it
 * missed. The ring is bounded, so a report older than the window cannot be
 * caught up — that one is used as-is and corrected by the peer's next report,
 * which is a visible flicker rather than permanent drift. `retain` sets the
 * window and the default covers far more than a real round trip.
 *
 * There is a second, subtler half. A peer reports a position in *their*
 * document, which is the server's state plus their own unconfirmed edits. Yours
 * is the server's state plus *your* unconfirmed edits. Those are different
 * documents, and a report is only meaningful in yours after it has also been
 * rebased past everything you have typed and not yet had acknowledged. `pending`
 * supplies those, and `track` wires it to `client.unconfirmed`.
 *
 * One window remains open, and I would rather name it than imply it is not
 * there: an operation of your own that has just been acknowledged has left
 * `unconfirmed` and was never a remote operation, so it is in neither the ring
 * nor `pending`. A report stamped before that acknowledgement is not rebased
 * past it. The window is a single round trip and it closes on the peer's next
 * report. Fixing it properly means the server stamping and transforming
 * presence, which is a protocol change this module does not justify on its own.
 */

import { transformSelection } from './position.js';

/** @typedef {import('./operation.js').Operation} Operation */
/** @typedef {{ anchor: number, head: number }} Selection */

/**
 * @typedef {object} Peer
 * @property {string} id
 * @property {Selection} selection  code-point offsets into the current document
 * @property {number} revision      the revision the report was transformed up to
 * @property {number} at            `clock()` when the report was last seen
 * @property {Record<string, unknown>} meta  whatever you attached — name, colour
 */

export class Presence {
  /**
   * @param {object} [options]
   * @param {(peers: Peer[]) => void} [options.onChange]
   *   Called whenever anything moves, joins or leaves. Coalescing is yours to
   *   do: this fires on every applied operation, which is every keystroke.
   * @param {number} [options.retain=256]
   *   How many recent operations to keep for catching up stale reports. A report
   *   more than this many revisions behind cannot be transformed forward.
   * @param {number} [options.timeout=45000]
   *   How long a peer may go unheard before `sweep` drops them. Presence has no
   *   reliable goodbye — a closed laptop sends nothing — so the only honest
   *   liveness signal is recency.
   * @param {() => number} [options.clock=Date.now]
   *   Injectable so tests are not obliged to sleep.
   * @param {() => Operation[]} [options.pending]
   *   Your own edits that the server has not acknowledged. An incoming report is
   *   rebased past these, because it was written against a document that does
   *   not contain them. Defaults to none, which is correct only if you never
   *   type while a report is in flight.
   */
  constructor({ onChange, retain = 256, timeout = 45_000, clock = Date.now, pending } = {}) {
    this.onChange = onChange ?? (() => {});
    this.retain = retain;
    this.timeout = timeout;
    this.clock = clock;
    this.pending = pending ?? (() => []);

    /** @type {Map<string, Peer>} */
    this.peers = new Map();

    /**
     * Recent operations, oldest first, each tagged with the revision it produced.
     * Only used to catch up reports that arrive late.
     * @type {{ revision: number, op: Operation }[]}
     */
    this.history = [];

    /** The revision this structure believes the document is at. */
    this.revision = 0;
  }

  /**
   * An operation was applied to the document. Move everyone.
   *
   * Call this for *every* operation that changes the document, local ones
   * included. A peer sitting at position 40 has to move when you insert at 5,
   * and there is nothing about the edit being yours that changes the arithmetic.
   * Missing the local case is the version of this bug that only appears when the
   * other person is idle, which is exactly when you are most likely to be
   * looking at their cursor.
   *
   * @param {Operation} op  in the coordinates of the current document
   * @param {number} [revision]  what the document is at afterwards
   */
  apply(op, revision = this.revision + 1) {
    this.revision = revision;
    this.history.push({ revision, op });
    if (this.history.length > this.retain) this.history.shift();
    this.#move(op);
  }

  /**
   * The same, for an edit of your own the server has not seen yet.
   *
   * Peers' stored positions live in *your* coordinates, so they have to move for
   * your typing exactly as they do for anyone else's. What is different is that
   * this operation does not go in the ring: it is not part of the server's
   * ordered history, and an incoming report is rebased past it through `pending`
   * instead. Putting it in both would count it twice and push every remote
   * cursor along by the length of your own typing.
   *
   * @param {Operation} op
   */
  applyLocal(op) {
    this.#move(op);
  }

  #move(op) {
    let moved = false;
    for (const peer of this.peers.values()) {
      const next = transformSelection(peer.selection, op);
      if (next.anchor !== peer.selection.anchor || next.head !== peer.selection.head) {
        peer.selection = next;
        moved = true;
      }
      peer.revision = this.revision;
    }
    if (moved) this.#changed();
  }

  /**
   * A peer told you where they are.
   *
   * @param {string} id
   * @param {Selection | number | null} selection
   *   A selection, a bare offset for a collapsed caret, or null to clear the
   *   peer's cursor while keeping them present (they are here, but not in the
   *   document — a different pane, an unfocused window).
   * @param {object} [options]
   * @param {number} [options.revision]
   *   The revision the report was true at. Omitted means "current", which is
   *   right for a local cursor and wrong for one off a network — pass it.
   * @param {Record<string, unknown>} [options.meta]
   *   Merged into whatever the peer already had, so a report carrying only a
   *   position does not erase their name.
   */
  see(id, selection, { revision, meta } = {}) {
    const existing = this.peers.get(id);
    const normalised = normalise(selection);
    const from = revision ?? this.revision;

    const peer = {
      id,
      selection: normalised === null ? (existing?.selection ?? { anchor: 0, head: 0 }) : this.#catchUp(normalised, from),
      revision: this.revision,
      at: this.clock(),
      meta: { ...(existing?.meta ?? {}), ...(meta ?? {}) },
      absent: normalised === null,
    };

    this.peers.set(id, peer);
    this.#changed();
  }

  /**
   * Transform a report forward through the operations it did not know about.
   *
   * Everything strictly after the reported revision applied while the message
   * was in flight, so those are exactly the operations to rebase it past. If the
   * report predates the ring there is nothing to rebase against and it is used
   * as-is; see the note at the top about why that is a flicker and not drift.
   */
  #catchUp(selection, from) {
    let moved = selection;
    for (const entry of this.history) {
      if (entry.revision > from) moved = transformSelection(moved, entry.op);
    }
    // Then past your own unsent typing, which the reporter had not seen either.
    // This runs even when the report is current by revision, because "current"
    // means current with the *server*, and your unconfirmed edits are by
    // definition not there yet.
    for (const op of this.pending()) moved = transformSelection(moved, op);
    return moved;
  }

  /** @param {string} id */
  forget(id) {
    if (this.peers.delete(id)) this.#changed();
  }

  /**
   * Drop peers not heard from within `timeout`.
   *
   * Not on a timer of its own — call it from whatever heartbeat you already
   * have. A library that installs its own interval is a library that keeps a
   * process alive after you thought you had shut it down.
   *
   * @returns {string[]}  the ids dropped
   */
  sweep() {
    const now = this.clock();
    const dropped = [];
    for (const [id, peer] of this.peers) {
      if (now - peer.at > this.timeout) {
        this.peers.delete(id);
        dropped.push(id);
      }
    }
    if (dropped.length > 0) this.#changed();
    return dropped;
  }

  /** Everyone currently present, with a cursor to draw. */
  list() {
    return [...this.peers.values()].filter((p) => !p.absent);
  }

  /** @param {string} id */
  get(id) {
    return this.peers.get(id) ?? null;
  }

  clear() {
    if (this.peers.size === 0) return;
    this.peers.clear();
    this.#changed();
  }

  #changed() {
    this.onChange(this.list());
  }
}

/**
 * A caret is a selection whose ends coincide, so callers may pass either. Both
 * ends are clamped at zero because a negative offset is never meaningful and
 * arriving over a network it is not even unlikely.
 */
function normalise(selection) {
  if (selection === null || selection === undefined) return null;
  if (typeof selection === 'number') {
    const at = Math.max(0, selection);
    return { anchor: at, head: at };
  }
  return {
    anchor: Math.max(0, selection.anchor ?? 0),
    head: Math.max(0, selection.head ?? selection.anchor ?? 0),
  };
}

/**
 * Keep a `Presence` in step with a `Client` without the application wiring it.
 *
 * Both hooks are chained rather than replaced, so this composes with the
 * CodeMirror binding and with any callback the application already set.
 *
 * Local edits are fed in too — see the note on `apply` about why leaving them
 * out produces a bug that only shows when the other person is idle.
 *
 * @param {import('./client.js').Client} client
 * @param {Presence} presence
 * @returns {() => void}  detach
 */
export function track(client, presence) {
  const previousRemote = client.onRemote;
  const previousLocal = client.onLocal;
  const previousPending = presence.pending;

  presence.pending = () => client.unconfirmed;
  presence.revision = client.revision;

  client.onRemote = (op) => {
    presence.apply(op, client.revision);
    previousRemote?.(op);
  };
  client.onLocal = (op, before) => {
    presence.applyLocal(op);
    previousLocal?.(op, before);
  };

  return () => {
    client.onRemote = previousRemote;
    client.onLocal = previousLocal;
    presence.pending = previousPending;
  };
}
