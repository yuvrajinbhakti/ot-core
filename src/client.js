/**
 * The client half: three states, and the transitions between them.
 *
 *     synchronized ──edit──► awaiting ──edit──► awaiting-with-buffer
 *          ▲                    │                        │
 *          └────────ack─────────┘                        │
 *          ▲                    ▲───────ack──────────────┘
 *
 * One operation may be in flight at a time. Edits made while waiting go into a
 * buffer, and `composeAll` collapses them as they arrive — so a burst of typing
 * that spans a network round trip leaves as one operation rather than twelve.
 *
 * The awkward state is the third one. An operation arriving from the server has
 * to be transformed past the outstanding operation *and* past every buffered
 * one, in order, while each of those is rebased past it. Doing only the first
 * half looks completely plausible and works until three people overlap; that
 * mistake is why this file has a simulation behind it rather than examples.
 */

import { apply } from './operation.js';
import { transform } from './transform.js';
import { transformSelection } from './position.js';
import { compose } from './compose.js';
import { diff } from './diff.js';
import { clientOp, whyInvalidServerMessage, ERRORS } from './protocol.js';

/** @typedef {import('./operation.js').Operation} Operation */

export const SYNCHRONIZED = 'synchronized';
export const AWAITING = 'awaiting';
export const AWAITING_WITH_BUFFER = 'awaiting-with-buffer';

export class Client {
  /**
   * @param {object} options
   * @param {string} options.id
   *   This client's identity, the same one the server routes by. Required, and
   *   not for the wire — `reconnect` needs it to recognise its own operation
   *   coming back as history and treat it as the acknowledgement rather than
   *   applying it a second time.
   * @param {(message: import('./protocol.js').ClientMessage) => void} options.send
   *   Called when there is something to put on the wire. It may throw or do
   *   nothing if the socket is down — see `disconnect`.
   * @param {string} [options.document='']
   * @param {number} [options.revision=0]
   * @param {(op: Operation) => void} [options.onRemote]
   *   A remote operation, already transformed into this client's coordinates.
   *   This is what an editor binds to: apply it to the view, and move any
   *   decorations that are not the main selection.
   * @param {(reason: { code: string, reason: string }) => void} [options.onError]
   */
  constructor({ id, send, document = '', revision = 0, onRemote, onError } = {}) {
    if (typeof id !== 'string' || id === '') throw new TypeError('id must be a non-empty string');
    if (typeof send !== 'function') throw new TypeError('a send function is required');
    this.id = id;
    this.send = send;
    this.document = document;
    this.revision = revision;
    this.onRemote = onRemote ?? (() => {});
    this.onError = onError ?? (() => {});

    /** @type {Operation | null} sent, not acknowledged */
    this.outstanding = null;
    /** @type {Operation[]} made locally since, not sent */
    this.buffer = [];
    /**
     * Identifies the *operation* in flight, not the transmission. A resend
     * reuses it — that is the entire mechanism by which the server can tell
     * "you already have this" from "here is a new edit".
     */
    this.seq = 0;
    /**
     * The exact message on the wire, kept so a resend can replay it byte for
     * byte.
     *
     * Rebuilding it from the current `outstanding` looks equivalent and is not:
     * between the first send and the resend, arriving operations rebase
     * `outstanding`, so the rebuilt message carries a different operation under
     * the same sequence number. The server then applies one and deduplicates
     * the other, and the two sides disagree about which — permanently. A
     * message is immutable; the server rebases it from the revision it carries.
     * @type {import('./protocol.js').ClientMessage | null}
     */
    this.inFlight = null;
    this.connected = true;

    /**
     * The local caret, kept in sync with remote edits. `null` means the
     * application is tracking its own and does not want this doing it.
     * @type {{ anchor: number, head: number } | null}
     */
    this.selection = null;
  }

  get state() {
    if (this.outstanding === null) return SYNCHRONIZED;
    return this.buffer.length === 0 ? AWAITING : AWAITING_WITH_BUFFER;
  }

  /** Edits this client has made that the server has not confirmed. */
  get unconfirmed() {
    return this.outstanding === null ? [] : [this.outstanding, ...this.buffer];
  }

  /**
   * A local edit: apply it, and either send it or hold it.
   *
   * @param {Operation} op  written against this client's current document
   */
  edit(op) {
    this.document = apply(this.document, op);
    if (this.selection) this.selection = transformSelection(this.selection, op);

    if (this.outstanding === null) {
      this.#promote(op);
      return;
    }

    // Merge into the tail of the buffer where the model allows it. This is the
    // difference between one message per keystroke and one per burst.
    const last = this.buffer[this.buffer.length - 1];
    const merged = last === undefined ? null : compose(last, op);
    if (merged === null) this.buffer.push(op);
    else this.buffer[this.buffer.length - 1] = merged;
  }

  /**
   * The same, from an editor that hands you a whole new value rather than an
   * edit — which is every textarea, and covers paste, drag-and-drop and
   * autocorrect that keystroke interception misses.
   *
   * @param {string} text
   */
  editText(text) {
    for (const op of diff(this.document, text)) this.edit(op);
  }

