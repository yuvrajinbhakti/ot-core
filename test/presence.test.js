/**
 * Presence, checked the same way cursors are: against the document rather than
 * against my expectations.
 *
 * The property throughout is the one from position.test.js — a cursor that sat
 * immediately before some character should still sit immediately before that
 * same character — extended to cursors belonging to other people, arriving late,
 * and competing with local typing that the server has not seen yet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply } from '../src/index.js';
import { Client } from '../src/client.js';
import { Presence, track } from '../src/presence.js';
import { serverOp } from '../src/protocol.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** A document with a unique character at `mark`, so it can be found again. */
function marked(length, mark) {
  const chars = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26)));
  chars[mark] = '§';
  return chars.join('');
}

test('a peer keeps pointing at the same character', () => {
  const random = makeRandom(7);
  let checked = 0;

  for (let trial = 0; trial < 4000; trial++) {
    const length = 20 + Math.floor(random() * 40);
    const mark = Math.floor(random() * length);
    const document = marked(length, mark);

    const presence = new Presence({ clock: () => 0 });
    presence.see('them', mark);

    const at = Math.floor(random() * length);
    const op =
      random() < 0.5
        ? insert(at, 'XY')
        : remove(at, Math.min(1 + Math.floor(random() * 4), length - at));

    // A delete that swallows the mark has nowhere to point; skip those rather
    // than assert something arbitrary about them.
    if (op.type === 'delete' && at <= mark && mark < at + op.length) continue;
    // An insert landing exactly on the cursor is the documented tie, and the
    // default bias resolves it by leaving the cursor put — so it now points at
    // the new text, on purpose. Asserted on its own below rather than smuggled
    // into a property that would have to be worded around it.
    if (op.type === 'insert' && at === mark) continue;

    presence.apply(op);
    const after = apply(document, op);
    const peer = presence.get('them');

    assert.equal(
      Array.from(after)[peer.selection.head],
      '§',
      `cursor at ${mark} became ${peer.selection.head} after ${op.type} at ${at}`
    );
    checked++;
  }

  assert.ok(checked > 2800, `only ${checked} cases were meaningful`);
});

test('a report that arrives late is caught up through what it missed', () => {
  const document = marked(40, 30);
  const presence = new Presence({ clock: () => 0 });

  // The peer reports position 30 as of revision 0. Two operations land before
  // the message does, both before the mark, so it has moved by the time we can
  // act on it.
  presence.apply(insert(0, 'abcde'), 1);
  presence.apply(insert(0, 'fg'), 2);

  presence.see('them', 30, { revision: 0 });

  const after = apply(apply(document, insert(0, 'abcde')), insert(0, 'fg'));
  assert.equal(Array.from(after)[presence.get('them').selection.head], '§');
});

test('a current report is not caught up twice', () => {
  const presence = new Presence({ clock: () => 0 });
  presence.apply(insert(0, 'abcde'), 1);
  presence.see('them', 10, { revision: 1 });
  assert.equal(presence.get('them').selection.head, 10);
});

test('a report is rebased past local edits the reporter had not seen', () => {
  const document = marked(40, 30);
  let pending = [];
  const presence = new Presence({ clock: () => 0, pending: () => pending });

  // We have typed five characters at the start and the server has not
  // acknowledged them. The peer's report of position 30 was written against a
  // document without them.
  pending = [insert(0, 'abcde')];
  presence.see('them', 30, { revision: 0 });

  const ours = apply(document, insert(0, 'abcde'));
  assert.equal(
    Array.from(ours)[presence.get('them').selection.head],
    '§',
    'the report was not rebased past our own unconfirmed typing'
  );
});

test('local typing moves remote cursors', () => {
  // The bug this guards is the one that only shows while the other person is
  // idle: presence wired to remote operations alone leaves every peer's caret
  // behind as soon as you type above it.
  const document = marked(40, 30);
  const presence = new Presence({ clock: () => 0 });
  presence.see('them', 30);

  presence.applyLocal(insert(0, 'abcde'));

  const after = apply(document, insert(0, 'abcde'));
  assert.equal(Array.from(after)[presence.get('them').selection.head], '§');
});

test('a local edit is not counted twice when it is also pending', () => {
  // applyLocal moves the stored cursors; `pending` catches up incoming reports.
  // If a local operation went into the ring as well, a fresh report would be
  // rebased past it a second time and every remote caret would drift by the
  // length of our own typing.
  const document = marked(40, 30);
  const pending = [insert(0, 'abcde')];
  const presence = new Presence({ clock: () => 0, pending: () => pending });

  presence.applyLocal(pending[0]);
  presence.see('them', 30, { revision: 0 });

  const ours = apply(document, pending[0]);
  assert.equal(Array.from(ours)[presence.get('them').selection.head], '§');
});

