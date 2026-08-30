/**
 * The real Client and Server, against each other, under a hostile network.
 *
 * test/session.test.js proved the *primitives* compose into a session by
 * simulating the protocol by hand. This file runs the shipped classes instead,
 * so a bug in the state machine — as opposed to the algebra — has somewhere to
 * be caught. The two failures I made writing that simulation both live here now
 * as hazards the harness deliberately produces: acknowledgements arriving after
 * a reconnect, and the same operation delivered twice.
 *
 * Nothing here touches a socket. The server takes a decoded message and returns
 * what to send, so a "network" is an array with a delay on it, and 20,000
 * sessions run in under a second.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply } from '../src/index.js';
import { Client, SYNCHRONIZED } from '../src/client.js';
import { Server } from '../src/server.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const show = (op) =>
  op.type === 'insert' ? `insert(${op.position}, "${op.content}")` : `remove(${op.position}, ${op.length})`;

function randomOperation(random, doc) {
  const size = Array.from(doc).length;
  if (size === 0 || random() < 0.5) {
    const position = Math.floor(random() * (size + 1));
    return insert(position, 'XYZW'.slice(0, 1 + Math.floor(random() * 4)));
  }
  const position = Math.floor(random() * size);
  return remove(position, 1 + Math.floor(random() * Math.max(1, Math.min(4, size - position))));
}

/**
 * A room: one server, N clients, and a wire between them that can be as unkind
 * as the options ask for.
 */
class Room {
  constructor(random, { clients = 3, document = 'abcdef', duplicate = 0, drop = 0 } = {}) {
    this.random = random;
    this.duplicate = duplicate;
    this.drop = drop;
    this.server = new Server({ document });
    /** Messages waiting to be delivered: { to, message } — `to` null means server. */
    this.wire = [];
    this.log = [];

    this.clients = Array.from({ length: clients }, (_, i) => {
      const id = `c${i}`;
      const client = new Client({
        id,
        document,
        revision: 0,
        send: (message) => {
          this.wire.push({ from: id, to: null, message });
          // Duplicate delivery: the same message arriving twice. A socket does
          // not usually do this; a client resending after a timeout does, and
          // the server must not apply the edit a second time.
          if (this.random() < this.duplicate) this.wire.push({ from: id, to: null, message });
        },
      });
      return client;
    });
  }

  clientById(id) {
    return this.clients.find((c) => c.id === id);
  }

  /** Deliver one queued message, chosen at random. */
  step() {
    if (this.wire.length === 0) return false;
    const index = Math.floor(this.random() * this.wire.length);
    const [entry] = this.wire.splice(index, 1);

    if (entry.to === null) {
      const client = this.clientById(entry.from);
      if (!client.connected) return true;   // it never made it out
      const { ack, broadcast } = this.server.receive(entry.from, entry.message);
      this.log.push({ from: entry.from, ack, broadcast });
      assert.notEqual(ack.type, 'error', `server rejected a well-formed edit: ${ack.reason}`);
      this.wire.push({ from: null, to: entry.from, message: ack });
      if (broadcast) {
        for (const c of this.clients) {
          if (c.id !== entry.from && c.connected) this.wire.push({ from: null, to: c.id, message: broadcast });
        }
      }
    } else {
      const client = this.clientById(entry.to);
      if (!client.connected) {
        // Dropped on the floor. The client will catch up through since() when
        // it reconnects, which is the whole point of tracking revisions.
        return true;
      }
      client.receive(entry.message);
    }
    return true;
  }

  /**
   * A message from the server to a *connected* client cannot be reordered — one
   * socket, in order — so deliveries to a given client are drained in order.
   * This is enforced rather than assumed: the wire above picks at random, so
   * without this the harness would be testing a network nobody has.
   */
  deliverInOrderTo(clientId) {
    for (let i = 0; i < this.wire.length; i++) {
      if (this.wire[i].to === clientId) {
        const [entry] = this.wire.splice(i, 1);
        const client = this.clientById(clientId);
        if (client.connected) client.receive(entry.message);
        return true;
      }
    }
    return false;
  }

  /**
   * Close a client's socket. Anything queued on it in either direction is gone —
   * which is the point. Leaving those messages on the wire models a reconnect
   * that resurrects the old socket's buffer, which no transport does, and it
   * delivers operations the client is about to receive again through since().
   */
  disconnect(client) {
    client.disconnect();
    this.wire = this.wire.filter((e) => e.to !== client.id && e.from !== client.id);
  }

  reconnect(client) {
    client.reconnect(this.server.since(client.revision));
  }

