/**
 * Undo, and the property it is easy to assert wrongly.
 *
 * The claim under test is *not* "undo restores the document to what it was
 * before the edit". That is the single-player property, it is false the moment
 * somebody else types, and asserting it is a mistake I have already made once in
 * this repository — I wrote that test, watched correct code fail it, and nearly
 * changed the code.
 *
 * The claim is: **undo removes what survives of my contribution, and leaves
 * everything else alone.** Concretely, undoing my edit must produce the document
 * that everyone else's edits alone would have produced. That is checkable
 * without hand-written expectations: run the same remote operations against the
 * original document with my edit missing, and compare.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply } from '../src/index.js';
import { Client } from '../src/client.js';
import { UndoStack, attachHistory } from '../src/undo.js';
import { serverOp } from '../src/protocol.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * My contribution, marked so it can be identified without arithmetic.
 *
 * The first version of this test computed the expected document by transforming
 * the other operations "past my absence", which quietly treats a sequential edit
 * as a concurrent one — they were written against a document that already
 * contained mine. The reference was wrong, not the code. Marking the characters
 * removes the need for a reference at all: strip the marker and the two
 * documents must agree, because undo is only allowed to touch my own text.
 */
const MARK = '\u25ca';
const strip = (text) => text.split(MARK).join('');

test('undoing an insert removes exactly my characters', () => {
  const random = makeRandom(23);
  let checked = 0;

  for (let trial = 0; trial < 3000; trial++) {
    const base = 'the quick brown fox jumps over the lazy dog';
    const at = Math.floor(random() * base.length);
    const mine = insert(at, MARK.repeat(3));

    const stack = new UndoStack();
    stack.record(mine, base);
    let document = apply(base, mine);

    // Somebody else types, possibly straight through the middle of my marker
    // run — which is the interesting case, because undo must remove my three
    // characters and leave theirs sitting where they landed.
    let typed = 0;
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const where = Math.floor(random() * (document.length + 1));
      const op =
        random() < 0.5
          ? insert(where, 'X')
          : remove(Math.min(where, Math.max(0, document.length - 1)), 1);
      if (op.type === 'delete' && document.length === 0) continue;
      // An insert landing strictly inside my run is the swallow case: my undo
      // is a delete, their text is inside it, and the library's transform
      // absorbs it. Asserted on its own below rather than folded into a
      // property it genuinely violates.
      const run = document.indexOf(MARK);
      const inside =
        op.type === 'insert' && run !== -1 && op.position > run && op.position < run + 3;
      if (inside) continue;
      document = apply(document, op);
      stack.rebase(op);
      typed++;
    }
    if (typed === 0) continue;

    const undone = apply(document, stack.undo(document));

    assert.ok(!undone.includes(MARK), `undo left ${JSON.stringify(undone)} carrying my text`);
    assert.equal(undone, strip(document), 'undo changed characters that were not mine');
    checked++;
  }

  assert.ok(checked > 2000, `only ${checked} cases were meaningful`);
});

test('undoing an insert also removes text typed inside it — documented, not accidental', () => {
  // The library's trade-off surfacing where a user can feel it. `transform`
  // drops an insert that lands inside a concurrently deleted range and lets the
  // delete swallow it; an undo *is* a delete, so a collaborator who typed in the
  // middle of my word loses that character when I undo.
  //
  // Asserted so that fixing it is a deliberate act with a failing test attached,
  // rather than something that drifts.
  const stack = new UndoStack();
  const base = 'ab';
  const mine = insert(2, MARK.repeat(3));
  stack.record(mine, base);

  let document = apply(base, mine);
  const theirs = insert(3, 'X'); // strictly inside my run
  document = apply(document, theirs);
  stack.rebase(theirs);

  const undone = apply(document, stack.undo(document));
  assert.equal(undone, 'ab', 'the swallow behaviour changed');
  assert.notEqual(undone, 'abX', 'if this passes, undo now splits around foreign text');
});

test('undoing a delete restores exactly my characters', () => {
  const random = makeRandom(31);
  let checked = 0;

  for (let trial = 0; trial < 3000; trial++) {
    const head = 'the quick brown ';
    const tail = ' jumps over the lazy dog';
    const base = head + MARK.repeat(3) + tail;
    const mine = remove(head.length, 3);

    const stack = new UndoStack();
    stack.record(mine, base);
    let document = apply(base, mine);
    assert.ok(!document.includes(MARK));

    let typed = 0;
    const count = 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const where = Math.floor(random() * (document.length + 1));
      const op =
        random() < 0.5
          ? insert(where, 'X')
          : remove(Math.min(where, Math.max(0, document.length - 1)), 1);
      if (op.type === 'delete' && document.length === 0) continue;
      document = apply(document, op);
      stack.rebase(op);
      typed++;
    }
    if (typed === 0) continue;

    const undone = apply(document, stack.undo(document));

    // Nobody else could have touched the marker — it was not in the document
    // while they were typing — so all three come back, and nothing else moves.
    assert.equal((undone.match(/\u25ca/g) ?? []).length, 3, 'my deleted text was not restored');
    assert.equal(strip(undone), document, 'undo changed characters that were not mine');
    checked++;
  }

  assert.ok(checked > 2000, `only ${checked} cases were meaningful`);
});