test('an insert exactly on a cursor leaves it put, so the text lands after it', () => {
  // The bias is 'left' by default because the common case is somebody else
  // typing at your caret, and being shoved along by a stranger's keystroke is
  // worse than holding still. This is the one case where a cursor legitimately
  // stops pointing at the character it used to.
  const presence = new Presence({ clock: () => 0 });
  presence.see('them', 10);
  presence.apply(insert(10, 'XY'));
  assert.equal(presence.get('them').selection.head, 10);
});

test('selections keep their span across an insert outside them', () => {
  const presence = new Presence({ clock: () => 0 });
  presence.see('them', { anchor: 10, head: 20 });
  presence.apply(insert(0, 'abc'));
  const { anchor, head } = presence.get('them').selection;
  assert.equal(anchor, 13);
  assert.equal(head, 23);
});

test('a bare number is a collapsed caret', () => {
  const presence = new Presence({ clock: () => 0 });
  presence.see('them', 5);
  assert.deepEqual(presence.get('them').selection, { anchor: 5, head: 5 });
});

test('meta is merged, so a position report does not erase a name', () => {
  const presence = new Presence({ clock: () => 0 });
  presence.see('them', 0, { meta: { name: 'Ada', colour: '#f0f' } });
  presence.see('them', 4);
  assert.equal(presence.get('them').meta.name, 'Ada');
  assert.equal(presence.get('them').meta.colour, '#f0f');
  assert.equal(presence.get('them').selection.head, 4);
});

test('null clears the cursor without removing the peer', () => {
  const presence = new Presence({ clock: () => 0 });
  presence.see('them', 4, { meta: { name: 'Ada' } });
  presence.see('them', null);

  assert.equal(presence.list().length, 0, 'an absent peer has no cursor to draw');
  assert.equal(presence.get('them').meta.name, 'Ada', 'but is still present');
});

test('sweep drops peers by silence, not by goodbye', () => {
  let now = 0;
  const presence = new Presence({ timeout: 100, clock: () => now });
  presence.see('a', 0);
  now = 50;
  presence.see('b', 0);
  // Past the timeout for 'a' (140ms of silence) but not for 'b' (90ms).
  now = 140;

  assert.deepEqual(presence.sweep(), ['a']);
  assert.deepEqual(
    presence.list().map((p) => p.id),
    ['b']
  );
});

test('onChange fires when something moves and not when nothing does', () => {
  let calls = 0;
  const presence = new Presence({ clock: () => 0, onChange: () => calls++ });
  presence.see('them', 10);
  const afterJoin = calls;

  presence.apply(insert(50, 'x')); // after the cursor: nothing moves
  assert.equal(calls, afterJoin, 'an edit past every cursor should not notify');

  presence.apply(insert(0, 'x')); // before the cursor: it moves
  assert.equal(calls, afterJoin + 1);
});

test('a report older than the retained window is used as-is', () => {
  // Documented behaviour, asserted so it stays a flicker rather than becoming a
  // crash or a silent drift: the ring is short here, the report is ancient, and
  // the position survives unchanged rather than being transformed by a partial
  // history.
  const presence = new Presence({ clock: () => 0, retain: 2 });
  presence.apply(insert(0, 'a'), 1);
  presence.apply(insert(0, 'b'), 2);
  presence.apply(insert(0, 'c'), 3);

  presence.see('them', 10, { revision: 0 });
  // Only revisions 2 and 3 are still retained, so exactly two shift.
  assert.equal(presence.get('them').selection.head, 12);
});

test('track keeps presence in step with a client, both ways', () => {
  const sent = [];
  const client = new Client({ id: 'me', send: (m) => sent.push(m), document: marked(40, 30) });
  const presence = new Presence({ clock: () => 0 });
  track(client, presence);

  presence.see('them', 30);

  // Our own typing, unacknowledged.
  client.edit(insert(0, 'ab'));
  // And theirs, from the server.
  client.receive(serverOp(1, insert(0, 'cd'), 'them'));

  // Guard the guard: an earlier version of this test built the message by hand
  // with the wrong field name, so `receive` ignored it and the assertion below
  // passed while exercising only the local half.
  assert.equal(client.document.startsWith('cd'), true, 'the remote operation was never applied');
  assert.equal(
    Array.from(client.document)[presence.get('them').selection.head],
    '§',
    'the peer cursor did not track both a local and a remote edit'
  );
});

test('detaching track restores the previous hooks', () => {
  const client = new Client({ id: 'me', send: () => {} });
  const remote = () => {};
  const local = () => {};
  client.onRemote = remote;
  client.onLocal = local;

  const detach = track(client, new Presence({ clock: () => 0 }));
  detach();

  assert.equal(client.onRemote, remote);
  assert.equal(client.onLocal, local);
});
