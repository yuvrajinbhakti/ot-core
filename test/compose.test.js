/**
 * The law compose has to obey:
 *
 *     apply(doc, compose(a, b)) === apply(apply(doc, a), b)
 *
 * whenever compose returns anything at all. Returning `null` is always allowed —
 * it means "these two stay two" — so a compose that never merged anything would
 * pass this file trivially. The last test in it is the one that stops that being
 * a way to cheat: it asserts a rate, so a regression that quietly stops merging
 * shows up as a failure rather than as a slower wire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply, applyAll, compose, composeAll, isNoop } from '../src/index.js';

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

test('compose(a, b) means exactly a then b, over 200,000 random pairs', () => {
  const random = makeRandom(31337);
  let merged = 0;

  for (let i = 0; i < 200_000; i++) {
    const doc = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    const a = randomOperation(random, doc);
    const afterA = apply(doc, a);
    // `b` is written against the document as it stands after `a`, which is the
    // contract and also the only way a sequential pair ever arises.
    const b = randomOperation(random, afterA);

    const both = compose(a, b);
    if (both === null) continue;
    merged++;

    assert.equal(
      apply(doc, both),
      apply(afterA, b),
      `compose(${show(a)}, ${show(b)}) = ${show(both)} on "${doc}" ` +
        `gave "${apply(doc, both)}" instead of "${apply(afterA, b)}"`
    );
  }

  // Not a coverage target, a floor. If this drops, compose has stopped doing
  // its job while still passing every assertion above.
  assert.ok(merged > 40_000, `only ${merged} of 200,000 pairs composed`);
});

test('compose is correct on emoji, where a code point is not a UTF-16 unit', () => {
  const random = makeRandom(2);
  const doc = '👩‍🚀🌍🚀✨🛰️';

  for (let i = 0; i < 20_000; i++) {
    const a = randomOperation(random, doc);
    const afterA = apply(doc, a);
    const b = randomOperation(random, afterA);
    const both = compose(a, b);
    if (both === null) continue;
    assert.equal(apply(doc, both), apply(afterA, b), `compose(${show(a)}, ${show(b)})`);
  }
});

test('typing a word is one operation, not one per keystroke', () => {
  // The case compose exists for. Five keystrokes, five inserts, one message.
  const word = Array.from('hello');
  const ops = word.map((char, i) => insert(4 + i, char));

  const collapsed = composeAll(ops);
  assert.equal(collapsed.length, 1, `expected 1 operation, got ${collapsed.map(show).join(', ')}`);
  assert.deepEqual(collapsed[0], insert(4, 'hello'));
  assert.equal(applyAll('the ', ops), applyAll('the ', collapsed));
});

test('backspacing over what you just typed leaves nothing to send', () => {
  const ops = [
    insert(3, 'abc'),
    remove(5, 1),
    remove(4, 1),
    remove(3, 1),
  ];
  assert.equal(applyAll('the', ops), 'the');
  assert.deepEqual(composeAll(ops), [], 'a run that cancels itself should compose to nothing');
});

test('backspace composes backwards, which is the direction it deletes in', () => {
  const composed = compose(remove(5, 1), remove(4, 1));
  assert.deepEqual(composed, remove(4, 2));
  assert.equal(apply(apply('abcdefg', remove(5, 1)), remove(4, 1)), apply('abcdefg', composed));
});

test('edits in two places stay two operations', () => {
  assert.equal(compose(insert(0, 'a'), insert(40, 'b')), null);
  assert.equal(compose(remove(0, 1), remove(40, 1)), null);
});

test('a replacement is irreducibly two operations', () => {
  // Which is why diff() returns two for one edit. Nothing here can merge them.
  assert.equal(compose(remove(2, 3), insert(2, 'xyz')), null);
});

test('composing with a no-op returns the other operation', () => {
  const op = insert(3, 'hi');
  assert.deepEqual(compose(op, remove(0, 0)), op);
  assert.deepEqual(compose(insert(0, ''), op), op);
});

test('composeAll leaves a run of scattered edits alone', () => {
  const ops = [insert(0, 'a'), insert(40, 'b'), insert(80, 'c')];
  assert.equal(composeAll(ops).length, 3);
});

test('composeAll never changes what a run does, over 20,000 random runs', () => {
  const random = makeRandom(808);

  for (let i = 0; i < 20_000; i++) {
    let doc = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    const start = doc;
    const ops = [];
    const count = 1 + Math.floor(random() * 6);
    for (let k = 0; k < count; k++) {
      const op = randomOperation(random, doc);
      ops.push(op);
      doc = apply(doc, op);
    }

    const collapsed = composeAll(ops);
    assert.equal(
      applyAll(start, collapsed),
      applyAll(start, ops),
      `composeAll changed the result on "${start}": [${ops.map(show).join(', ')}]`
    );
    assert.ok(collapsed.length <= ops.length);
    assert.ok(collapsed.every((op) => !isNoop(op)), 'composeAll should not emit no-ops');
  }
});