  settle({ reconnect = true } = {}) {
    if (reconnect) {
      for (const c of this.clients) {
        if (!c.connected) this.reconnect(c);
      }
    }
    let guard = 0;
    while (this.wire.length > 0) {
      // In-order per destination, which is what a socket guarantees.
      const next = this.wire[0];
      if (next.to === null) {
        const [entry] = this.wire.splice(0, 1);
        const { ack, broadcast } = this.server.receive(entry.from, entry.message);
        // Nothing a well-formed client sends may be rejected. The client has a
        // recovery path for rejection, and that path would quietly absorb a real
        // protocol bug — so the harness refuses to let it run.
        assert.notEqual(ack.type, 'error', `server rejected a well-formed edit: ${ack.reason}`);
        this.wire.push({ from: null, to: entry.from, message: ack });
        if (broadcast) {
          for (const c of this.clients) {
            if (c.id !== entry.from && c.connected) this.wire.push({ from: null, to: c.id, message: broadcast });
          }
        }
      } else {
        const [entry] = this.wire.splice(0, 1);
        const client = this.clientById(entry.to);
        if (client.connected) client.receive(entry.message);
      }
      if (++guard > 100_000) throw new Error('the wire never drained');
    }
  }

  check() {
    for (const c of this.clients) {
      assert.equal(c.state, SYNCHRONIZED, `client ${c.id} still has unsent work: ${c.unconfirmed.map(show)}`);
      assert.equal(
        c.document,
        this.server.document,
        `client ${c.id} ended at "${c.document}", server at "${this.server.document}"`
      );
      assert.equal(c.revision, this.server.revision, `client ${c.id} is at revision ${c.revision}`);
    }
  }
}

test('20,000 sessions of up to 5 clients converge, in-order delivery', () => {
  const random = makeRandom(4321);

  for (let s = 0; s < 20_000; s++) {
    const room = new Room(random, {
      clients: 2 + Math.floor(random() * 4),
      document: 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6)),
    });

    const rounds = 5 + Math.floor(random() * 12);
    for (let r = 0; r < rounds; r++) {
      const client = room.clients[Math.floor(random() * room.clients.length)];
      client.edit(randomOperation(random, client.document));
      // Deliver some of what is queued, in order per destination.
      for (const c of room.clients) {
        while (random() < 0.5 && room.deliverInOrderTo(c.id));
      }
      while (room.wire.some((e) => e.to === null) && random() < 0.7) {
        const i = room.wire.findIndex((e) => e.to === null);
        const [entry] = room.wire.splice(i, 1);
        const { ack, broadcast } = room.server.receive(entry.from, entry.message);
        assert.notEqual(ack.type, 'error', `server rejected a well-formed edit: ${ack.reason}`);
        room.wire.push({ from: null, to: entry.from, message: ack });
        if (broadcast) {
          for (const c of room.clients) {
            if (c.id !== entry.from && c.connected) room.wire.push({ from: null, to: c.id, message: broadcast });
          }
        }
      }
    }

    room.settle();
    room.check();
  }
});

test('duplicate messages are recognised, not applied twice', () => {
  const random = makeRandom(99);

  for (let s = 0; s < 5_000; s++) {
    const room = new Room(random, { clients: 3, duplicate: 0.5 });
    for (let r = 0; r < 8; r++) {
      const client = room.clients[Math.floor(random() * room.clients.length)];
      client.edit(randomOperation(random, client.document));
      for (const c of room.clients) {
        while (random() < 0.5 && room.deliverInOrderTo(c.id));
      }
    }
    room.settle();
    room.check();
  }
});

test('a client can go offline, keep editing, and come back', () => {
  const room = new Room(makeRandom(7), { clients: 3, document: 'hello world' });
  const [a, b, c] = room.clients;

  room.disconnect(a);
  a.edit(insert(5, ' there'));      // in flight, never sent
  a.edit(insert(11, ' friend'));    // buffered behind it
  assert.equal(a.document, 'hello there friend world');
  assert.equal(a.state, 'awaiting-with-buffer');

  // The others carry on without it.
  b.edit(insert(0, 'oh, '));
  room.settle({ reconnect: false });
  assert.equal(b.document, c.document);
  assert.notEqual(a.document, b.document, 'the offline client should be behind');

  // Back on the network: catch up, then push.
  room.reconnect(a);
  room.settle();

  room.check();
  assert.match(room.server.document, /there/);
  assert.match(room.server.document, /friend/);
  assert.match(room.server.document, /^oh, /);
});

