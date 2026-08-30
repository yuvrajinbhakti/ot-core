/**
 * The transport, against a socket made of two arrays.
 *
 * No network, and that is the point: the Client and Server are pure state
 * machines, so a socket is a pair of queues and the only thing left to test
 * here is the glue — encoding, decoding, fan-out, and who gets told what.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert } from '../src/index.js';
import { Server } from '../src/server.js';
import { connect, Room } from '../src/websocket.js';

/** A WebSocket-shaped object wired directly to a partner. */
class FakeSocket {
  constructor(name) {
    this.name = name;
    this.listeners = new Map();
    this.partner = null;
    this.sent = [];
    this.closed = false;
  }
  static pair(name) {
    const a = new FakeSocket(`${name}:client`);
    const b = new FakeSocket(`${name}:server`);
    a.partner = b;
    b.partner = a;
    return [a, b];
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data) {
    if (this.closed) return;
    this.sent.push(data);
    this.partner.emit('message', { data });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
    this.partner.closed = true;
    this.partner.emit('close', {});
  }
}

function makeRoom(document = 'hello') {
  const server = new Server({ document });
  return { server, room: new Room(server) };
}

function addClient(room, id) {
  const [clientSide, serverSide] = FakeSocket.pair(id);
  let ready = false;
  const client = connect(clientSide, { id, onReady: () => { ready = true; } });
  room.join(id, serverSide);
  return { client, clientSide, serverSide, isReady: () => ready };
}

test('a client that joins is handed the document', () => {
  const { room } = makeRoom('hello world');
  const a = addClient(room, 'a');

  assert.equal(a.client.document, 'hello world');
  assert.equal(a.client.revision, 0);
  assert.ok(a.isReady(), 'onReady should have fired on init');
});

test('an edit reaches everybody else and comes back as an acknowledgement', () => {
  const { server, room } = makeRoom('hello');
  const a = addClient(room, 'a');
  const b = addClient(room, 'b');
  const c = addClient(room, 'c');

  a.client.edit(insert(5, ' world'));

  assert.equal(server.document, 'hello world');
  assert.equal(a.client.document, 'hello world');
  assert.equal(b.client.document, 'hello world');
  assert.equal(c.client.document, 'hello world');
  assert.equal(a.client.state, 'synchronized', 'the author should have been acknowledged');
  assert.equal(server.revision, 1);
});

test('three clients typing at the same position all converge', () => {
  const { server, room } = makeRoom('--');
  const a = addClient(room, 'a');
  const b = addClient(room, 'b');
  const c = addClient(room, 'c');

  // Synchronous fake sockets mean each edit completes its round trip before the
  // next begins, which is the easy case; the hostile one is in
  // test/client-server.test.js. What this checks is that the wiring does not
  // drop or double anything.
  a.client.edit(insert(1, 'A'));
  b.client.edit(insert(1, 'B'));
  c.client.edit(insert(1, 'C'));

  assert.equal(server.revision, 3);
  for (const member of [a, b, c]) {
    assert.equal(member.client.document, server.document, `${member.client.id} diverged`);
    assert.equal(member.client.state, 'synchronized');
  }
  assert.equal(Array.from(server.document).length, 5);
});

test('messages on the wire are JSON a person can read', () => {
  const { room } = makeRoom('hi');
  const a = addClient(room, 'a');
  a.client.edit(insert(2, '!'));

  const first = JSON.parse(a.clientSide.sent[0]);
  assert.deepEqual(first, { type: 'op', revision: 0, seq: 1, op: insert(2, '!') });

  const init = JSON.parse(a.serverSide.sent[0]);
  assert.deepEqual(init, { type: 'init', revision: 0, document: 'hi' });
  assert.deepEqual(JSON.parse(a.serverSide.sent[1]), { type: 'ack', revision: 1, seq: 1 });
});

test('a client that sends rubbish is told so and does not break the room', () => {
  const { server, room } = makeRoom('abc');
  const a = addClient(room, 'a');
  const b = addClient(room, 'b');

  const errors = [];
  b.client.onError = (e) => errors.push(e);

  a.serverSide.partner.send('not json at all');
  a.serverSide.partner.send(JSON.stringify({ type: 'op', revision: 0, seq: 1, op: { nope: true } }));

  assert.equal(server.document, 'abc', 'nothing should have been applied');

  // And the room still works.
  b.client.edit(insert(3, 'd'));
  assert.equal(server.document, 'abcd');
  assert.equal(a.client.document, 'abcd');
  assert.deepEqual(errors, []);
});

test('a client is told when the server sends something malformed', () => {
  const { room } = makeRoom('abc');
  const a = addClient(room, 'a');

  const errors = [];
  a.client.onError = (e) => errors.push(e);

  a.serverSide.send('{"type":"op","revision":"one"}');

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'malformed');
  assert.equal(a.client.document, 'abc', 'a malformed message must not be half-applied');
});

test('leaving the room stops the fan-out and forgets the client', () => {
  const { server, room } = makeRoom('abc');
  const a = addClient(room, 'a');
  const b = addClient(room, 'b');

  assert.equal(room.members.size, 2);
  b.clientSide.close();
  assert.equal(room.members.size, 1, 'a closed socket should leave the room');
  assert.ok(!server.seen.has('b'));

  const before = a.clientSide.sent.length;
  a.client.edit(insert(3, 'd'));
  assert.equal(server.document, 'abcd');
  assert.equal(a.clientSide.sent.length, before + 1, 'the room should still work with one member');
});

test('history is compacted down to the slowest member still present', () => {
  const { server, room } = makeRoom('');
  const a = addClient(room, 'a');
  const b = addClient(room, 'b');

  for (let i = 0; i < 5; i++) a.client.edit(insert(i, 'x'));
  assert.equal(server.revision, 5);

  // Both members are current, so nothing older than revision 5 is needed and
  // the history should be empty rather than five deep.
  assert.equal(server.history.length, 0, 'history should have been compacted');
  assert.equal(server.baseRevision, 5);
  assert.equal(b.client.document, 'xxxxx');
});

test('an empty room keeps no history at all', () => {
  const { server, room } = makeRoom('abc');
  const a = addClient(room, 'a');
  a.client.edit(insert(3, 'd'));
  assert.equal(server.revision, 1);

  a.clientSide.close();
  assert.equal(room.members.size, 0);
  assert.equal(server.history.length, 0);
  assert.equal(server.baseRevision, server.revision);
});

test('joining twice with the same id is refused', () => {
  const { room } = makeRoom('abc');
  addClient(room, 'a');
  assert.throws(() => addClient(room, 'a'), /already in this room/);
});

test('it works with an EventEmitter-shaped socket too', () => {
  // `ws` on the server uses .on() and hands Buffers to message handlers, which
  // is neither of the things a browser WebSocket does.
  class NodeishSocket {
    constructor() { this.handlers = new Map(); this.partner = null; }
    on(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(handler);
    }
    fire(type, arg) { for (const h of this.handlers.get(type) ?? []) h(arg); }
    send(data) { this.partner.fire('message', Buffer.from(data)); }
  }

  const clientSide = new NodeishSocket();
  const serverSide = new NodeishSocket();
  clientSide.partner = serverSide;
  serverSide.partner = clientSide;

  const server = new Server({ document: 'node' });
  const room = new Room(server);
  const client = connect(clientSide, { id: 'n' });
  room.join('n', serverSide);

  assert.equal(client.document, 'node');
  client.edit(insert(4, 'js'));
  assert.equal(server.document, 'nodejs');
  assert.equal(client.state, 'synchronized');
});
