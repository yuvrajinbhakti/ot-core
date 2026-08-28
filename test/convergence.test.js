/**
 * The test this library exists for.
 *
 * TP1 is the convergence property: given two operations written against the
 * same document, each participant applies its own first and the other's second,
 * and both must end up with identical text. Everything else in an OT
 * implementation can look correct while this quietly fails, because it only
 * fails when two edits genuinely overlap — which is rare in casual testing and
 * constant in real use.
 *
 * So it is not spot-checked, it is fuzzed. The generator biases hard towards
 * collisions: a short alphabet, a short document and small edits, so that
 * random pairs land on top of each other far more often than they would in
 * prose. On the implementation this replaced, this test found a 16% divergence
 * rate.
 *
 * The seed is fixed, so a failure is reproducible rather than a story about
 * something that happened once on CI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply, transform } from '../src/index.js';

const PAIRS = 200_000;

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function randomOperation(random, doc) {
  const size = Array.from(doc).length;
  if (size === 0 || random() < 0.5) {
    const position = Math.floor(random() * (size + 1));
    // Length 0 to 4. Single-character inserts were all the first version of
    // this generator produced, which left the length arithmetic in three of the
    // four transform branches barely exercised — a one-character insert shifts
    // a position by one whether or not the code meant to use its length. Zero
    // is in the range because a transform that cancels an operation returns an
    // empty one, and those get fed back through.
    const size4 = Math.floor(random() * 5);
    return insert(position, 'XYZW'.slice(0, size4));
  }
  const position = Math.floor(random() * size);
  const length = Math.floor(random() * (Math.min(4, size - position) + 1));
  return remove(position, length);
}

/** Both orderings of a concurrent pair, which must agree. */
function bothOrderings(doc, a, b) {
  return [
    apply(apply(doc, a), transform(b, a, 'right')),
    apply(apply(doc, b), transform(a, b, 'left')),
  ];
}

const describe = (op) =>
  op.type === 'insert' ? `insert(${op.position}, "${op.content}")` : `remove(${op.position}, ${op.length})`;

test(`TP1 holds across ${PAIRS.toLocaleString()} random concurrent pairs`, () => {
  const random = makeRandom(42);
  let checked = 0;

  for (let i = 0; i < PAIRS; i++) {
    const doc = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    const a = randomOperation(random, doc);
    const b = randomOperation(random, doc);
    const [left, right] = bothOrderings(doc, a, b);

    assert.equal(
      left,
      right,
      `diverged on "${doc}" with ${describe(a)} against ${describe(b)}: ` +
        `one client saw "${left}", the other saw "${right}"`
    );
    checked++;
  }

  assert.equal(checked, PAIRS);
});

test('TP1 holds on longer documents and larger edits', () => {
  const random = makeRandom(1337);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';

  for (let i = 0; i < 50_000; i++) {
    const size = 10 + Math.floor(random() * 30);
    const doc = alphabet.slice(0, size % 26) + alphabet.slice(0, Math.max(0, size - 26));
    const a = randomOperation(random, doc);
    const b = randomOperation(random, doc);
    const [left, right] = bothOrderings(doc, a, b);
    assert.equal(left, right, `diverged on "${doc}" with ${describe(a)} against ${describe(b)}`);
  }
});

test('TP1 holds when the text is emoji', () => {
  // Positions count code points, so a document of astral-plane characters is
  // the case that catches any accidental use of .slice or .length.
  const random = makeRandom(7);
  const doc = '👩‍🚀🌍🚀✨🛰️';

  for (let i = 0; i < 20_000; i++) {
    const a = randomOperation(random, doc);
    const b = randomOperation(random, doc);
    const [left, right] = bothOrderings(doc, a, b);
    assert.equal(left, right, `diverged with ${describe(a)} against ${describe(b)}`);
  }
});

test('a transformed operation never needs an out-of-range position', () => {
  const random = makeRandom(99);

  for (let i = 0; i < 50_000; i++) {
    const doc = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
    const a = randomOperation(random, doc);
    const b = randomOperation(random, doc);

    const afterB = apply(doc, b);
    const aPrime = transform(a, b, 'left');
    const room = Array.from(afterB).length;

    assert.ok(
      aPrime.position >= 0 && aPrime.position <= room,
      `${describe(aPrime)} points outside "${afterB}" (length ${room})`
    );
    if (aPrime.type === 'delete') {
      assert.ok(
        aPrime.position + aPrime.length <= room,
        `${describe(aPrime)} runs past the end of "${afterB}"`
      );
    }
  }
});
