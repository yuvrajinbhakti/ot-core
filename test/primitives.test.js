/**
 * The two primitives, given input they should refuse.
 *
 * `apply` and `transform` are the most-called functions in this library and the
 * least defended. Both used to fail in the direction this whole project is about:
 * quietly doing something wrong rather than refusing.
 *
 *   apply('abc', { type: 'wat', position: 0, length: 1 })  // → "bc"
 *
 * The dispatch read `if (type === 'insert') { ... }` and fell through to delete
 * for everything else, so any unrecognised type silently removed text.
 *
 *   transform(insert(0, 'a'), { type: 'nope' }, 'left')
 *   // → { type: 'insert', position: NaN, content: 'a', length: NaN }
 *
 * None of the four branches matched, so it fell through to arithmetic against
 * `undefined` and manufactured an operation with a NaN position — which `apply`
 * then clamps to 0, landing the text in the wrong place instead of erroring.
 *
 * The wire path was never exposed to this: the server validates on arrival and
 * again after rebasing. What was exposed is a *caller* of this library building
 * an operation by hand, or an editor binding producing one with a typo. For them
 * the failure was silent, and silent is the one thing this library is supposed
 * not to be.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply, transform } from '../src/index.js';

describe('apply refuses what it cannot do', () => {
  test('an unrecognised type throws rather than deleting', () => {
    assert.throws(
      () => apply('abc', { type: 'wat', position: 0, length: 1 }),
      /type/,
      'an unknown type must not fall through to delete'
    );
  });

  test('a missing type throws', () => {
    assert.throws(() => apply('abc', { position: 0, length: 1 }), /type/);
  });

  test('a non-object operation throws', () => {
    for (const bad of [null, undefined, 'insert', 42, []]) {
      assert.throws(() => apply('abc', bad), TypeError, `apply should reject ${JSON.stringify(bad)}`);
    }
  });

  test('a non-string document throws rather than being coerced', () => {
    // `apply(42, insert(0, 'x'))` used to return "x" — Array.from(42) is [],
    // so the document silently became the empty string and then the insert.
    for (const bad of [42, null, undefined, {}, ['a']]) {
      assert.throws(() => apply(bad, insert(0, 'x')), TypeError, `apply should reject doc ${JSON.stringify(bad)}`);
    }
  });

  test('a non-integer position throws rather than clamping to zero', () => {
    assert.throws(() => apply('abc', { type: 'insert', position: NaN, content: 'x', length: 1 }), /position/);
    assert.throws(() => apply('abc', { type: 'delete', position: 1.5, content: '', length: 1 }), /position/);
  });

  test('valid operations still work exactly as before', () => {
    assert.equal(apply('abc', insert(1, 'XY')), 'aXYbc');
    assert.equal(apply('abc', remove(1, 1)), 'ac');
    // Clamping out-of-range positions is deliberate and stays: a transformed
    // operation can legitimately point just past the end of a shrunken document.
    assert.equal(apply('abc', insert(99, 'x')), 'abcx');
    assert.equal(apply('abc', remove(1, 99)), 'a');
    assert.equal(apply('👍👍', insert(1, 'X')), '👍X👍');
  });
});

describe('transform refuses what it cannot rebase', () => {
  test('a malformed operand throws rather than producing NaN', () => {
    assert.throws(
      () => transform(insert(0, 'a'), { type: 'nope' }, 'left'),
      /type/,
      'transform must not fall through to arithmetic against undefined'
    );
  });

  test('either side being malformed is caught', () => {
    assert.throws(() => transform({ type: 'nope' }, insert(0, 'a'), 'left'), /type/);
    assert.throws(() => transform(insert(0, 'a'), null, 'left'), TypeError);
    assert.throws(() => transform(null, insert(0, 'a'), 'left'), TypeError);
  });

  test('the result of a valid transform is never NaN', () => {
    // The property that was actually violated: whatever comes out is applicable.
    for (const a of [insert(0, 'x'), insert(3, 'yy'), remove(0, 2), remove(1, 1)]) {
      for (const b of [insert(0, 'z'), insert(2, 'w'), remove(0, 1), remove(2, 2)]) {
        for (const side of ['left', 'right']) {
          const out = transform(a, b, side);
          assert.ok(Number.isInteger(out.position), `position was ${out.position}`);
          assert.ok(Number.isInteger(out.length), `length was ${out.length}`);
        }
      }
    }
  });

  test('a bad side still throws, as it always did', () => {
    assert.throws(() => transform(insert(0, 'a'), insert(0, 'b'), 'sideways'), /side/);
    assert.throws(() => transform(insert(0, 'a'), insert(0, 'b')), /side/);
  });

  test('valid transforms are unchanged', () => {
    assert.deepEqual(transform(insert(0, 'a'), insert(0, 'b'), 'left'), insert(0, 'a'));
    assert.deepEqual(transform(insert(0, 'a'), insert(0, 'b'), 'right'), insert(1, 'a'));
    assert.deepEqual(transform(insert(5, 'a'), remove(0, 2), 'left'), insert(3, 'a'));
  });
});
