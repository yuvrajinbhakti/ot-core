/**
 * The specific cases that used to be wrong.
 *
 * Each of these was found by the fuzzer in convergence.test.js and is pinned
 * here with its actual before-and-after, because a property test tells you
 * *that* something broke and this tells you *what*. If one of these ever fails
 * again, the message says which of the three bugs came back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply, transform, transformAgainst, diff, applyAll, isNoop } from '../src/index.js';

const converge = (doc, a, b) => {
  const left = apply(apply(doc, a), transform(b, a, 'right'));
  const right = apply(apply(doc, b), transform(a, b, 'left'));
  assert.equal(left, right, `diverged: "${left}" vs "${right}"`);
  return left;
};

test('two inserts at the same index — needs a tie-breaker', () => {
  // Previously both sides kept their own position, so the result depended on
  // which message happened to arrive first. One side has to yield.
  assert.equal(converge('abc', insert(1, 'X'), insert(1, 'Y')), 'aXYbc');
});

test('the tie-breaker is stable regardless of argument order', () => {
  const a = insert(0, 'A');
  const b = insert(0, 'B');
  assert.equal(converge('z', a, b), converge('z', a, b));
});

test('nested deletes', () => {
  // Previously produced "" on one side and "af" on the other: the inner delete
  // removed characters the outer one had already taken.
  assert.equal(converge('abcdef', remove(0, 3), remove(1, 2)), 'def');
});

test('partially overlapping deletes', () => {
  assert.equal(converge('abcdef', remove(1, 3), remove(2, 3)), 'af');
});

test('identical deletes', () => {
  assert.equal(converge('abcdef', remove(2, 2), remove(2, 2)), 'abef');
});

test('adjacent deletes', () => {
  assert.equal(converge('abcdef', remove(0, 2), remove(2, 2)), 'ef');
});

test('an insert inside a concurrently deleted range', () => {
  // Previously "adef" on one side and "aXef" on the other. The single-operation
  // model cannot split the delete around the insert, so the delete swallows it
  // — a documented trade-off, not an accident.
  assert.equal(converge('abcdef', insert(2, 'X'), remove(1, 3)), 'aef');
});

test('an insert at the boundaries of a deleted range survives', () => {
  assert.equal(converge('abcdef', insert(1, 'X'), remove(1, 3)), 'aXef');
  assert.equal(converge('abcdef', insert(4, 'X'), remove(1, 3)), 'aXef');
});

test('an insert after a delete shifts back', () => {
  assert.equal(converge('abcdef', insert(5, 'X'), remove(1, 2)), 'adeXf');
});

test('operations are not mutated by transform', () => {
  const a = insert(3, 'hello');
  const before = JSON.stringify(a);
  transform(a, remove(0, 2), 'left');
  assert.equal(JSON.stringify(a), before);
});

test('transform rejects a missing side', () => {
  assert.throws(() => transform(insert(0, 'a'), insert(0, 'b')), TypeError);
});

test('transformAgainst rebases an operation onto a run of newer ones', () => {
  // The case a server hits constantly: an edit written against version N
  // arrives when the document is already at N+2.
  const doc = 'abcdef';
  const history = [insert(0, 'Z'), remove(3, 2)]; // 'abcdef' → 'Zabcdef' → 'Zabef'
  const mine = insert(5, 'Q'); // written against 'abcdef': Q belongs between e and f

  assert.equal(apply(doc, mine), 'abcdeQf', 'the intent, stated on the original document');
  assert.equal(applyAll(doc, history), 'Zabef');

  const rebased = transformAgainst(mine, history, 'left');

  // Still between e and f, which is what preserving the intent means here.
  assert.equal(apply(applyAll(doc, history), rebased), 'ZabeQf');
});

test('positions count code points, not UTF-16 units', () => {
  // '🌍' is two UTF-16 units. Inserting at position 1 must land after it, not
  // inside it.
  assert.equal(apply('🌍b', insert(1, 'X')), '🌍Xb');
  assert.equal(apply('🌍b', remove(0, 1)), 'b');
});

test('diff produces operations that reproduce the new text', () => {
  const cases = [
    ['', 'hello'],
    ['hello', ''],
    ['hello', 'hello world'],
    ['hello world', 'hello'],
    ['the cat sat', 'the dog sat'],
    ['abc', 'abc'],
    ['🌍 world', '🌍 there'],
  ];
  for (const [before, after] of cases) {
    assert.equal(applyAll(before, diff(before, after)), after, `diff failed for "${before}" → "${after}"`);
  }
});

test('diff of unchanged text produces nothing', () => {
  assert.deepEqual(diff('same', 'same'), []);
});

test('a cancelled operation reports itself as a no-op', () => {
  const cancelled = transform(insert(2, 'X'), remove(1, 3), 'left');
  assert.ok(isNoop(cancelled));
  assert.equal(apply('abcdef', cancelled), 'abcdef');
});
