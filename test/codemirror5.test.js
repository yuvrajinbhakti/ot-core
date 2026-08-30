/**
 * The CodeMirror 5 binding.
 *
 * CodeMirror 5 is a DOM library — there is no pure half to import the way
 * `@codemirror/state` gives one for version 6 — so the arithmetic is fuzzed
 * against a faithful model of what the editor does, and the wiring is driven
 * through a small stand-in that implements exactly the four methods the binding
 * touches.
 *
 * The property is the same one the version 6 test uses, which is the only
 * property that matters for a binding: whatever the editor did to its document,
 * applying the operations produced from it must produce the same text. The model
 * below is the definition of "what the editor did", so it has to be right — it
 * replaces the range between two `{line, ch}` positions with the joined text,
 * sequentially, which is `replaceRange` and is all CodeMirror 5 does here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, insert, remove } from '../src/index.js';
import { Client } from '../src/client.js';
import {
  snapToBoundary,
  operationsFromChanges,
  applyOperation,
  collaborate,
  toCodePoint,
  toOffset,
  REMOTE_ORIGIN,
} from '../src/codemirror5.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/* --------------------------------------------------- the editor's own model */

function indexFromPos(text, pos) {
  const lines = text.split('\n');
  let index = 0;
  for (let i = 0; i < pos.line; i++) index += lines[i].length + 1;
  return Math.min(index + pos.ch, text.length);
}

function posFromIndex(text, index) {
  const clamped = Math.max(0, Math.min(index, text.length));
  const upto = text.slice(0, clamped).split('\n');
  return { line: upto.length - 1, ch: upto[upto.length - 1].length };
}

/** What CodeMirror 5 would produce, applying each change as it is reported. */
function applyChanges(text, changes) {
  let doc = text;
  for (const change of changes) {
    const from = indexFromPos(doc, change.from);
    const to = Math.max(from, indexFromPos(doc, change.to));
    doc = doc.slice(0, from) + change.text.join('\n') + doc.slice(to);
  }
  return doc;
}

/* -------------------------------------------------------------------- units */

test('code point and code unit offsets round trip through emoji', () => {
  const text = 'a😀b👨‍👩‍👧c\nd🎉';
  for (let position = 0; position <= [...text].length; position++) {
    assert.equal(toCodePoint(text, toOffset(text, position)), position);
  }
});

test('an emoji is one position, not two', () => {
  const text = 'a😀b';
  assert.equal(toCodePoint(text, text.length), 3);
  assert.equal(toOffset(text, 2), 3, 'the character after the emoji starts at code unit 3');
});

/* -------------------------------------------------- editor -> library, fuzzed */

test('operations reproduce whatever the editor did', () => {
  const random = makeRandom(97);
  let multi = 0;

  for (let trial = 0; trial < 5000; trial++) {
    const seed = ['hello world', 'a😀b\ncd', 'one\ntwo\nthree', '', 'x'][trial % 5];

    // One to three changes, each in the coordinates the previous ones left —
    // which is what CodeMirror 5 reports.
    const changes = [];
    let doc = seed;
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      // Snapped to character boundaries, because a change that slices a
      // surrogate pair in half is not something CodeMirror produces — and the
      // binding deliberately refuses to reproduce it, so fuzzing it would be
      // asserting that a documented behaviour is a bug. The mid-character case
      // is covered on its own below.
      const a = snapToBoundary(doc, Math.floor(random() * (doc.length + 1)), 'down');
      const b = snapToBoundary(doc, Math.floor(random() * (doc.length + 1)), 'down');
      const fromIndex = Math.min(a, b);
      const toIndex = Math.max(a, b);
      const inserted = [['X'], ['ab', 'cd'], [''], ['😀'], ['', '']][Math.floor(random() * 5)];

      const change = {
        from: posFromIndex(doc, fromIndex),
        to: posFromIndex(doc, toIndex),
        text: inserted,
        origin: '+input',
      };
      changes.push(change);
      doc = applyChanges(doc, [change]);
    }
    if (changes.length > 1) multi++;

    const expected = applyChanges(seed, changes);
    const operations = operationsFromChanges(seed, changes);
    const actual = applyAll(seed, operations);

    assert.equal(
      actual,
      expected,
      `diverged from the editor\n  seed: ${JSON.stringify(seed)}\n  changes: ${JSON.stringify(changes)}`
    );
  }

  assert.ok(multi > 2000, `only ${multi} batches had more than one change`);
});

test('two changes in one batch are not double-counted', () => {
  // The bug that carrying version 6's running offset into this API produces.
  // One cursor hides it completely; two put the second edit in the wrong place.
  const seed = 'abcdef';
  const changes = [
    { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, text: ['1'], origin: '+input' },
    { from: { line: 0, ch: 4 }, to: { line: 0, ch: 4 }, text: ['2'], origin: '+input' },
  ];
  assert.equal(applyAll(seed, operationsFromChanges(seed, changes)), applyChanges(seed, changes));
  assert.equal(applyChanges(seed, changes), '1abc2def');
});

test('a range that cuts a character in half is widened to cover it', () => {
  // Snapping outward rather than inward: a delete ending inside an emoji must
  // take the whole emoji, not leave a lone surrogate behind. Rounding both ends
  // down — which the offset conversion does on its own — would silently do the
  // latter, so the snap is explicit.
  const seed = 'a😀b';
  const changes = [
    // `to` lands between the surrogates of the emoji.
    { from: { line: 0, ch: 1 }, to: { line: 0, ch: 2 }, text: [''], origin: '+input' },
  ];
  const result = applyAll(seed, operationsFromChanges(seed, changes));
  assert.equal(result, 'ab', 'the emoji was split instead of removed whole');
  assert.ok(!/[\ud800-\udfff]/.test(result), 'a lone surrogate survived');
});