  /**
   * @param {unknown} message  from the server, already decoded
   */
  receive(message) {
    const why = whyInvalidServerMessage(message);
    if (why !== null) {
      this.onError({ code: ERRORS.MALFORMED, reason: why });
      return;
    }
    const m = /** @type {any} */ (message);

    switch (m.type) {
      case 'init':
        this.document = m.document;
        this.revision = m.revision;
        this.outstanding = null;
        this.inFlight = null;
        this.buffer = [];
        return;

      case 'error': {
        // The server will not apply the operation in flight, so this client is
        // holding local edits that no longer exist anywhere else. It cannot
        // reconcile that on its own — the divergence is already in its
        // document — so it drops the unconfirmed work and hands it back for the
        // application to decide about, rather than staying stuck in `awaiting`
        // forever, transforming everyone else's edits against an operation the
        // server rejected. Re-request `init` after this.
        const discarded = this.unconfirmed;
        this.outstanding = null;
        this.inFlight = null;
        this.buffer = [];
        this.onError({ code: m.code, reason: m.reason, discarded });
        return;
      }

      case 'ack':
        // Ignore an acknowledgement for something we are not waiting on — a
        // duplicate delivery, or one that crossed a reconnect.
        if (this.outstanding === null || m.seq !== this.seq) return;
        // Never backwards. A deduplicated acknowledgement carries the revision
        // the operation originally landed at, which can be behind where this
        // client has since caught up to.
        this.revision = Math.max(this.revision, m.revision);
        this.outstanding = null;
        this.inFlight = null;
        if (this.buffer.length > 0) this.#promote(this.buffer.shift());
        return;

      case 'op':
        // Already have it. A client that reconnects catches up through
        // `since()`, and a broadcast of one of those same revisions can still
        // be in flight — the socket is gone, but a proxy, a buffered write or a
        // server that fans out to a stale connection list will deliver it
        // anyway. Applying it twice inserts the text twice, permanently, and
        // nothing downstream can tell that from an OT bug. The revision number
        // is already on the message; this is free.
        if (m.revision <= this.revision) return;
        // A revision from the future means operations went missing, and there
        // is no rebasing across an operation you never saw — every subsequent
        // transform would be against the wrong history. Applying it anyway is
        // how a document ends up quietly wrong, so this is an error rather than
        // a best effort. It also caught a real ordering bug in the room's
        // fan-out that had been silently losing an operation per collision.
        if (m.revision > this.revision + 1) {
          this.onError({
            code: ERRORS.GAP,
            reason: `received revision ${m.revision} while holding ${this.revision}; ` +
              `${m.revision - this.revision - 1} operation(s) missing`,
          });
          return;
        }
        this.#applyRemote(m.op);
        this.revision = m.revision;
        return;
    }
  }

  /**
   * Stop sending. Edits keep working and keep accumulating.
   *
   * There is no queue to build here: the outstanding operation stays
   * outstanding and everything else piles into the buffer, which is exactly
   * where they would be anyway. Offline editing is the state machine already
   * doing its job with the acknowledgement never arriving.
   */
  disconnect() {
    this.connected = false;
  }

  /**
   * Resume. Catch up on what was missed, then re-send whatever was in flight.
   *
   * The resend is unconditional and that is deliberate: the socket may have
   * dropped after the server accepted the edit but before the acknowledgement
   * got home, and from here those two cases are indistinguishable. The `seq` on
   * the message is what lets the server tell them apart.
   *
   * @param {Array<{ revision: number, op: Operation, author: string }>} missed
   *   From `server.since(client.revision)`, oldest first.
   */
  reconnect(missed = []) {
    this.connected = true;

    for (const entry of missed) {
      if (entry.author === this.id) {
        // Our own operation, coming back as history. It landed before the
        // socket dropped, so this *is* the acknowledgement — and applying it
        // as a remote operation would insert the same text twice, which is
        // the exact bug the sequence number exists to prevent on the other
        // side of the wire.
        this.revision = entry.revision;
        if (this.outstanding !== null) {
          this.outstanding = null;
          this.inFlight = null;
          // Promoted but deliberately not sent yet. The rest of `missed` still
          // has to rebase it, and sending here put a stale operation on the
          // wire under the same sequence number as the rebased one that
          // followed — so the server applied the first and deduplicated the
          // second, and the client believed the opposite. Two different
          // operations must never share a seq.
          if (this.buffer.length > 0) this.#promote(this.buffer.shift(), false);
        }
        continue;
      }
      this.#applyRemote(entry.op);
      this.revision = entry.revision;
    }

    if (this.outstanding !== null) this.#transmit();
  }

  /**
   * A new operation takes the wire, and takes the next sequence number.
   *
   * `transmit` is false only while catching up on reconnect, where the
   * operation is not final until every missed operation has rebased it.
   */
  #promote(op, transmit = true) {
    this.outstanding = op;
    this.seq++;
    this.inFlight = null;
    if (transmit) this.#transmit();
  }

  /** Put the outstanding operation on the wire — a resend replays it verbatim. */
  #transmit() {
    if (!this.connected || this.outstanding === null) return;
    if (this.inFlight === null) this.inFlight = clientOp(this.revision, this.seq, this.outstanding);
    this.send(this.inFlight);
  }

  /**
   * Fold a server operation into a client that may have unsent work.
   *
   * The order matters and is not symmetric. The incoming operation is written
   * against the server's document; the outstanding operation is the only thing
   * between that and this client's document at the moment it was sent, and each
   * buffered operation is another step past it. So the incoming operation walks
   * forward through them, being rewritten at each step, while each of them is
   * rewritten past the version of the incoming operation that met it.
   *
   * 'left' for the incoming, 'right' for the local: the server's history wins
   * every tie, matching what the server itself does when it rebases.
   */
  #applyRemote(op) {
    let incoming = op;

    if (this.outstanding !== null) {
      const rebasedOutstanding = transform(this.outstanding, incoming, 'right');
      incoming = transform(incoming, this.outstanding, 'left');
      this.outstanding = rebasedOutstanding;
    }

    for (let i = 0; i < this.buffer.length; i++) {
      const local = this.buffer[i];
      this.buffer[i] = transform(local, incoming, 'right');
      incoming = transform(incoming, local, 'left');
    }

    this.document = apply(this.document, incoming);
    if (this.selection) this.selection = transformSelection(this.selection, incoming);
    this.onRemote(incoming);
  }
}
