/**
 * An actual network.
 *
 * Every other test in this suite drives a socket I wrote, and mine are
 * synchronous — which is not a small difference. Two of the six transport bugs
 * found this month only appeared *because* the fake was synchronous: the room
 * acknowledged the author before broadcasting, the author released its next
 * operation inside that acknowledgement, and the reordering happened inside one
 * call stack. A real socket would have hidden both.
 *
 * That cuts the other way too, which is the point of this file. A real socket
 * delivers on a later turn of the event loop, hands the server `Buffer` where
 * the browser hands a string, can close between a write and its delivery, and
 * fires `close` at a moment nothing in a fake ever chose. None of that is
 * exercised anywhere else.
 *
 * `ws` is a devDependency, so the published package is still zero-dependency
 * and `npm test` on a fresh clone still runs everything else. If it is missing,
 * these skip with a reason rather than failing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert } from '../src/index.js';
import { Server } from '../src/server.js';
import { attach, connect, Room } from '../src/websocket.js';

let ws = null;
try {
  ws = await import('ws');
} catch {
  // Not installed. Every test below reports why rather than failing.
}
const skip = ws ? false : 'ws is not installed — run `npm install` to include the real-socket tests';

/**
 * Poll until true, because a real network does not finish when you say so.
 *
 * `state` is not decoration. A timeout on an async convergence test tells you
 * nothing on its own — the first version of this file failed intermittently and
 * "timed out waiting for the reconnect" was the entire evidence. Printing what
 * everybody actually held turned a guessing game into a two-minute read.
 *
 * The deadline is deliberately far longer than anything here needs; a passing
 * run settles in tens of milliseconds. It is set for the machine, not the code.
 * One failure was seen in roughly eighty-five runs, on a laptop that also had a
 * browser driving the demo at the time, and it did not reproduce in thirty-six
 * further runs at twelve-way parallelism. A deadline is the only thing in this
 * file that a busy machine can trip on its own — a real convergence failure
 * shows up as two different documents, not as waiting — so the deadline is
 * where the headroom goes. That is a judgement, not a diagnosis: the failure
 * was never caught in the act.
 */
