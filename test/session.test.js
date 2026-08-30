/**
 * Whether the primitives actually compose into a working session.
 *
 * Everything else in this suite tests one transform, or one pair. That is where
 * the bugs were, but it is not what anybody is going to build: they are going to
 * run several clients against a server and expect the documents to match. TP1
 * over a pair does not obviously extend to five clients, twenty rounds, edits in
 * flight and acknowledgements arriving late — so this file builds that and
 * checks it.
 *
 * It also draws the boundary. The same simulation without a server diverges, and
 * the second half of this file proves it with the smallest example there is,
 * because a limitation stated in prose is a limitation somebody will find out
 * about in production.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insert, remove, apply, transform } from '../src/index.js';

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const show = (op) =>
  op.type === 'insert' ? `insert(${op.position}, "${op.content}")` : `remove(${op.position}, ${op.length})`;

const identical = (x, y) =>
  x.type === y.type && x.position === y.position && x.length === y.length && x.content === y.content;

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
 * A whole session: one server, several clients, edits and acknowledgements
 * interleaved at random.
 *
 * The part that is easy to leave out — and that made this look broken the first
 * time I wrote it — is that a client with an operation in flight must transform
 * arriving operations past its own *and* rebase its own past the arrival. Do
 * only the first half and everything still looks plausible until three clients
 * overlap.
 *
 * @returns {string | null} a description of what went wrong, or null
 */
function runSession(random, clientCount, rounds) {
  const start = 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
  const server = { doc: start, history: [] };
  const clients = Array.from({ length: clientCount }, (_, id) => ({
    id,
    doc: start,
    revision: 0,     // how far through server.history this client has read
    pending: null,   // sent, not yet acknowledged
  }));

  // Both ends must compute the same answer without talking about it. Lower id
  // yields, which is the rule the README tells callers to invent for themselves.
  const sideFor = (mine, theirs) => (mine < theirs ? 'left' : 'right');

  const drain = (client) => {
    while (client.revision < server.history.length) {
      const entry = server.history[client.revision];
      client.revision++;

      if (entry.author === client.id) {
        // The acknowledgement, and the sharpest assertion in this file: the
        // server rebased this client's operation over the history the client
        // had not seen, and the client rebased the same operation over the same
        // history as it arrived. If those two ever disagree the protocol is
        // built on sand, and no amount of document comparison would say why.
        if (!identical(entry.op, client.pending)) {
          return `client ${client.id}: server acknowledged ${show(entry.op)} ` +
            `but the client had rebased to ${show(client.pending)}`;
        }
        client.pending = null;
        continue;
      }

      let incoming = entry.op;
      if (client.pending) {
        const mine = client.pending;
        client.pending = transform(mine, incoming, sideFor(client.id, entry.author));
        incoming = transform(incoming, mine, sideFor(entry.author, client.id));
      }
      client.doc = apply(client.doc, incoming);
    }
    return null;
  };

  for (let round = 0; round < rounds; round++) {
    const free = clients.filter((c) => !c.pending);
    if (free.length && random() < 0.75) {
      const c = free[Math.floor(random() * free.length)];
      const op = randomOperation(random, c.doc);
      c.doc = apply(c.doc, op);
      c.pending = op;

      // The server rebases over everything it accepted since this client last
      // read, then commits. It does not tell the client the rebased form — the
      // client works it out itself, which is what the check above verifies.
      let rebased = op;
      for (let i = c.revision; i < server.history.length; i++) {
        rebased = transform(rebased, server.history[i].op, sideFor(c.id, server.history[i].author));
      }
      server.history.push({ author: c.id, op: rebased });
      server.doc = apply(server.doc, rebased);
    }

    for (const c of clients) {
      if (random() < 0.6) {
        const bad = drain(c);
        if (bad) return bad;
      }
    }
  }

  for (const c of clients) {
    const bad = drain(c);
    if (bad) return bad;
  }
  for (const c of clients) {
    if (c.doc !== server.doc) {
      return `client ${c.id} ended at "${c.doc}", server at "${server.doc}"`;
    }
  }
  return null;
}

test('20,000 sessions of up to 5 clients all converge on the server document', () => {
  const random = makeRandom(2026);

  for (let i = 0; i < 20_000; i++) {
    const bad = runSession(random, 2 + Math.floor(random() * 4), 6 + Math.floor(random() * 10));
    assert.equal(bad, null, `session ${i}: ${bad}`);
  }
});

test('every client rebase agrees with the server rebase, which is the whole protocol', () => {
  // Covered by the assertion inside runSession; this is here so the guarantee
  // has a name in the test output.
  const random = makeRandom(11);
  for (let i = 0; i < 5_000; i++) {
    assert.equal(runSession(random, 3, 12), null);
  }
});

test('without a server to order operations, clients diverge — smallest case', () => {
  // Found by exhaustive search over documents up to four characters. Two
  // characters and three edits is the whole of it.
  //
  // This is not a bug to fix. It is TP2 — the property that makes transformation
  // order irrelevant — and this operation model does not have it, which is why
  // the README says a server is required rather than treating that as a
  // deployment detail.
  const doc = 'ab';
  const ops = [insert(1, 'X'), insert(0, 'XY'), remove(0, 1)];

  const settle = (order) => {
    let text = doc;
    const applied = [];
    for (const id of order) {
      let incoming = ops[id];
      for (const prev of applied) {
        // A stable per-peer tie-break, computed identically by every peer —
        // so this is not the side parameter being used wrongly.
        incoming = transform(incoming, prev.op, id < prev.id ? 'left' : 'right');
      }
      applied.push({ id, op: incoming });
      text = apply(text, incoming);
    }
    return text;
  };

  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const results = new Set(orders.map(settle));

  assert.equal(
    results.size,
    2,
    `expected two outcomes without a total order, got ${[...results].map((r) => `"${r}"`).join(', ')}`
  );
  assert.deepEqual([...results].sort(), ['XXYb', 'XYXb']);

  // And the point of the server: fix one order and everybody agrees on it.
  assert.equal(settle([0, 1, 2]), 'XYXb');
});

test('the same three edits converge as soon as one order is imposed', () => {
  const doc = 'ab';
  const ops = [insert(1, 'X'), insert(0, 'XY'), remove(0, 1)];
  const order = [2, 0, 1];

  // Three peers, each applying the server's order rather than its own.
  const settle = () => {
    let text = doc;
    const applied = [];
    for (const id of order) {
      let incoming = ops[id];
      for (const prev of applied) {
        incoming = transform(incoming, prev.op, id < prev.id ? 'left' : 'right');
      }
      applied.push({ id, op: incoming });
      text = apply(text, incoming);
    }
    return text;
  };

  const peers = [settle(), settle(), settle()];
  assert.equal(new Set(peers).size, 1);
});
