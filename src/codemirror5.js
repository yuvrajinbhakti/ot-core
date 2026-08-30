/**
 * The same binding, for CodeMirror 5.
 *
 * CodeMirror 6 is a rewrite with a different data model, and the version 5 line
 * is still what a very large number of deployed editors are actually running —
 * including, as it turns out, the one this library was written because of. A
 * binding that only supports 6 is a binding that cannot be dropped into the
 * codebase that needed it.
 *
 * Three differences from the version 6 binding, all of them consequences of the
 * older API rather than choices:
 *
 * **Positions are line/ch, not offsets.** CodeMirror 5 addresses the document by
 * `{line, ch}`. `indexFromPos` and `posFromIndex` convert, and every offset that
 * crosses into this library is converted again from UTF-16 code units to code
 * points, exactly as in the version 6 binding and for the same reason: an emoji
 * is one position here and two there.
 *
 * **Changes arrive as a list, in document order, already applied.** The
 * `changes` event fires after the fact with each change in the coordinates of
 * the document *before* the batch, which is the same situation `iterChanges`
 * creates in version 6 and needs the same running offset to resolve.
 *
 * **There are no transaction annotations.** Version 6 tags a transaction so the
 * update listener can recognise its own work coming back. Version 5 has
 * `origin` strings on changes instead, so remote edits are applied with a
 * distinguished origin and filtered on the way out. It is the same mechanism
 * wearing different clothes.
 *
 * Peer dependency, not a dependency: `codemirror` is yours, and nothing else in
 * this package imports it.
 */

import { insert, remove } from './operation.js';

/** @typedef {import('./operation.js').Operation} Operation */

/**
 * The `origin` given to changes this binding applies, so the outgoing listener
 * can tell them from something the user typed.
 *
 * CodeMirror treats an origin beginning with `+` as mergeable into an adjacent
 * undo entry and one beginning with `*` as not; a bare word like this is neither,
 * which is what a remote edit should be — it must never join the local user's
 * undo entry, because undoing your own typing would then also undo somebody
 * else's.
 */
export const REMOTE_ORIGIN = 'ot-core';

/* ------------------------------------------------------------------ units */

/** As in the version 6 binding: surrogate pairs are the whole difference. */
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
 * Is this offset in the middle of a character, and if so which way out?
 *
 * The same decision as the version 6 binding, made explicitly here rather than
 * left to fall out of the arithmetic. Rounding both ends down — which is what
 * `toCodePoint` alone does — quietly *excludes* a character the range was
 * covering, so a delete that ended inside an emoji would leave half of it
 * behind. Snapping outward makes the edit cover whole characters, which is what
 * the user meant and what leaves the document a valid string.
 *
 * CodeMirror's own editing never lands here; a programmatic `replaceRange` can.
 *
 * @param {string} text
 * @param {number} offset  UTF-16 code units
 * @param {'down' | 'up'} direction
 * @returns {number}  an offset on a character boundary
 */
export function snapToBoundary(text, offset, direction) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (clamped === 0 || clamped === text.length) return clamped;
  const high = text.charCodeAt(clamped - 1);
  const low = text.charCodeAt(clamped);
  const inside = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  if (!inside) return clamped;
  return direction === 'down' ? clamped - 1 : clamped + 1;
}

/**
 * @param {string} text  the whole document
 * @param {number} offset  UTF-16 code units
 * @returns {number}  code points
 */
export function toCodePoint(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  return clamped - surrogatePairs(text.slice(0, clamped));
}

/**
 * @param {string} text  the whole document
 * @param {number} position  code points
 * @returns {number}  UTF-16 code units
 */