function settled(predicate, { timeout = 30_000, label = 'condition', state } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch (cause) { return reject(cause); }
      if (ok) return resolve();
      if (Date.now() - start > timeout) {
        const detail = state ? `\n  state: ${JSON.stringify(state(), null, 2)}` : '';
        return reject(new Error(`timed out waiting for ${label}${detail}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** What every participant is holding, for a timeout message. */
const snapshot = (room, members) => () => ({
  server: { document: room.server.document, revision: room.server.revision, base: room.server.baseRevision },
  members: room.room ? [...room.room.members.keys()] : [],
  seen: room.server.seen ? Object.fromEntries(room.server.seen) : {},
  clients: members.map((m) => ({
    id: m.client.id,
    document: m.client.document,
    revision: m.client.revision,
    state: m.client.state,
    unconfirmed: m.client.unconfirmed.length,
    errors: m.errors,
  })),
});

/**
 * A room behind a real WebSocket server on an ephemeral port.
 *
 * The revision travels in the query string, which is how a returning client
 * tells the server it wants what it missed rather than a fresh document. That
 * is a real join flow, not a test affordance.
 */
async function startRoom(document = 'the quick brown fox') {
  const server = new Server({ document });
  const room = new Room(server);
  const wss = new ws.WebSocketServer({ port: 0 });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const id = url.searchParams.get('id');
    const revision = url.searchParams.get('revision');
    room.join(id, socket, revision === null ? undefined : { revision: Number(revision) });
  });

  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  return {
    server,
    room,
    wss,
    port,
    url: (id, revision) =>
      `ws://127.0.0.1:${port}/?id=${encodeURIComponent(id)}` +
      (revision === undefined ? '' : `&revision=${revision}`),
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

/** A client on a real socket, resolved once the document has arrived. */
function joinRoom(room, id) {
  return new Promise((resolve, reject) => {
    const socket = new ws.WebSocket(room.url(id));
    const errors = [];
    // Cleared on both paths. Left running, these accumulate across the tests in
    // this file and keep firing into promises that settled long ago.
    const giveUp = setTimeout(() => reject(new Error(`${id} never received init`)), 30_000);
    const client = connect(socket, {
      id,
      onError: (e) => errors.push(e),
      onReady: () => { clearTimeout(giveUp); resolve({ client, socket, errors }); },
    });
    socket.on('error', (cause) => { clearTimeout(giveUp); reject(cause); });
  });
}

test('three clients on real sockets converge', { skip }, async (t) => {
  const room = await startRoom('hello');
  t.after(() => room.close());

  const members = await Promise.all(['Ana', 'Bo', 'Cy'].map((id) => joinRoom(room, id)));
  for (const m of members) assert.equal(m.client.document, 'hello');

  // Concurrent: all three edit before any acknowledgement can come back, which
  // is the case the whole library exists for.
  members[0].client.edit(insert(5, ' world'));
  members[1].client.edit(insert(0, 'oh, '));
  members[2].client.edit(insert(0, '['));

  await settled(
    () => room.server.revision === 3 && members.every((m) => m.client.document === room.server.document),
    { label: 'three concurrent edits to settle' }
  );

  for (const m of members) {
    assert.equal(m.client.document, room.server.document, `${m.client.id} diverged`);
    assert.equal(m.client.state, 'synchronized');
    assert.deepEqual(m.errors, []);
  }
  assert.equal(Array.from(room.server.document).length, 16);
});

test('a burst of typing crosses a real socket as few messages, and converges', { skip }, async (t) => {
  const room = await startRoom('the ');
  t.after(() => room.close());

  const [a, b] = await Promise.all([joinRoom(room, 'Ana'), joinRoom(room, 'Bo')]);

  // Five keystrokes with no await between them: the first goes, the rest are
  // buffered and composed behind it.
  for (const [i, ch] of Array.from('hello').entries()) a.client.edit(insert(4 + i, ch));
  assert.equal(a.client.document, 'the hello');

  await settled(
    () => a.client.state === 'synchronized' && b.client.document === room.server.document,
    { label: 'the burst to settle' }
  );

  assert.equal(room.server.document, 'the hello');
  // Five keystrokes, at most two revisions — one in flight plus one composed
  // buffer. Over a real socket the round trip is long enough that this holds.
  assert.ok(room.server.revision <= 2, `expected at most 2 revisions, got ${room.server.revision}`);
  assert.deepEqual(a.errors, []);
});

test('a socket dies mid-session; the client comes back with its offline work', { skip }, async (t) => {
  const room = await startRoom('abc');
  t.after(() => room.close());

  const [a, b] = await Promise.all([joinRoom(room, 'Ana'), joinRoom(room, 'Bo')]);

  a.client.edit(insert(3, 'X'));
  await settled(() => a.client.state === 'synchronized', { label: 'the first edit' });

  // Kill it the way a network does — no close handshake.
  a.client.disconnect();
  a.socket.terminate();
  await settled(() => room.room.members.size === 1, { label: 'the server to notice the socket died' });

  // The world moves on without it, and it keeps typing.
  b.client.edit(insert(0, 'z'));
  await settled(() => room.server.document === 'zabcX', { label: "Bo's edit" });

  a.client.edit(insert(4, 'OFFLINE'));
  a.client.edit(insert(11, '!'));
  assert.equal(a.client.document, 'abcXOFFLINE!');

  // Back on a new socket, telling the server where it left off.
  //
  // Attached before `open`, deliberately. The room writes the missed operations
  // the instant the connection lands, and attaching after `open` races that —
  // the message arrives with no listener and vanishes. That race is what
  // produced a one-character-early insert here, intermittently, until the
  // client learned to refuse an acknowledgement that skips a revision.
  const revived = new ws.WebSocket(room.url('Ana', a.client.revision));
  attach(a.client, revived);
  await new Promise((resolve, reject) => {
    revived.on('open', resolve);
    revived.on('error', reject);
  });
  a.client.reconnect();

  await settled(
    () =>
      a.client.state === 'synchronized' &&
      a.client.document === room.server.document &&
      b.client.document === room.server.document,
    { label: 'the reconnect to settle', state: snapshot(room, [a, b]) }
  );

  assert.match(room.server.document, /OFFLINE/, 'work typed offline must survive');
  assert.match(room.server.document, /^zabcX/, "and so must everyone else's");
  assert.equal(room.server.document, 'zabcXOFFLINE!');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test('nonsense from a real socket is rejected without disturbing the room', { skip }, async (t) => {
  const room = await startRoom('abc');
  t.after(() => room.close());

  const [a, b] = await Promise.all([joinRoom(room, 'Ana'), joinRoom(room, 'Bo')]);

  // Straight down the wire, bypassing the Client entirely — which is what a
  // hostile or broken peer does.
  a.socket.send('this is not json');
  a.socket.send(JSON.stringify({ type: 'op', revision: 0, seq: 99, op: { type: 'nope' } }));
  a.socket.send(JSON.stringify({ type: 'op', revision: 0, seq: 99, op: { ...insert(0, 'x'), position: -4 } }));

  await settled(() => a.errors.length >= 3, { label: 'the server to complain about all three' });
  assert.ok(a.errors.every((e) => e.code === 'malformed'), JSON.stringify(a.errors));

  // The room still works.
  b.client.edit(insert(3, 'd'));
  // Waiting on "the two agree" would pass instantly — they already do, at the
  // old value. Wait for the new one.
  await settled(
    () => room.server.document === 'abcd' && a.client.document === 'abcd',
    { label: "Bo's edit to reach everyone" }
  );
  assert.equal(b.client.document, 'abcd');
});

test('a resend across a dropped socket is not applied twice', { skip }, async (t) => {
  const room = await startRoom('abc');
  t.after(() => room.close());

  const a = await joinRoom(room, 'Ana');

  // Send, then kill the socket before the acknowledgement can get home. From
  // the client's side "it never arrived" and "the ack never arrived" are the
  // same observation, so it has to resend — and the server has to tell them
  // apart from the sequence number.
  a.client.edit(insert(3, 'XYZ'));
  a.socket.terminate();
  a.client.disconnect();

  await settled(() => room.server.document === 'abcXYZ', { label: 'the edit to land anyway' });
  assert.equal(room.server.revision, 1);

  const revived = new ws.WebSocket(room.url('Ana', a.client.revision));
  attach(a.client, revived);
  await new Promise((resolve, reject) => {
    revived.on('open', resolve);
    revived.on('error', reject);
  });
  a.client.reconnect();

  await settled(() => a.client.state === 'synchronized', {
    label: 'the resend to be acknowledged',
    state: snapshot(room, [a]),
  });

  assert.equal(room.server.document, 'abcXYZ', 'the text must not be inserted twice');
  assert.equal(room.server.revision, 1, 'and no second revision may exist');
  assert.equal(a.client.document, 'abcXYZ');
});

test('five clients editing at once over real sockets all agree', { skip }, async (t) => {
  const room = await startRoom('0123456789');
  t.after(() => room.close());

  const ids = ['a', 'b', 'c', 'd', 'e'];
  const members = await Promise.all(ids.map((id) => joinRoom(room, id)));

  // Several rounds, everybody editing without waiting for anybody.
  for (let round = 0; round < 6; round++) {
    for (const [i, m] of members.entries()) {
      const size = Array.from(m.client.document).length;
      m.client.edit(insert(Math.min(i * 2, size), String.fromCharCode(65 + i)));
    }
    await new Promise((r) => setTimeout(r, 15));
  }

  await settled(
    () =>
      members.every((m) => m.client.state === 'synchronized') &&
      members.every((m) => m.client.document === room.server.document),
    { label: '30 concurrent edits to settle' }
  );

  const documents = new Set(members.map((m) => m.client.document));
  assert.equal(documents.size, 1, `clients disagreed: ${[...documents].join(' | ')}`);
  assert.equal([...documents][0], room.server.document);
  assert.equal(room.server.revision, 30);
  for (const m of members) assert.deepEqual(m.errors, []);
});
