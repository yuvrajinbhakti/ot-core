/**
 * The law invert has to obey:
 *
 *     apply(apply(doc, op), invert(op, doc)) === doc
 *
 * and the harder one, which is the whole reason undo in a shared document is
 * not just "apply the inverse": by the time somebody presses Ctrl-Z, other
 * people have edited. The inverse has to be transformed past everything that
 * happened since, and the last test here is that round trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  insert, remove, apply, applyAll, invert, invertAll, transform, transformAgainst,
} from '../src/index.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const show = (op) =>
  op.type === 'insert' ? `insert(${op.position}, "${op.content}")` : `remove(${op.position}, ${op.length})`;

function randomOperation(random, doc) {
  const size = Array.from(doc).length;
  if (size === 0 || random() < 0.5) {
    const position = Math.floor(random() * (size + 1));
    return insert(position, 'XYZW'.slice(0, Math.floor(random() * 5)));
  }
  const position = Math.floor(random() * size);
  return remove(position, Math.floor(random() * (Math.min(4, size - position) + 1)));
}

test('an operation and its inverse leave the document alone, 200,000 times', () => {
  const random = makeRandom(555);

  for (let i = 0; i < 200_000; i++) {
    const doc = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    const op = randomOperation(random, doc);
    const after = apply(doc, op);

    assert.equal(
      apply(after, invert(op, doc)),
      doc,
      `${show(op)} on "${doc}" did not round trip: "${apply(after, invert(op, doc))}"`
    );
  }
});

test('inverting is exact on emoji', () => {
  const random = makeRandom(9);
  const doc = '👩‍🚀🌍🚀✨🛰️';

  for (let i = 0; i < 20_000; i++) {
    const op = randomOperation(random, doc);
    assert.equal(apply(apply(doc, op), invert(op, doc)), doc, show(op));
  }
});

test('a run inverts to a run that undoes it, in the right order', () => {
  const random = makeRandom(777);

  for (let i = 0; i < 20_000; i++) {
    const start = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    let doc = start;
    const ops = [];
    const count = 1 + Math.floor(random() * 5);
    for (let k = 0; k < count; k++) {
      const op = randomOperation(random, doc);
      ops.push(op);
      doc = apply(doc, op);
    }

    assert.equal(
      applyAll(doc, invertAll(ops, start)),
      start,
      `undoing [${ops.map(show).join(', ')}] from "${start}" landed on "${applyAll(doc, invertAll(ops, start))}"`
    );
  }
});

test('invert refuses an operation that is not in range for the document', () => {
  // `apply` clamps on purpose, so a delete past the end quietly removes from
  // the end instead. Inverting that would put the text back somewhere else and
  // call it an undo, which is worse than an error.
  assert.throws(() => invert(remove(50, 2), 'short'), /past the end/);
});

test('undo still works when somebody else edited in the meantime', () => {
  // The case that makes collaborative undo hard. A types, B types elsewhere,
  // A undoes — and must remove only what A wrote, leaving B's work alone.
  const start = 'the quick fox';

  const mine = insert(10, 'brown ');            // "the quick brown fox"
  const afterMine = apply(start, mine);
  const theirs = insert(0, 'oh, ');             // written against afterMine
  const afterBoth = apply(afterMine, theirs);
  assert.equal(afterBoth, 'oh, the quick brown fox');

  // My inverse was written against `afterMine`. It has to be moved past their
  // edit before it means anything in the document as it now stands.
  const undo = transform(invert(mine, start), theirs, 'left');

  assert.equal(apply(afterBoth, undo), 'oh, the quick fox');
});

test('undoing text somebody else already deleted does nothing further', () => {
  // Worth pinning down, because the intuitive expectation is wrong and it cost
  // me an afternoon believing the library was broken.
  //
  // Undo here means "remove what is left of my contribution", not "recompute
  // history as though I had never typed". Those come apart the moment somebody
  // deletes across your text: the character is already gone, so the rebased
  // inverse is correctly a no-op. Recomputing history without you is exclusion
  // transformation, a different and harder operation, and this library does not
  // claim to do it.
  const start = 'abcdef';
  const mine = insert(3, 'X');                 // "abcXdef"
  const theirs = remove(1, 4);                 // eats "bcXd" -> "aef"

  const doc = apply(apply(start, mine), theirs);
  assert.equal(doc, 'aef');

  const undo = transform(invert(mine, start), theirs, 'left');
  assert.equal(apply(doc, undo), 'aef', 'the X was already gone; undo has nothing to remove');
});

test('undo obeys the same convergence law as everything else, 20,000 times', () => {
  // The honest statement of what a rebased inverse guarantees. It is TP1 again,
  // with the inverse playing the part of the concurrent operation:
  //
  //   apply(their edits, then my rebased undo)
  //     === apply(my undo, then their edits rebased past it)
  //
  // Both participants end at the same text, which is the only property undo can
  // be held to in a shared document.
  const random = makeRandom(4004);

  for (let i = 0; i < 20_000; i++) {
    const start = 'abcdefgh'.slice(0, 4 + Math.floor(random() * 5));
    const mine = randomOperation(random, start);
    const afterMine = apply(start, mine);

    let doc = afterMine;
    const theirs = [];
    const count = 1 + Math.floor(random() * 4);
    for (let k = 0; k < count; k++) {
      const op = randomOperation(random, doc);
      theirs.push(op);
      doc = apply(doc, op);
    }

    // One side: their whole run, then my undo moved past all of it.
    const undone = apply(doc, transformAgainst(invert(mine, start), theirs, 'left'));

    // The other: my undo first, then their run moved past it one at a time —
    // rebasing the inverse as we go, which is the same mutual transform a
    // client does while it has an operation in flight.
    let inverse = invert(mine, start);
    let other = apply(afterMine, inverse);
    for (const op of theirs) {
      other = apply(other, transform(op, inverse, 'right'));
      inverse = transform(inverse, op, 'left');
    }

    assert.equal(
      undone,
      other,
      `undoing ${show(mine)} on "${start}" after [${theirs.map(show).join(', ')}]: ` +
        `"${undone}" vs "${other}"`
    );
  }
});
