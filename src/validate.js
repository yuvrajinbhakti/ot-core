/**
 * Checking an operation that did not come from here.
 *
 * `insert()` and `remove()` validate their arguments, which covers operations
 * this library built. It does not cover the ones that matter: an operation
 * arriving over a socket is `JSON.parse` output, and a client can send anything
 * — a negative length, a position past the end of the document, a missing
 * field, a delete carrying content, a number that is a string.
 *
 * Without a check, those become someone else's problem in the worst possible
 * way. `apply` clamps out-of-range positions on purpose, so a malformed delete
 * does not throw; it silently removes the wrong text on the server and every
 * client converges on the damage. A validator turns that into a rejected
 * message.
 */

/** @typedef {import('./operation.js').Operation} Operation */

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * Why this operation is not usable, or `null` if it is.
 *
 * A string rather than a boolean, because the caller of this is a server
 * rejecting a client's message and "invalid operation" is not something anyone
 * can act on.
 *
 * @param {unknown} op
 * @param {number} [documentLength]
 *   Code-point length of the document the operation is written against. Omit to
 *   check only the operation's internal consistency — which is what you want
 *   when the document is not to hand, and it still catches most malformed
 *   input.
 * @returns {string | null}
 */
export function whyInvalid(op, documentLength) {
  if (op === null || typeof op !== 'object') return `expected an object, got ${typeof op}`;

  const { type, position, content, length } = /** @type {any} */ (op);

  if (type !== 'insert' && type !== 'delete') {
    return `type must be "insert" or "delete", got ${JSON.stringify(type)}`;
  }
  if (!isCount(position)) return `position must be a non-negative integer, got ${JSON.stringify(position)}`;
  if (!isCount(length)) return `length must be a non-negative integer, got ${JSON.stringify(length)}`;

  if (type === 'insert') {
    if (typeof content !== 'string') return `insert content must be a string, got ${typeof content}`;
    // Code points, not UTF-16 units — the same measure the rest of the library
    // uses. A mismatch here means the operation was built by hand with `.length`
    // and will be off by one for every emoji in it.
    const actual = Array.from(content).length;
    if (actual !== length) return `insert length is ${length} but the content is ${actual} code points`;
  } else {
    if (content !== '') return `delete content must be empty, got ${JSON.stringify(content)}`;
  }

  if (documentLength !== undefined) {
    if (!isCount(documentLength)) {
      return `documentLength must be a non-negative integer, got ${JSON.stringify(documentLength)}`;
    }
    if (position > documentLength) {
      return `position ${position} is past the end of a ${documentLength}-code-point document`;
    }
    if (type === 'delete' && position + length > documentLength) {
      return `delete of ${length} at ${position} runs past the end of a ${documentLength}-code-point document`;
    }
  }

  return null;
}

/**
 * @param {unknown} op
 * @param {number} [documentLength]
 * @returns {boolean}
 */
export function isValid(op, documentLength) {
  return whyInvalid(op, documentLength) === null;
}

/**
 * @param {unknown} op
 * @param {number} [documentLength]
 * @returns {Operation}  the same operation, for chaining
 * @throws {TypeError}
 */
export function assertValid(op, documentLength) {
  const why = whyInvalid(op, documentLength);
  if (why !== null) throw new TypeError(`invalid operation: ${why}`);
  return /** @type {Operation} */ (op);
}
