/**
 * Turning "the textarea used to say X and now says Y" into operations.
 *
 * This is the bridge between an editor and the algorithm. A textarea gives you
 * a new value, not an edit; without this you would have to intercept every
 * keystroke, and you would still miss paste, drag-and-drop, autocorrect and
 * undo.
 *
 * The diff is a common-prefix/common-suffix trim, not a real edit-distance
 * algorithm. That is the right choice here: a human editing text produces one
 * contiguous change per event, and Myers diff would cost far more to find the
 * same answer. It is wrong only for edits that touch two distant places at
 * once, which a single input event cannot produce.
 */

import { insert, remove } from './operation.js';

/**
 * @param {string} before
 * @param {string} after
 * @returns {import('./operation.js').Operation[]}
 *   Zero ops if the text is unchanged, one for a pure insert or delete, two —
 *   delete then insert — for a replacement. Apply them in the order returned.
 */
export function diff(before, after) {
  if (before === after) return [];

  const oldChars = Array.from(before);
  const newChars = Array.from(after);

  let start = 0;
  const shortest = Math.min(oldChars.length, newChars.length);
  while (start < shortest && oldChars[start] === newChars[start]) start++;

  let oldEnd = oldChars.length;
  let newEnd = newChars.length;
  while (oldEnd > start && newEnd > start && oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const removed = oldEnd - start;
  const added = newChars.slice(start, newEnd).join('');

  // Delete first, then insert. The reverse order would make the insert's
  // position depend on text that is about to disappear.
  if (removed > 0 && added.length > 0) return [remove(start, removed), insert(start, added)];
  if (removed > 0) return [remove(start, removed)];
  return [insert(start, added)];
}
