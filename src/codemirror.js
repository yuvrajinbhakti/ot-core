/**
 * Binding this to a real editor.
 *
 * The playground drives textareas, which is the easy case: one selection, no
 * decorations, and a whole new value handed to you on every keystroke so a diff
 * is enough. CodeMirror gives you the edits themselves, several at once when
 * there are several cursors, and expects you to hand edits back — which is a
 * much closer fit for what this library is, and a much better test of it.
 *
 * Two things this has to get right, and both are the kind of thing that works
 * until somebody pastes an emoji or opens a second cursor:
 *
 * **Units.** CodeMirror counts UTF-16 code units. This library counts code
 * points, deliberately, so that an emoji is one position rather than two. Every
 * offset crossing this boundary is converted; none is passed through.
 *
 * **Echo.** An operation arriving from the server is applied to the editor,
 * which fires the same update listener a local keystroke does. Sent back, it
 * would arrive at the server twice. Remote transactions carry an annotation and
 * are ignored on the way out.
 *
 * Peer dependency, not a dependency: `@codemirror/state` and `@codemirror/view`
 * are yours, and nothing else in this package imports them, so `ot-core` is
 * still zero-dependency for everybody who does not import this file.
 */

import { Annotation } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { insert, remove } from './operation.js';

/** @typedef {import('./operation.js').Operation} Operation */

/**
 * Marks a transaction as one this binding applied, so the update listener knows
 * not to send it back out.
 */
export const fromCollaborator = Annotation.define();

/* ------------------------------------------------------------------ units */

/**
 * Surrogate pairs are the entire difference between the two coordinate systems,
 * so counting them converts between them without allocating a character array
 * for the whole document.
 */
function surrogatePairs(text) {
  let pairs = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        pairs++;
        i++;
      }
    }
  }
  return pairs;
}

/**
 * Is this offset in the middle of a character?
 *
 * CodeMirror's own editing never lands here — cursor motion and its delete
 * commands are code-point aware — but a programmatic `dispatch` can ask to cut
 * an emoji in half, and CodeMirror will do it, leaving a lone surrogate in the
 * document. This library counts whole code points and has no way to say "half
 * of one", so rather than quietly producing an operation that means something
 * else, boundaries are snapped outward: a range that starts inside a character
 * starts before it, and one that ends inside a character ends after it. The
 * edit covers whole characters, which is what the user meant and what leaves
 * the document a valid string.
 *
 * @param {import('@codemirror/state').Text} doc
 * @param {number} offset
 * @param {'down' | 'up'} direction
 * @returns {number}  an offset on a character boundary
 */
export function snapToBoundary(doc, offset, direction) {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  if (clamped === 0 || clamped === doc.length) return clamped;
  const pair = doc.sliceString(clamped - 1, clamped + 1);
  const high = pair.charCodeAt(0);
  const low = pair.charCodeAt(1);
  const inside = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  if (!inside) return clamped;
  return direction === 'down' ? clamped - 1 : clamped + 1;
}

/**
 * @param {import('@codemirror/state').Text} doc
 * @param {number} offset  UTF-16 code units
 * @returns {number}  code points
 */
export function toCodePoint(doc, offset) {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  return clamped - surrogatePairs(doc.sliceString(0, clamped));
}

/**
 * @param {import('@codemirror/state').Text} doc
 * @param {number} position  code points
 * @returns {number}  UTF-16 code units
 */
export function toOffset(doc, position) {
  if (position <= 0) return 0;
  const text = doc.toString();
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (seen === position) return i;
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    seen++;
  }
  return text.length;
}

/* ------------------------------------------------------- editor -> library */

/**
 * The operations equivalent to a CodeMirror change set.
 *
 * `iterChanges` reports every change in the coordinates of the document *before*
 * the transaction, left to right. This library applies operations one at a time,
 * each against the document as the previous one left it — so the running offset
 * below is the net effect of everything already applied, and it is what makes
 * multiple cursors work. Dropping it looks fine with one cursor and puts every
 * edit after the first in the wrong place with two.
 *
 * A replacement becomes a delete and then an insert, in that order, which is
 * what `diff` does and for the same reason: the reverse would place the insert
 * against text that is about to disappear.
 *
 * @param {import('@codemirror/state').Text} before  the document before the change
 * @param {import('@codemirror/state').ChangeSet} changes
 * @returns {Operation[]}  to apply in order
 */
export function operationsFromChanges(before, changes) {
  const operations = [];
  let shift = 0;

  changes.iterChanges((rawFrom, rawTo, _fromB, _toB, inserted) => {
    // Snapped outward first, so a range that cuts a character in half becomes
    // one that covers it. See snapToBoundary.
    const fromA = snapToBoundary(before, rawFrom, 'down');
    const toA = Math.max(fromA, snapToBoundary(before, rawTo, 'up'));

    const at = toCodePoint(before, fromA) + shift;
    const removed = toCodePoint(before, toA) - toCodePoint(before, fromA);
    const text = inserted.toString();
    const added = removed === 0 && text === '' ? 0 : [...text].length;

    if (removed > 0) operations.push(remove(at, removed));
    if (text !== '') operations.push(insert(at, text));

    shift += added - removed;
  });

  return operations;
}

/* ------------------------------------------------------- library -> editor */

/**
 * The CodeMirror change equivalent to one operation, or null for a no-op.
 *
 * `transform` produces empty operations routinely — an edit cancelled by a
 * concurrent delete comes back with a length of zero — and dispatching an empty
 * change would still create a transaction, push an undo entry, and fire every
 * listener for nothing.
 *
 * @param {import('@codemirror/state').Text} doc  the document to apply it to
 * @param {Operation} op
 * @returns {{ from: number, to?: number, insert?: string } | null}
 */
export function changeFromOperation(doc, op) {
  if (op.length === 0) return null;
  const from = toOffset(doc, op.position);
  if (op.type === 'insert') return { from, insert: op.content };
  return { from, to: toOffset(doc, op.position + op.length) };
}

/* ------------------------------------------------------------- the binding */

/**
 * A CodeMirror extension that keeps an editor and an ot-core `Client` in step.
 *
 * ```js
 * const view = new EditorView({
 *   doc: client.document,
 *   parent: element,
 *   extensions: [collaborate(client)],
 * });
 * ```
 *
 * The editor's own selection needs nothing from this library: CodeMirror maps
 * it through the change set it is given, which is the same arithmetic
 * `transformPosition` does. `transformPosition` is for positions held outside
 * the editor — other people's cursors, a comment anchor — and this binding does
 * not invent presence to have somewhere to use it.
 *
 * @param {import('./client.js').Client} client
 * @returns {import('@codemirror/state').Extension}
 */
export function collaborate(client) {
  return ViewPlugin.define((view) => {
    // Chained rather than replaced, so an application that already listens for
    // remote operations keeps its callback.
    const previous = client.onRemote;

    client.onRemote = (op) => {
      const change = changeFromOperation(view.state.doc, op);
      if (change) {
        view.dispatch({ changes: change, annotations: fromCollaborator.of(true) });
      }
      previous?.(op);
    };

    return {
      update(update) {
        if (!update.docChanged) return;
        // Ours coming back. Sending it would deliver the same edit twice.
        if (update.transactions.some((tr) => tr.annotation(fromCollaborator))) return;

        for (const op of operationsFromChanges(update.startState.doc, update.changes)) {
          client.edit(op);
        }
      },
      destroy() {
        client.onRemote = previous;
      },
    };
  });
}
