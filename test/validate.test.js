/**
 * Operations that did not come from this library.
 *
 * `insert()` and `remove()` check their arguments, which covers nothing that
 * matters: the dangerous operation is the one a client sent over a socket and
 * `JSON.parse` handed back. `apply` clamps out-of-range positions deliberately,
 * so a malformed delete does not throw — it removes the wrong text, the server
 * accepts it, and every client converges on the damage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, isValid, whyInvalid, assertValid } from '../src/index.js';

test('operations this library builds are valid', () => {
  assert.ok(isValid(insert(0, 'hello')));
  assert.ok(isValid(remove(3, 2)));
  assert.ok(isValid(insert(0, '')));
  assert.ok(isValid(insert(2, '👩‍🚀')));
});

test('it rejects what a socket can actually deliver', () => {
  const bad = [
    [null, /expected an object/],
    ['insert', /expected an object/],
    [{}, /type must be/],
    [{ type: 'replace', position: 0, content: '', length: 0 }, /type must be/],
    [{ type: 'insert', position: -1, content: 'a', length: 1 }, /position must be/],
    [{ type: 'insert', position: 1.5, content: 'a', length: 1 }, /position must be/],
    [{ type: 'insert', position: '3', content: 'a', length: 1 }, /position must be/],
    [{ type: 'delete', position: 0, content: '', length: -2 }, /length must be/],
    [{ type: 'insert', position: 0, content: 5, length: 1 }, /content must be a string/],
    [{ type: 'delete', position: 0, content: 'oops', length: 1 }, /delete content must be empty/],
  ];

  for (const [op, pattern] of bad) {
    assert.ok(!isValid(op), `${JSON.stringify(op)} should be invalid`);
    assert.match(whyInvalid(op), pattern);
  }
});

test('an insert whose length disagrees with its content is rejected', () => {
  // The exact shape you get from building an operation by hand with .length on
  // a string containing an emoji: UTF-16 units, not code points.
  const rocket = '🚀';
  assert.equal(rocket.length, 2);
  const handBuilt = { type: 'insert', position: 0, content: rocket, length: rocket.length };
  assert.ok(!isValid(handBuilt));
  assert.match(whyInvalid(handBuilt), /length is 2 but the content is 1 code points/);

  assert.ok(isValid(insert(0, rocket)));
});

test('it checks the operation against the document when given one', () => {
  assert.ok(isValid(insert(5, 'x'), 5), 'inserting at the very end is fine');
  assert.ok(!isValid(insert(6, 'x'), 5));
  assert.match(whyInvalid(insert(6, 'x'), 5), /past the end of a 5-code-point document/);

  assert.ok(isValid(remove(3, 2), 5), 'deleting up to the end is fine');
  assert.ok(!isValid(remove(3, 3), 5));
  assert.match(whyInvalid(remove(3, 3), 5), /runs past the end/);
});

test('the document length is measured in code points too', () => {
  const doc = '🚀🚀🚀';
  assert.equal(doc.length, 6);
  const codePoints = Array.from(doc).length;
  assert.equal(codePoints, 3);
  assert.ok(isValid(remove(1, 2), codePoints));
  assert.ok(!isValid(remove(1, 3), codePoints));
});

test('assertValid throws with the reason, and returns the operation otherwise', () => {
  const op = insert(1, 'ok');
  assert.equal(assertValid(op), op);
  assert.throws(() => assertValid({ type: 'insert', position: -4, content: '', length: 0 }), {
    name: 'TypeError',
    message: /invalid operation: position must be a non-negative integer, got -4/,
  });
});

test('a no-op is valid — transform produces them routinely', () => {
  assert.ok(isValid(remove(0, 0)));
  assert.ok(isValid(insert(0, '')));
});