test('offline editing survives a random network, 5,000 times', () => {
  const random = makeRandom(31337);

  for (let s = 0; s < 5_000; s++) {
    const room = new Room(random, { clients: 3, document: 'abcdef' });

    for (let r = 0; r < 10; r++) {
      const client = room.clients[Math.floor(random() * room.clients.length)];
      if (random() < 0.15) {
        if (client.connected) room.disconnect(client);
        else room.reconnect(client);
      }
      client.edit(randomOperation(random, client.document));
      for (const c of room.clients) {
        while (random() < 0.5 && room.deliverInOrderTo(c.id));
      }
      while (room.wire.some((e) => e.to === null) && random() < 0.7) {
        const i = room.wire.findIndex((e) => e.to === null);
        const [entry] = room.wire.splice(i, 1);
        const sender = room.clientById(entry.from);
        if (!sender.connected) continue;
        const { ack, broadcast } = room.server.receive(entry.from, entry.message);
        assert.notEqual(ack.type, 'error', `server rejected a well-formed edit: ${ack.reason}`);
        room.wire.push({ from: null, to: entry.from, message: ack });
        if (broadcast) {
          for (const cl of room.clients) {
            if (cl.id !== entry.from && cl.connected) room.wire.push({ from: null, to: cl.id, message: broadcast });
          }
        }
      }
    }

    room.settle();
    room.check();
  }
});

test('a burst of typing leaves as one operation, not one per keystroke', () => {
  const sent = [];
  const server = new Server({ document: 'the ' });
  const client = new Client({ id: 'a', document: 'the ', send: (m) => sent.push(m) });

  // First keystroke goes immediately; the rest arrive while it is in flight.
  for (const [i, ch] of Array.from('hello').entries()) client.edit(insert(4 + i, ch));

  assert.equal(sent.length, 1, 'only one message should be on the wire');
  assert.equal(client.state, 'awaiting-with-buffer');
  assert.equal(client.buffer.length, 1, `four keystrokes should compose into one buffered op`);
  assert.deepEqual(client.buffer[0], insert(5, 'ello'));

  // Acknowledge, and the whole rest of the burst goes as a single message.
  client.receive(server.receive('a', sent[0]).ack);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].op, insert(5, 'ello'));
  assert.equal(client.document, 'the hello');
});

test('the caret moves when somebody else edits above it', () => {
  const client = new Client({ id: 'a', document: 'hello world', send: () => {} });
  client.selection = { anchor: 6, head: 11 };   // "world"

  client.receive({ type: 'op', revision: 1, author: 'b', op: insert(0, 'oh, ') });

  assert.equal(client.document, 'oh, hello world');
  assert.deepEqual(client.selection, { anchor: 10, head: 15 }, 'the selection should still be on "world"');
  assert.equal(
    client.document.slice(client.selection.anchor, client.selection.head),
    'world'
  );
});

test('the server rejects what it should and says why', () => {
  const server = new Server({ document: 'abc' });

  const malformed = server.receive('a', { type: 'op', revision: 0, seq: 1, op: { type: 'nope' } });
  assert.equal(malformed.ack.type, 'error');
  assert.equal(malformed.ack.code, 'malformed');

  const future = server.receive('a', { type: 'op', revision: 9, seq: 1, op: insert(0, 'x') });
  assert.equal(future.ack.code, 'future-revision');

  const tooBig = server.receive('a', { type: 'op', revision: 0, seq: 1, op: remove(0, 99) });
  assert.equal(tooBig.ack.code, 'out-of-range');

  assert.equal(server.document, 'abc', 'nothing rejected should have been applied');
  assert.equal(server.revision, 0);
});

test('compacting history refuses clients that can no longer be caught up', () => {
  const server = new Server({ document: 'abc' });
  server.receive('a', { type: 'op', revision: 0, seq: 1, op: insert(3, 'd') });
  server.receive('a', { type: 'op', revision: 1, seq: 2, op: insert(4, 'e') });
  assert.equal(server.document, 'abcde');
  assert.equal(server.revision, 2);

  assert.deepEqual(server.since(1).map((e) => e.revision), [2]);

  assert.equal(server.compact(2), 2);
  assert.equal(server.history.length, 0);
  assert.throws(() => server.since(1), /compacted/);

  const late = server.receive('b', { type: 'op', revision: 1, seq: 1, op: insert(0, 'z') });
  assert.equal(late.ack.code, 'behind-history');
  assert.match(late.ack.reason, /rejoin/);
});

test('a resend after a dropped socket is acknowledged, not applied twice', () => {
  const server = new Server({ document: 'abc' });
  const message = { type: 'op', revision: 0, seq: 1, op: insert(3, 'XYZ') };

  const first = server.receive('a', message);
  assert.equal(first.applied, true);
  assert.equal(server.document, 'abcXYZ');

  // The acknowledgement never got home, so the client sends it again.
  const second = server.receive('a', message);
  assert.equal(second.applied, false);
  assert.equal(second.ack.type, 'ack');
  assert.equal(second.ack.revision, first.ack.revision);
  assert.equal(second.broadcast, null, 'nothing to tell anybody, nothing changed');
  assert.equal(server.document, 'abcXYZ', 'the text must not be inserted twice');
});
