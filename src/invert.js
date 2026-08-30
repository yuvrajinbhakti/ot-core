/**
 * The operation that undoes an operation.
 *
 * Needed for undo, and it is the reason undo in a collaborative editor is
 * harder than it looks. Inverting is the easy half; the hard half is that by
 * the time somebody presses Ctrl-Z, other people have edited the document, so
 * the inverse has to be transformed past everything that happened since — which
 * is `transform`, already here. What was missing was the inverse itself.
 *
 * An insert knows what it inserted, so its inverse needs nothing else. A delete
 * does not record what it removed — deliberately, because carrying the text
 * would double the size of every delete on the wire for the benefit of the
 * minority of them that are ever undone. So `invert` takes the document the
 * operation was applied to and reads the text back out of it.
 */

import { insert, remove, apply } from './operation.js';

/** @typedef {import('./operation.js').Operation} Operation */

/**
 * @param {Operation} op
 * @param {string} doc  the document *before* `op` was applied
 * @returns {Operation}
 *
 * @example
 *   apply(apply(doc, op), invert(op, doc)) === doc
 */
export function invert(op, doc) {
  if (op.type === 'insert') return remove(op.position, op.length);

  const chars = Array.from(doc);
  if (op.position > chars.length) {
    // `apply` clamps an out-of-range position, so it would quietly delete from
    // the end and the inverse would put the text back somewhere else. Refusing
    // is better than a round trip that silently is not one.
    throw new RangeError(
      `invert(): operation at ${op.position} is past the end of a ${chars.length}-code-point document`
    );
  }
  return insert(op.position, chars.slice(op.position, op.position + op.length).join(''));
}

/**
 * Invert a run, so it can be applied as a run.
 *
 * The order reverses — undoing A then B means undoing B first — and each
 * inverse has to be taken against the document as it stood before its own
 * operation, which means walking forwards to collect the intermediate states
 * before walking back.
 *
 * @param {readonly Operation[]} ops  in the order they were applied
 * @param {string} doc  the document before the first of them
 * @returns {Operation[]}  in the order they should be applied to undo
 */
export function invertAll(ops, doc) {
  const states = [doc];
  let current = doc;
  for (const op of ops) {
    current = apply(current, op);
    states.push(current);
  }
  const out = [];
  for (let i = ops.length - 1; i >= 0; i--) out.push(invert(ops[i], states[i]));
  return out;
}
