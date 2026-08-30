/**
 * The CodeMirror binding, against real ChangeSets.
 *
 * `@codemirror/state` is pure — no DOM — so the conversions can be fuzzed here
 * the way everything else in this suite is. The half that needs a browser (the
 * ViewPlugin, the echo annotation) is exercised in demo/editor.html and driven
 * for real; what is below is the arithmetic, which is where the bugs live.
 *
 * The property: whatever CodeMirror did to its document, applying the
 * operations this produces to the same text must produce the same result. If
 * that holds for every change set a fuzzer can build — multiple cursors, emoji,
 * replacements, deletions that span them — the binding cannot silently disagree
 * with the editor it is bound to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, insert, remove } from '../src/index.js';

let cm = null;
try {
  cm = await import('@codemirror/state');
} catch {
  // Peer dependency, absent. Say so rather than fail.
}
const skip = cm
  ? false
  : '@codemirror/state is not installed — run `npm install` to include the binding tests';

const mod = cm ? await import('../src/codemirror.js') : null;

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const show = (op) =>
  op.type === 'insert' ? `insert(${op.position}, ${JSON.stringify(op.content)})` : `remove(${op.position}, ${op.length})`;

test('code point and UTF-16 offsets convert both ways', { skip }, () => {
  const { Text } = cm;
  const { toCodePoint, toOffset } = mod;

  const doc = Text.of(['a🚀b👩‍🚀c']);
  const text = doc.toString();
  const points = [...text].length;

  // Round trip every code-point position.
  for (let cp = 0; cp <= points; cp++) {
    assert.equal(toCodePoint(doc, toOffset(doc, cp)), cp, `code point ${cp} did not round trip`);
  }

  // And the boundary that matters: an emoji is one position, two units.
  assert.equal(toCodePoint(doc, 0), 0);
  assert.equal(toOffset(doc, 1), 1);          // after "a"
  assert.equal(toOffset(doc, 2), 3);          // after the rocket — two units
  assert.ok(toOffset(doc, points) === text.length);
});

test('offsets are clamped rather than trusted', { skip }, () => {
  const { Text } = cm;
  const { toCodePoint, toOffset } = mod;
  const doc = Text.of(['abc']);
  assert.equal(toCodePoint(doc, -5), 0);
  assert.equal(toCodePoint(doc, 99), 3);
  assert.equal(toOffset(doc, -1), 0);
  assert.equal(toOffset(doc, 99), 3);
});

test('a simple insert becomes one operation', { skip }, () => {
  const { Text, ChangeSet } = cm;
  const before = Text.of(['the fox']);
  const changes = ChangeSet.of({ from: 4, insert: 'quick ' }, before.length);
  assert.deepEqual(mod.operationsFromChanges(before, changes), [insert(4, 'quick ')]);
});

test('a replacement becomes a delete and then an insert', { skip }, () => {
  const { Text, ChangeSet } = cm;
  const before = Text.of(['the slow fox']);
  const changes = ChangeSet.of({ from: 4, to: 8, insert: 'quick' }, before.length);
  assert.deepEqual(mod.operationsFromChanges(before, changes), [remove(4, 4), insert(4, 'quick')]);
  assert.equal(applyAll(before.toString(), mod.operationsFromChanges(before, changes)), 'the quick fox');
});

test('two cursors typing at once both land in the right place', { skip }, () => {
  // The case the running offset exists for. With one cursor it cannot be wrong;
  // with two, dropping it puts the second edit at the position it held before
  // the first one changed the document's length.
  const { Text, ChangeSet } = cm;
  const before = Text.of(['aaa bbb ccc']);
  const changes = ChangeSet.of(
    [{ from: 3, insert: 'X' }, { from: 7, insert: 'Y' }],
    before.length
  );

  const ops = mod.operationsFromChanges(before, changes);
  assert.deepEqual(ops, [insert(3, 'X'), insert(8, 'Y')]);
  assert.equal(applyAll(before.toString(), ops), changes.apply(before).toString());
});

test('an emoji is one position to this library and two to the editor', { skip }, () => {
  const { Text, ChangeSet } = cm;
  const before = Text.of(['a🚀b']);
  assert.equal(before.length, 4);                    // UTF-16 units
  assert.equal([...before.toString()].length, 3);    // code points

  // Insert after the rocket: offset 3 in the editor, position 2 here.
  const changes = ChangeSet.of({ from: 3, insert: '!' }, before.length);
  assert.deepEqual(mod.operationsFromChanges(before, changes), [insert(2, '!')]);
  assert.equal(applyAll(before.toString(), mod.operationsFromChanges(before, changes)), 'a🚀!b');
});

test('deleting an emoji removes one position, not two', { skip }, () => {
  const { Text, ChangeSet } = cm;
  const before = Text.of(['a🚀b']);
  const changes = ChangeSet.of({ from: 1, to: 3 }, before.length);
  assert.deepEqual(mod.operationsFromChanges(before, changes), [remove(1, 1)]);
  assert.equal(applyAll(before.toString(), mod.operationsFromChanges(before, changes)), 'ab');
});

test('an operation becomes the change that applies it', { skip }, () => {
  const { Text } = cm;
  const doc = Text.of(['a🚀b']);
  assert.deepEqual(mod.changeFromOperation(doc, insert(2, '!')), { from: 3, insert: '!' });
  assert.deepEqual(mod.changeFromOperation(doc, remove(1, 1)), { from: 1, to: 3 });
});

test('a no-op produces no change at all', { skip }, () => {
  // transform() returns empty operations routinely. Dispatching one would still
  // make a transaction, push an undo entry and wake every listener.
  const { Text } = cm;
  const doc = Text.of(['abc']);
  assert.equal(mod.changeFromOperation(doc, remove(0, 0)), null);
  assert.equal(mod.changeFromOperation(doc, insert(0, '')), null);
});

test('operations agree with the editor across 50,000 random change sets', { skip }, () => {
  const { Text, ChangeSet } = cm;
  const random = makeRandom(9001);
  const alphabets = ['abcdefgh', 'ab🚀cd👩‍🚀ef', '0123456789abcdef'];

  for (let i = 0; i < 50_000; i++) {
    const alphabet = alphabets[Math.floor(random() * alphabets.length)];
    const before = Text.of([alphabet.slice(0, 3 + Math.floor(random() * (alphabet.length - 2)))]);
    const length = before.length;

    // One to three non-overlapping changes, left to right, which is what a
    // multi-cursor edit produces.
    const specs = [];
    let cursor = 0;
    const count = 1 + Math.floor(random() * 3);
    for (let k = 0; k < count && cursor < length; k++) {
      const from = cursor + Math.floor(random() * Math.max(1, length - cursor));
      const to = Math.min(length, from + Math.floor(random() * 3));
      const inserted = random() < 0.5 ? '' : 'XY'.slice(0, 1 + Math.floor(random() * 2));
      if (from === to && inserted === '') { cursor = from + 1; continue; }
      specs.push(inserted === '' ? { from, to } : { from, to, insert: inserted });
      cursor = to + 1;
    }
    if (specs.length === 0) continue;

    const changes = ChangeSet.of(specs, length);
    const throughEditor = changes.apply(before).toString();
    // A change that cut a character in half leaves a lone surrogate, which this
    // library will not reproduce and should not — see the test below. Those are
    // not what an editor produces and are not what this property is about.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(throughEditor)) continue;

    const ops = mod.operationsFromChanges(before, changes);
    assert.equal(
      applyAll(before.toString(), ops),
      throughEditor,
      `disagreed on ${JSON.stringify(before.toString())} with ${JSON.stringify(specs)}: ` +
        `[${ops.map(show).join(', ')}]`
    );
  }
});

test('a change that cuts a character in half is widened to cover it', { skip }, () => {
  // CodeMirror will do this if a program asks, and the result is a document
  // containing half an emoji. This library counts whole code points and cannot
  // say "half of one", so rather than emit an operation that quietly means
  // something else, the range is snapped outward.
  const { Text, ChangeSet } = cm;
  const before = Text.of(['a🚀b']);

  const split = ChangeSet.of({ from: 2, to: 3 }, before.length);
  assert.match(split.apply(before).toString(), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    'CodeMirror really does leave a lone surrogate');

  const ops = mod.operationsFromChanges(before, split);
  assert.deepEqual(ops, [remove(1, 1)], 'the whole character goes instead');
  assert.equal(applyAll(before.toString(), ops), 'ab');
});

test('applying an operation matches what the library would do, 50,000 times', { skip }, () => {
  const { Text, ChangeSet } = cm;
  const random = makeRandom(4242);

  for (let i = 0; i < 50_000; i++) {
    const source = random() < 0.5 ? 'abcdefgh' : 'ab🚀cd👩‍🚀ef';
    const text = source.slice(0, 3 + Math.floor(random() * (source.length - 2)));
    const doc = Text.of([text]);
    const points = [...text].length;

    const op = random() < 0.5
      ? insert(Math.floor(random() * (points + 1)), 'XY'.slice(0, 1 + Math.floor(random() * 2)))
      : remove(
          Math.floor(random() * points),
          Math.floor(random() * 3)
        );

    const change = mod.changeFromOperation(doc, op);
    const throughEditor = change
      ? ChangeSet.of(change, doc.length).apply(doc).toString()
      : text;

    assert.equal(
      throughEditor,
      applyAll(text, [op]),
      `${show(op)} on ${JSON.stringify(text)}: editor gave ${JSON.stringify(throughEditor)}`
    );
  }
});