test('undo with nobody else typing is the ordinary thing', () => {
  const stack = new UndoStack();
  const base = 'hello';
  const op = insert(5, ' world');
  stack.record(op, base);
  const after = apply(base, op);
  assert.equal(apply(after, stack.undo(after)), base);
});

test('undoing a delete puts the text back', () => {
  // The case that cannot work without the pre-image: the operation itself does
  // not carry what it removed.
  const stack = new UndoStack();
  const base = 'hello world';
  const op = remove(5, 6);
  stack.record(op, base);
  const after = apply(base, op);
  assert.equal(after, 'hello');
  assert.equal(apply(after, stack.undo(after)), base);
});

test('redo puts it back again', () => {
  const stack = new UndoStack();
  const base = 'hello';
  const op = insert(5, '!');
  stack.record(op, base);

  let document = apply(base, op);
  document = apply(document, stack.undo(document));
  assert.equal(document, base);

  assert.ok(stack.canRedo);
  document = apply(document, stack.redo(document));
  assert.equal(document, 'hello!');
});

test('a fresh edit discards the redo stack', () => {
  const stack = new UndoStack();
  stack.record(insert(0, 'a'), '');
  const document = apply('', insert(0, 'a'));
  stack.undo(document);
  assert.ok(stack.canRedo);

  stack.record(insert(0, 'b'), '');
  assert.equal(stack.canRedo, false, 'redo survived a branch');
});

test('an edit deleted by somebody else is skipped, not returned as a no-op', () => {
  // A button that visibly does nothing reads as broken. The entry is dropped
  // and the next real one is undone instead.
  const stack = new UndoStack();
  const base = 'hello';
  const first = insert(0, 'A');
  stack.record(first, base);
  let document = apply(base, first);

  const second = insert(6, 'B');
  stack.record(second, document);
  document = apply(document, second);

  // Somebody deletes the 'B' entirely.
  const theirs = remove(6, 1);
  document = apply(document, theirs);
  stack.rebase(theirs);

  const op = stack.undo(document);
  assert.ok(op !== null, 'undo gave up instead of skipping the flattened entry');
  assert.notEqual(op.length, 0, 'undo returned an operation that does nothing');
  assert.equal(apply(document, op), 'hello', 'it should have undone the surviving edit');
});

test('undo returns null when there is nothing left', () => {
  const stack = new UndoStack();
  assert.equal(stack.undo('anything'), null);
  assert.equal(stack.canUndo, false);
});

test('the stack is bounded', () => {
  const stack = new UndoStack({ limit: 3 });
  for (let i = 0; i < 10; i++) stack.record(insert(0, 'x'), '');
  assert.equal(stack.undoable.length, 3);
});

test('rebasing many entries uses the right coordinates for each', () => {
  // The plausible-looking version of `rebaseAll` transforms every entry against
  // the original remote operation. That is right for the entry nearest the top
  // and wrong for all the others, because each sits in the coordinates the one
  // before it left. Three entries is the smallest case that catches it.
  const base = 'abcdef';
  const stack = new UndoStack();

  let document = base;
  for (const op of [insert(0, '1'), insert(0, '2'), insert(0, '3')]) {
    stack.record(op, document);
    document = apply(document, op);
  }

  const theirs = insert(document.length, 'Z');
  document = apply(document, theirs);
  stack.rebase(theirs);

  // Undoing all three should strip exactly my three characters and keep theirs.
  for (let i = 0; i < 3; i++) document = apply(document, stack.undo(document));
  assert.equal(document, 'abcdefZ');
});

test('attachHistory records through a client, including deletes', () => {
  const client = new Client({ id: 'me', send: () => {}, document: 'hello world' });
  const history = attachHistory(client);

  client.edit(remove(5, 6));
  assert.equal(client.document, 'hello');
  assert.ok(history.canUndo);

  history.undo();
  assert.equal(client.document, 'hello world', 'the delete was not restored with its text');
});

test('an undo through attachHistory is not itself recorded as an edit', () => {
  // Otherwise the inverse of the inverse goes on the stack and the button
  // becomes a toggle between two states forever.
  const client = new Client({ id: 'me', send: () => {}, document: '' });
  const history = attachHistory(client);

  client.edit(insert(0, 'abc'));
  history.undo();
  assert.equal(client.document, '');

  assert.equal(history.canUndo, false, 'the undo was recorded as a new edit');
  assert.ok(history.canRedo);
});

test('attachHistory rebases against remote operations', () => {
  const client = new Client({ id: 'me', send: () => {}, document: 'base' });
  const history = attachHistory(client);

  client.edit(insert(4, 'MINE'));
  client.receive(serverOp(1, insert(0, 'THEIRS '), 'them'));
  assert.equal(client.document, 'THEIRS baseMINE', 'the remote operation was never applied');

  history.undo();
  assert.equal(client.document, 'THEIRS base', 'undo did not survive a concurrent edit');
});

test('detaching attachHistory restores the previous hooks', () => {
  const client = new Client({ id: 'me', send: () => {} });
  const remote = () => {};
  const local = () => {};
  client.onRemote = remote;
  client.onLocal = local;

  attachHistory(client).detach();

  assert.equal(client.onRemote, remote);
  assert.equal(client.onLocal, local);
});