test('a replacement becomes a delete then an insert', () => {
  const seed = 'hello world';
  const changes = [
    { from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 }, text: ['goodbye'], origin: '+input' },
  ];
  const ops = operationsFromChanges(seed, changes);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, 'delete');
  assert.equal(ops[1].type, 'insert');
  assert.equal(applyAll(seed, ops), 'goodbye world');
});

/* ------------------------------------------------------- a stand-in editor */

/**
 * The four methods `collaborate` and `applyOperation` actually use, and nothing
 * else. Faithful to CodeMirror 5's semantics for those four; not an editor.
 */
function fakeEditor(initial) {
  let value = initial;
  const handlers = new Map();
  return {
    getValue: () => value,
    posFromIndex: (index) => posFromIndex(value, index),
    indexFromPos: (pos) => indexFromPos(value, pos),
    replaceRange(text, from, to, origin) {
      const a = indexFromPos(value, from);
      const b = Math.max(a, indexFromPos(value, to));
      const change = {
        from,
        to,
        text: text.split('\n'),
        removed: value.slice(a, b).split('\n'),
        origin,
      };
      for (const fn of handlers.get('beforeChange') ?? []) fn(this, change);
      value = value.slice(0, a) + text + value.slice(b);
      for (const fn of handlers.get('changes') ?? []) fn(this, [change]);
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    off(event, fn) {
      const list = handlers.get(event) ?? [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    },
  };
}

test('applyOperation puts remote text in the right place', () => {
  const cm = fakeEditor('hello world');
  applyOperation(cm, insert(5, ' there'));
  assert.equal(cm.getValue(), 'hello there world');
  applyOperation(cm, remove(0, 6));
  assert.equal(cm.getValue(), 'there world');
});

test('applyOperation counts code points, not code units', () => {
  const cm = fakeEditor('a😀b');
  applyOperation(cm, insert(2, 'X')); // after the emoji
  assert.equal(cm.getValue(), 'a😀Xb');
});

test('a zero-length operation is not dispatched', () => {
  const cm = fakeEditor('abc');
  let fired = 0;
  cm.on('changes', () => fired++);
  applyOperation(cm, remove(1, 0));
  assert.equal(fired, 0, 'an empty change still fired every listener');
  assert.equal(cm.getValue(), 'abc');
});

test('local typing reaches the client', () => {
  const sent = [];
  const client = new Client({ id: 'me', send: (m) => sent.push(m), document: 'abc' });
  const cm = fakeEditor('abc');
  collaborate(cm, client);

  cm.replaceRange('X', { line: 0, ch: 1 }, { line: 0, ch: 1 }, '+input');
  assert.equal(client.document, 'aXbc');
});

test('a remote operation is not sent back out', () => {
  // The echo. Without the guard the edit we just applied is read back and
  // delivered to everybody a second time.
  let sends = 0;
  const client = new Client({ id: 'me', send: () => sends++, document: 'abc' });
  const cm = fakeEditor('abc');
  collaborate(cm, client);

  client.onRemote(insert(0, 'Z'));

  assert.equal(cm.getValue(), 'Zabc', 'the remote edit did not reach the editor');
  assert.equal(sends, 0, 'the remote edit was echoed back to the server');
  assert.equal(client.document, 'abc', 'the echo was applied as a local edit');
});

test('an edit whose origin is ours alone is ignored on the way out', () => {
  let sends = 0;
  const client = new Client({ id: 'me', send: () => sends++, document: 'abc' });
  const cm = fakeEditor('abc');
  collaborate(cm, client);

  cm.replaceRange('Q', { line: 0, ch: 0 }, { line: 0, ch: 0 }, REMOTE_ORIGIN);
  assert.equal(sends, 0);
});

test('detaching restores the previous handler and stops listening', () => {
  const client = new Client({ id: 'me', send: () => {}, document: 'abc' });
  const previous = () => {};
  client.onRemote = previous;

  const cm = fakeEditor('abc');
  const detach = collaborate(cm, client);
  detach();

  assert.equal(client.onRemote, previous);
  cm.replaceRange('X', { line: 0, ch: 0 }, { line: 0, ch: 0 }, '+input');
  assert.equal(client.document, 'abc', 'still listening after detach');
});

test('two bound editors converge through a client pair', () => {
  // The end-to-end shape, without a server: each client's outgoing operation is
  // handed to the other as a remote one. What matters is that the editors agree.
  const a = new Client({ id: 'a', send: () => {}, document: 'shared' });
  const b = new Client({ id: 'b', send: () => {}, document: 'shared' });
  const ca = fakeEditor('shared');
  const cb = fakeEditor('shared');
  collaborate(ca, a);
  collaborate(cb, b);

  const aOut = a.onLocal;
  const bOut = b.onLocal;
  a.onLocal = (op) => {
    aOut?.(op);
    b.onRemote(op);
  };
  b.onLocal = (op) => {
    bOut?.(op);
    a.onRemote(op);
  };

  ca.replaceRange('!', { line: 0, ch: 6 }, { line: 0, ch: 6 }, '+input');
  assert.equal(ca.getValue(), 'shared!');
  assert.equal(cb.getValue(), 'shared!', 'the second editor did not receive the edit');
});
