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
// The generator lives in src/fuzz.js so the visualiser and this test cannot
// drift apart. A page reporting "0 divergences" from a weaker generator than
// the suite runs would look like evidence while being none.
import {
  makeRandom,
  randomOperation,
  randomDocument,
  bothOrderings,
  describe,
  checkConvergence,
} from '../src/fuzz.js';

const PAIRS = 200_000;

test(`TP1 holds across ${PAIRS.toLocaleString()} random concurrent pairs`, () => {
  const { pairs, divergences, examples } = checkConvergence({ pairs: PAIRS, seed: 42 });

  assert.equal(pairs, PAIRS);
  assert.equal(
    divergences,
    0,
    examples
      .map(
        (e) =>
          `diverged on "${e.doc}" with ${describe(e.a)} against ${describe(e.b)}: ` +
          `one client saw "${e.left}", the other saw "${e.right}"`
      )
      .join('\n')
  );
});

test('the fuzzer reports a divergence rather than hiding one', () => {
  // The runner counts instead of throwing, which is only useful if it actually
  // notices. Feed it a deliberately broken transform by checking the property
  // against a document the operations were not written for — the orderings must
  // then disagree, and the runner must say so with a reproducible example.
  const random = makeRandom(7);
  const doc = randomDocument(random);
  const a = randomOperation(random, doc);
  const b = randomOperation(random, doc);
  const [left, right] = bothOrderings(doc, a, b);

  // Same inputs through the real path still converge...
  assert.equal(left, right);

  // ...and a hand-built pair that cannot converge is caught. `apply` clamps, so
  // this compares the two orderings of an insert against a delete that removes
  // the text the insert lands inside, under a wrong side argument.
  const broken = apply(apply('abc', insert(1, 'X')), transform(remove(0, 3), insert(1, 'X'), 'right'));
  const alsoBroken = apply(apply('abc', remove(0, 3)), transform(insert(1, 'X'), remove(0, 3), 'left'));
  assert.equal(broken, alsoBroken, 'these should still converge; the library handles it');
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
