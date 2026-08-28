/**
 * Operations, and applying them to text.
 *
 * An operation is a plain object with no identity, no timestamp and no author —
 * deliberately. Those belong to whatever transport carries them; baking them in
 * here would make every operation unequal to every other one and make the tests
 * below impossible to write.
 *
 * Positions count Unicode code points, not UTF-16 units, so an emoji is one
 * position rather than two. `Array.from` is what makes that true, and it is the
 * reason this does not use `String.prototype.slice`.
 */

/** @typedef {{ type: 'insert'|'delete', position: number, content: string, length: number }} Operation */

/**
 * @param {number} position  code-point offset to insert at
 * @param {string} content
 * @returns {Operation}
 */
export function insert(position, content) {
  if (!Number.isInteger(position) || position < 0) {
    throw new RangeError(`insert() position must be a non-negative integer, got ${position}`);
  }
  const text = String(content);
  return { type: 'insert', position, content: text, length: Array.from(text).length };
}

/**
 * @param {number} position  code-point offset to delete from
 * @param {number} length    number of code points to remove
 * @returns {Operation}
 */
export function remove(position, length) {
  if (!Number.isInteger(position) || position < 0) {
    throw new RangeError(`remove() position must be a non-negative integer, got ${position}`);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`remove() length must be a non-negative integer, got ${length}`);
  }
  return { type: 'delete', position, content: '', length };
}

/** Does this operation change anything? */
export function isNoop(op) {
  return op.length === 0;
}

/**
 * Apply an operation to a string.
 *
 * Out-of-range positions are clamped rather than thrown, because a transformed
 * operation can legitimately point just past the end of a document that shrank,
 * and a library that throws there is unusable in the exact situation it exists
 * for.
 *
 * @param {string} doc
 * @param {Operation} op
 * @returns {string}
 */
export function apply(doc, op) {
  const chars = Array.from(doc);
  const position = Math.max(0, Math.min(op.position, chars.length));

  if (op.type === 'insert') {
    chars.splice(position, 0, ...Array.from(op.content));
    return chars.join('');
  }

  chars.splice(position, Math.max(0, Math.min(op.length, chars.length - position)));
  return chars.join('');
}

/**
 * Apply several operations in order.
 *
 * @param {string} doc
 * @param {Operation[]} ops
 * @returns {string}
 */
export function applyAll(doc, ops) {
  return ops.reduce(apply, doc);
}
