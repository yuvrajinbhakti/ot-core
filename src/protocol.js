/**
 * What goes over the wire, and what to do with a message that should not have.
 *
 * Four message types, and the asymmetry between them is the protocol. A client
 * sends exactly one thing — an edit, tagged with the revision it was written
 * against. A server sends three: the document you get on joining, an
 * acknowledgement of your own edit, and everybody else's edits.
 *
 * The acknowledgement deliberately does not carry the rebased operation. The
 * server rebased the client's edit over the history the client had not seen; the
 * client rebases the same edit over the same history as it arrives; and those
 * two must independently agree. Sending the server's answer would paper over a
 * disagreement rather than surface it, and a disagreement here means the two
 * sides are running different code — which in an editing session shows up as
 * silent, permanent corruption an hour later.
 *
 * Everything is validated on arrival. A collaborative editor is a program that
 * accepts arbitrary input from every one of its users and applies it to shared
 * state; `apply` clamps out-of-range positions on purpose, so a malformed
 * operation does not throw, it quietly damages the document for everybody.
 */

import { whyInvalid } from './validate.js';

/** @typedef {import('./operation.js').Operation} Operation */

/** @typedef {{ type: 'op', revision: number, seq: number, op: Operation }} ClientMessage */
/**
 * @typedef {{ type: 'init', revision: number, document: string }
 *   | { type: 'ack', revision: number, seq: number }
 *   | { type: 'op', revision: number, op: Operation, author: string }
 *   | { type: 'error', reason: string, code: string }} ServerMessage
 */

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * An edit, from a client.
 *
 * `revision` is the version of the document it was written against — the server
 * needs it to know what to rebase over. `seq` is this client's own counter, and
 * it exists for exactly one reason: a socket that drops after the server
 * accepted an edit but before the acknowledgement arrived. The client cannot
 * tell that case from "never arrived" and has to resend; without `seq` the
 * server would apply it twice.
 */
export const clientOp = (revision, seq, op) => ({ type: 'op', revision, seq, op });

export const init = (revision, document) => ({ type: 'init', revision, document });
export const ack = (revision, seq) => ({ type: 'ack', revision, seq });
export const serverOp = (revision, op, author) => ({ type: 'op', revision, op, author });
export const error = (code, reason) => ({ type: 'error', code, reason });

/**
 * Why this is not a message a client may send, or `null`.
 *
 * @param {unknown} message
 * @returns {string | null}
 */
export function whyInvalidClientMessage(message) {
  if (message === null || typeof message !== 'object') return `expected an object, got ${typeof message}`;
  const { type, revision, seq, op } = /** @type {any} */ (message);
  if (type !== 'op') return `client messages must have type "op", got ${JSON.stringify(type)}`;
  if (!isCount(revision)) return `revision must be a non-negative integer, got ${JSON.stringify(revision)}`;
  if (!isCount(seq)) return `seq must be a non-negative integer, got ${JSON.stringify(seq)}`;
  const why = whyInvalid(op);
  return why === null ? null : `op is invalid: ${why}`;
}

/**
 * Why this is not a message a server may send, or `null`.
 *
 * Worth having in both directions. A client that trusts whatever comes down the
 * socket is one compromised or buggy server away from a corrupted document, and
 * the failure is indistinguishable from an OT bug — which is a day of looking in
 * the wrong place.
 *
 * @param {unknown} message
 * @returns {string | null}
 */
export function whyInvalidServerMessage(message) {
  if (message === null || typeof message !== 'object') return `expected an object, got ${typeof message}`;
  const m = /** @type {any} */ (message);

  switch (m.type) {
    case 'init':
      if (!isCount(m.revision)) return `revision must be a non-negative integer, got ${JSON.stringify(m.revision)}`;
      if (typeof m.document !== 'string') return `document must be a string, got ${typeof m.document}`;
      return null;
    case 'ack':
      if (!isCount(m.revision)) return `revision must be a non-negative integer, got ${JSON.stringify(m.revision)}`;
      if (!isCount(m.seq)) return `seq must be a non-negative integer, got ${JSON.stringify(m.seq)}`;
      return null;
    case 'op': {
      if (!isCount(m.revision)) return `revision must be a non-negative integer, got ${JSON.stringify(m.revision)}`;
      if (typeof m.author !== 'string') return `author must be a string, got ${typeof m.author}`;
      const why = whyInvalid(m.op);
      return why === null ? null : `op is invalid: ${why}`;
    }
    case 'error':
      if (typeof m.code !== 'string') return `error code must be a string, got ${typeof m.code}`;
      if (typeof m.reason !== 'string') return `error reason must be a string, got ${typeof m.reason}`;
      return null;
    default:
      return `unknown server message type ${JSON.stringify(m.type)}`;
  }
}

export const isClientMessage = (m) => whyInvalidClientMessage(m) === null;
export const isServerMessage = (m) => whyInvalidServerMessage(m) === null;

/**
 * The reasons a server rejects an edit, as codes rather than prose, because a
 * client has to branch on them.
 *
 * `behind-history` is the one worth handling: it means the server compacted
 * history past the revision this client is holding, so nothing can rebase the
 * edit and the client has to throw away its local state and rejoin. Treating it
 * as a generic error loses the user's unsent work silently.
 */
export const ERRORS = Object.freeze({
  MALFORMED: 'malformed',
  FUTURE_REVISION: 'future-revision',
  BEHIND_HISTORY: 'behind-history',
  OUT_OF_RANGE: 'out-of-range',
  /**
   * The client received an operation from the future — revisions are missing.
   * It cannot rebase across a gap it never saw, so it must resync. Loud,
   * because the alternative is a document that is quietly wrong.
   */
  GAP: 'gap',
});

/** JSON, with the validation that a bare JSON.parse leaves to chance. */
export const encode = (message) => JSON.stringify(message);

/**
 * @param {string} text
 * @param {(m: unknown) => string | null} check
 * @returns {any}
 * @throws {TypeError}
 */
export function decode(text, check) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new TypeError(`message is not JSON: ${cause.message}`);
  }
  const why = check(parsed);
  if (why !== null) throw new TypeError(`invalid message: ${why}`);
  return parsed;
}

export const decodeClientMessage = (text) => decode(text, whyInvalidClientMessage);
export const decodeServerMessage = (text) => decode(text, whyInvalidServerMessage);