export function toOffset(text, position) {
  if (position <= 0) return 0;
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
 * The operations equivalent to one CodeMirror 5 `changes` batch.
 *
 * **The coordinate system is not the one version 6 uses, and this is the whole
 * reason this function is not shared with the other binding.** CodeMirror 6's
 * `iterChanges` reports every change against the document as it was before the
 * transaction, so converting it needs a running offset. CodeMirror 5 pushes a
 * change object as each change is applied, so every entry after the first is
 * already in the coordinates the previous ones left behind — the changes are
 * sequential, not simultaneous.
 *
 * Carrying version 6's running offset across to this API therefore
 * double-counts, and does so only when a single batch produces more than one
 * change: one cursor is always right, two are always wrong. Walking a working
 * copy instead needs no offset at all, and it produces operations already in
 * the form `Client.edit` wants — each against the document the previous one
 * left.
 *
 * @param {string} before  the document before the batch
 * @param {Array<{from: object, to: object, text: string[], removed?: string[]}>} changes
 * @returns {Operation[]}  to apply in order
 */
export function operationsFromChanges(before, changes) {
  const operations = [];
  let doc = before;

  for (const change of changes) {
    const index = indexIn(doc);
    // Snapped outward first, so a range that cuts a character in half becomes
    // one that covers it. See snapToBoundary.
    const fromUnits = snapToBoundary(doc, index(change.from), 'down');
    const toUnits = Math.max(fromUnits, snapToBoundary(doc, index(change.to), 'up'));
    const text = change.text.join('\n');

    const at = toCodePoint(doc, fromUnits);
    const removed = toCodePoint(doc, toUnits) - at;

    // Delete before insert, as `diff` does: the reverse would anchor the insert
    // against text that is about to disappear.
    if (removed > 0) operations.push(remove(at, removed));
    if (text !== '') operations.push(insert(at, text));

    doc = doc.slice(0, fromUnits) + text + doc.slice(toUnits);
  }

  return operations;
}

/* ------------------------------------------------------- library -> editor */

/**
 * Apply one operation to a CodeMirror 5 instance.
 *
 * A zero-length operation is skipped rather than dispatched — `transform`
 * produces those routinely when an edit is cancelled by a concurrent delete, and
 * replacing a range with itself still fires every listener and pushes an undo
 * entry for nothing.
 *
 * @param {any} cm  a CodeMirror 5 instance
 * @param {Operation} op
 */
export function applyOperation(cm, op) {
  if (op.length === 0) return;
  const text = cm.getValue();
  const from = cm.posFromIndex(toOffset(text, op.position));

  if (op.type === 'insert') {
    cm.replaceRange(op.content, from, from, REMOTE_ORIGIN);
    return;
  }
  const to = cm.posFromIndex(toOffset(text, op.position + op.length));
  cm.replaceRange('', from, to, REMOTE_ORIGIN);
}

/* ------------------------------------------------------------- the binding */

/**
 * Keep a CodeMirror 5 editor and an ot-core `Client` in step.
 *
 * ```js
 * const detach = collaborate(cm, client);
 * ```
 *
 * The local cursor needs no help: CodeMirror maps its own selection through the
 * replacement it is given. Other people's cursors do, and that is what
 * `presence.js` is for — this returns the detach function and stays out of it.
 *
 * @param {any} cm  a CodeMirror 5 instance
 * @param {import('./client.js').Client} client
 * @returns {() => void}  detach
 */
export function collaborate(cm, client) {
  const previousRemote = client.onRemote;
  let applying = false;

  client.onRemote = (op) => {
    // Guards the listener below. Without it the edit we have just applied is
    // read back out and sent to the server, which delivers it to everyone a
    // second time.
    applying = true;
    try {
      applyOperation(cm, op);
    } finally {
      applying = false;
    }
    previousRemote?.(op);
  };

  // The document as it was before the batch about to be reported. CodeMirror 5
  // fires `changes` after applying, so the pre-image has to be captured on
  // `beforeChange` — reconstructing it from the change list is possible and is
  // exactly the sort of arithmetic this binding exists to avoid duplicating.
  let before = cm.getValue();

  const onBeforeChange = () => {
    if (!applying) before = cm.getValue();
  };

  const onChanges = (instance, changes) => {
    if (applying) return;
    // Ours coming back, or somebody else's binding on the same editor.
    if (changes.every((c) => c.origin === REMOTE_ORIGIN)) return;

    for (const op of operationsFromChanges(before, changes)) client.edit(op);
    before = instance.getValue();
  };

  cm.on('beforeChange', onBeforeChange);
  cm.on('changes', onChanges);

  return () => {
    cm.off('beforeChange', onBeforeChange);
    cm.off('changes', onChanges);
    client.onRemote = previousRemote;
  };
}

/**
 * A `{line, ch}` → index converter for a document the editor no longer holds.
 *
 * Line starts are computed once per batch rather than per change, because a
 * paste into a large file can report a great many changes and rescanning the
 * document for each is the difference between instant and noticeable.
 */
function indexIn(text) {
  const lineStart = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStart.push(i + 1);
  }
  return (pos) => {
    const line = Math.max(0, Math.min(pos.line, lineStart.length - 1));
    return Math.min(lineStart[line] + pos.ch, text.length);
  };
}
