/**
 * Merging two sequential operations into one.
 *
 * This library used to say compose was impossible in this model, on the grounds
 * that two operations far apart in a document cannot be expressed as one
 * position and one length. That is true and it is not the interesting case.
 *
 * The interesting case is typing. Five keystrokes produce five inserts at
 * consecutive positions, and those *are* one insert. Somebody holding down a key
 * for a second produces twenty. Every one of them is a message on the wire, an
 * entry in the server's history that every future operation must be transformed
 * against, and a separate step in an undo stack that will undo one character at
 * a time. Collapsing them is worth doing even if it only works sometimes,
 * because "sometimes" is most of what a person actually does to a document.
 *
 * So: compose where the model allows it, and say so plainly where it does not.
 * `null` means "these two need to stay two", which is a real answer rather than
 * a failure.
 */

import { insert, remove, isNoop } from './operation.js';

/** @typedef {import('./operation.js').Operation} Operation */

/**
 * One operation equivalent to `a` then `b`, or `null` if the model cannot
 * express it.
 *
 * `b` must be written against the document as it stands *after* `a` — which is
 * what you have naturally when both come from the same editor in sequence.
 *
 *     apply(doc, compose(a, b)) === apply(apply(doc, a), b)
 *
 * test/compose.test.js asserts that over every pair the fuzzer can produce.
 *
 * @param {Operation} a  applied first
 * @param {Operation} b  applied second, against the result of `a`
 * @returns {Operation | null}
 */
export function compose(a, b) {
  // A no-op composed with anything is that thing. Worth handling first because
  // transform() produces no-ops routinely — an operation cancelled by a
  // concurrent delete comes back empty — and they would otherwise fall through
  // to the position arithmetic below and fail to merge for no good reason.
  if (isNoop(a)) return b;
  if (isNoop(b)) return a;

  if (a.type === 'insert' && b.type === 'insert') {
    // `b` lands inside or at either end of the text `a` inserted.
    const offset = b.position - a.position;
    if (offset < 0 || offset > a.length) return null;
    const chars = Array.from(a.content);
    return insert(
      a.position,
      chars.slice(0, offset).join('') + b.content + chars.slice(offset).join('')
    );
  }

  if (a.type === 'delete' && b.type === 'delete') {
    // Both are expressed in their own document, and after `a` the text that
    // surrounded it is adjacent. `b` continues the same deletion if it starts
    // exactly at that seam (running forward) or ends exactly at it (running
    // backward, which is what backspace does).
    if (b.position === a.position || b.position + b.length === a.position) {
      return remove(Math.min(a.position, b.position), a.length + b.length);
    }
    return null;
  }

  if (a.type === 'insert' && b.type === 'delete') {
    // Only when the delete falls wholly within the inserted text — typing and
    // then backspacing over it. A delete that also reaches into the surrounding
    // document needs both an insert and a delete to express, which is two
    // operations however you write it.
    const offset = b.position - a.position;
    if (offset < 0 || offset + b.length > a.length) return null;
    const chars = Array.from(a.content);
    chars.splice(offset, b.length);
    // An empty insert, if the delete ate all of it. That is a no-op, which is
    // the correct answer: typing "abc" and deleting "abc" changed nothing.
    return insert(a.position, chars.join(''));
  }

  // delete then insert at the same place is a replacement, and a replacement is
  // irreducibly two operations in this model — which is exactly why diff()
  // returns two of them for one. Nothing to merge.
  return null;
}

/**
 * Compose a run as far as it will go, left to right.
 *
 * Returns a shorter array, not a single operation, because a run of edits
 * scattered around a document genuinely is several operations. A burst of
 * typing collapses to one; typing in two paragraphs collapses to two.
 *
 * @param {readonly Operation[]} ops  in application order
 * @returns {Operation[]}
 */
export function composeAll(ops) {
  const out = [];
  for (const op of ops) {
    if (out.length === 0) {
      out.push(op);
      continue;
    }
    const merged = compose(out[out.length - 1], op);
    if (merged === null) out.push(op);
    else out[out.length - 1] = merged;
  }
  // A run that cancels itself out — type five characters, delete all five —
  // leaves one empty operation. Dropping it is the difference between sending
  // nothing and sending a message that means nothing.
  return out.filter((op) => !isNoop(op));
}
