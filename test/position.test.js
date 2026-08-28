/**
 * Cursor transformation, checked against the document rather than against my
 * own expectations.
 *
 * The property that matters: if a cursor sat immediately before some character,
 * it should still sit immediately before that same character afterwards. That
 * is testable without hand-writing a single expected number — mark the
 * character, apply the operation, and see whether the transformed position
 * still points at the mark.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply } from '../src/index.js';
import { transformPosition, transformSelection } from '../src/position.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test('a cursor keeps pointing at the same character', () => {
  const random = makeRandom(11);
  let checked = 0;

  for (let i = 0; i < 100_000; i++) {
    const doc = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    const chars = Array.from(doc);
    // The cursor sits immediately before chars[position].
    const position = Math.floor(random() * chars.length);
    const marked = chars[position];

    const op =
      random() < 0.5
        ? insert(Math.floor(random() * (chars.length + 1)), 'XY'.slice(0, 1 + Math.floor(random() * 2)))
        : remove(
            Math.floor(random() * chars.length),
            1 + Math.floor(random() * Math.min(3, chars.length - Math.floor(random() * chars.length) || 1))
          );

    const after = Array.from(apply(doc, op));
    const moved = transformPosition(position, op);

    assert.ok(moved >= 0 && moved <= after.length, `${moved} is outside "${after.join('')}"`);

    const deleted =
      op.type === 'delete' && position >= op.position && position < op.position + op.length;
    // An insert landing exactly on the cursor is the bias case: with the
    // default the cursor deliberately holds its offset, so it now points at the
    // arriving text rather than at the character it used to precede. That is
    // the documented behaviour, not drift, and it is asserted separately below.
    const onTheBoundary = op.type === 'insert' && op.position === position;
    if (!deleted && !onTheBoundary) {
      assert.equal(
        after[moved],
        marked,
        `cursor drifted: was before "${marked}" in "${doc}", now before "${after[moved]}" in "${after.join('')}"`
      );
    }
    checked++;
  }

  assert.equal(checked, 100_000);
});

test('an insert before the cursor pushes it along', () => {
  assert.equal(transformPosition(5, insert(0, 'abc')), 8);
});

test('an insert after the cursor leaves it alone', () => {
  assert.equal(transformPosition(5, insert(9, 'abc')), 5);
});

test('an insert exactly at the cursor respects the bias', () => {
  // A remote insert at your caret should not drag the caret with it.
  assert.equal(transformPosition(5, insert(5, 'abc'), 'left'), 5);
  // ...but the local echo of your own typing should.
  assert.equal(transformPosition(5, insert(5, 'abc'), 'right'), 8);
});

test('a delete before the cursor pulls it back', () => {
  assert.equal(transformPosition(9, remove(2, 3)), 6);
});

test('a delete after the cursor leaves it alone', () => {
  assert.equal(transformPosition(2, remove(5, 3)), 2);
});

test('a cursor inside deleted text collapses to where the text was', () => {
  assert.equal(transformPosition(7, remove(5, 4)), 5);
});

test('a cursor on the boundary of a delete', () => {
  assert.equal(transformPosition(5, remove(5, 4)), 5);
  assert.equal(transformPosition(9, remove(5, 4)), 5);
});

test('a selection does not swallow text inserted at its edges', () => {
  const selection = { anchor: 3, head: 7 }; // covers the characters at 3,4,5,6

  // Inserted at the start: lands before the selection, which slides right and
  // still covers exactly the characters it did.
  assert.deepEqual(transformSelection(selection, insert(3, 'XY')), { anchor: 5, head: 9 });

  // Inserted at the end: lands after the selection, which does not grow.
  assert.deepEqual(transformSelection(selection, insert(7, 'XY')), { anchor: 3, head: 7 });
});

test('a selection covers the same characters after a remote edit', () => {
  const doc = 'abcdefgh';
  const selection = { anchor: 3, head: 6 };
  const selected = doc.slice(selection.anchor, selection.head); // 'def'

  for (const op of [insert(0, 'XY'), insert(3, 'XY'), insert(6, 'XY'), insert(8, 'XY'), remove(0, 2)]) {
    const after = apply(doc, op);
    const moved = transformSelection(selection, op);
    assert.equal(
      after.slice(moved.anchor, moved.head),
      selected,
      `selection drifted off "${selected}" after ${JSON.stringify(op)} — got "${after.slice(moved.anchor, moved.head)}"`
    );
  }
});

test('a backwards selection keeps its direction', () => {
  const backwards = { anchor: 7, head: 3 };
  const moved = transformSelection(backwards, insert(0, 'XY'));
  assert.deepEqual(moved, { anchor: 9, head: 5 });
  assert.deepEqual(transformSelection(backwards, insert(7, 'XY')), { anchor: 7, head: 3 });
  assert.ok(moved.anchor > moved.head, 'still backwards');
});

test('a collapsed selection stays collapsed', () => {
  const caret = { anchor: 4, head: 4 };
  for (const op of [insert(4, 'XY'), insert(0, 'Z'), remove(0, 2), remove(3, 3)]) {
    const moved = transformSelection(caret, op);
    assert.equal(moved.anchor, moved.head, `split apart by ${JSON.stringify(op)}`);
  }
});

test('a selection wholly inside a delete collapses to a caret', () => {
  assert.deepEqual(transformSelection({ anchor: 4, head: 6 }, remove(2, 8)), { anchor: 2, head: 2 });
});

test('transformPosition rejects a negative position', () => {
  assert.throws(() => transformPosition(-1, insert(0, 'a')), RangeError);
});
