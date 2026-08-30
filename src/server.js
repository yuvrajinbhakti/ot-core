/**
 * The authority.
 *
 * Its whole job is to decide an order, because that is the one thing the
 * transform function cannot do for itself. Two operations transform correctly
 * against each other in either order (TP1); three do not (TP2), and this
 * operation model does not have TP2 — six peers given the same three edits in
 * six different orders land on two different documents, at a rate of about 3.6%.
 * The server is not a convenience. It is the thing that makes convergence true.
 *
 * It is also deliberately not a network. It takes a decoded message and returns
 * what to send; it does not know what a socket is, cannot be blocked by one, and
 * can therefore be tested exhaustively without one — which is how the 20,000
 * simulated sessions in test/client-server.test.js run in half a second.
 */

import { apply } from './operation.js';
import { transform } from './transform.js';
import { whyInvalid } from './validate.js';
import {
  ack, serverOp, init, error, ERRORS, whyInvalidClientMessage,
} from './protocol.js';

/** @typedef {import('./operation.js').Operation} Operation */

export class Server {
  /**
   * @param {object} [options]
   * @param {string} [options.document='']  the starting text
   * @param {number} [options.revision=0]   the version that text is at, if resuming
   */
  constructor({ document = '', revision = 0 } = {}) {
    if (typeof document !== 'string') throw new TypeError('document must be a string');
    if (!Number.isInteger(revision) || revision < 0) {
      throw new RangeError('revision must be a non-negative integer');
    }
    this.document = document;
    this.revision = revision;
    /** Operations from `baseRevision` onward, oldest first. */
    this.history = [];
    /**
     * The oldest revision still rebaseable. Non-zero once compact() has run, and
     * the reason a client can be told it is too far behind to catch up.
     */
    this.baseRevision = revision;
    /**
     * Last accepted sequence number per client, so a resend after a dropped
     * socket is recognised rather than applied twice.
     * @type {Map<string, { seq: number, revision: number }>}
     */
    this.seen = new Map();
  }

  /** What a joining client needs. */
  snapshot() {
    return init(this.revision, this.document);
  }

  /**
   * The operations a client at `revision` has missed, in order.
   *
   * @param {number} revision
   * @returns {Array<{ revision: number, op: Operation, author: string }>}
   */
  since(revision) {
    if (revision < this.baseRevision) {
      throw new RangeError(
        `history before revision ${this.baseRevision} has been compacted; revision ${revision} cannot be caught up`
      );
    }
    return this.history.slice(revision - this.baseRevision).map((entry, i) => ({
      revision: revision + i + 1,
      op: entry.op,
      author: entry.author,
    }));
  }

  /**
   * Take one message from one client.
   *
   * @param {string} clientId
   * @param {unknown} message
   * @returns {{ ack: import('./protocol.js').ServerMessage,
   *             broadcast: import('./protocol.js').ServerMessage | null,
   *             applied: boolean }}
   *   `ack` goes to `clientId` and `broadcast` to everybody else. `broadcast` is
   *   null when nothing changed — a duplicate resend, or an edit that a
   *   concurrent delete cancelled out entirely.
   */
  receive(clientId, message) {
    if (typeof clientId !== 'string' || clientId === '') {
      throw new TypeError('clientId must be a non-empty string');
    }

    const malformed = whyInvalidClientMessage(message);
    if (malformed !== null) {
      return { ack: error(ERRORS.MALFORMED, malformed), broadcast: null, applied: false };
    }

    const { revision, seq, op } = /** @type {any} */ (message);

    // A resend after a socket dropped between the edit landing and the
    // acknowledgement getting home. The client cannot distinguish that from
    // "never arrived", so it has to resend, and the server has to notice.
    const previous = this.seen.get(clientId);
    if (previous && seq <= previous.seq) {
      return { ack: ack(previous.revision, seq), broadcast: null, applied: false };
    }

    if (revision > this.revision) {
      return {
        ack: error(
          ERRORS.FUTURE_REVISION,
          `revision ${revision} is ahead of the server's ${this.revision}`
        ),
        broadcast: null,
        applied: false,
      };
    }
    if (revision < this.baseRevision) {
      return {
        ack: error(
          ERRORS.BEHIND_HISTORY,
          `revision ${revision} predates the compacted history at ${this.baseRevision}; rejoin`
        ),
        broadcast: null,
        applied: false,
      };
    }

    // Rebase over everything accepted since this client last read. The client is
    // doing the identical walk on its own copy as those operations reach it, and
    // the two must land on the same operation — see the acknowledgement check in
    // test/client-server.test.js, which is the sharpest assertion in this repo.
    //
    // 'right' throughout: the settled history wins every tie, so two people
    // typing at the same index land in the order the server accepted them.
    let rebased = op;
    for (let i = revision - this.baseRevision; i < this.history.length; i++) {
      rebased = transform(rebased, this.history[i].op, 'right');
    }

    // Checked *after* rebasing, not before. Before rebasing the operation is
    // written against a document the server may no longer have; afterwards it is
    // written against this one, and that is the version that has to fit.
    const size = Array.from(this.document).length;
    const why = whyInvalid(rebased, size);
    if (why !== null) {
      return {
        ack: error(ERRORS.OUT_OF_RANGE, `after rebasing, ${why}`),
        broadcast: null,
        applied: false,
      };
    }

    this.document = apply(this.document, rebased);
    this.history.push({ op: rebased, author: clientId });
    this.revision++;
    this.seen.set(clientId, { seq, revision: this.revision });

    return {
      ack: ack(this.revision, seq),
      broadcast: serverOp(this.revision, rebased, clientId),
      applied: true,
    };
  }

  /**
   * Drop history below `revision`, which no client still needs.
   *
   * Rebasing is linear in history depth — a thousand entries deep it is 22µs per
   * operation against 0.016µs at one — so a room that never compacts gets slower
   * for as long as it stays open. The caller decides what "no client still
   * needs" means, because only the caller knows who is connected.
   *
   * @param {number} revision  the lowest revision any client is still holding
   */
  compact(revision) {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new RangeError('revision must be a non-negative integer');
    }
    const target = Math.min(revision, this.revision);
    if (target <= this.baseRevision) return 0;
    const dropped = target - this.baseRevision;
    this.history = this.history.slice(dropped);
    this.baseRevision = target;
    return dropped;
  }

  /** Stop tracking a client that has gone, so `seen` does not grow forever. */
  forget(clientId) {
    return this.seen.delete(clientId);
  }
}
