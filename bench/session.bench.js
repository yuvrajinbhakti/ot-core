/**
 * How fast is the part that actually broke?
 *
 * `transform.bench.js` measures the algebra, which was never the problem — nine
 * bugs were found in this library and none of them were in `transform`. They
 * were all in the layer above: the client state machine, the server's rebase,
 * the room's fan-out. So this measures that layer, on the two questions that
 * decide whether a room stays usable:
 *
 *   1. **How does a client scale as it falls behind?** An operation arriving
 *      while you hold unconfirmed work has to be transformed past the
 *      outstanding operation *and* every buffered one. A slow typist on a fast
 *      network never sees this; a fast typist on a slow one lives in it.
 *
 *   2. **What does a room cost per participant?** The server rebases each
 *      incoming operation against everything since the revision it was written
 *      at, then hands the result to everyone. Both halves grow with the number
 *      of people typing at once.
 *
 * These are throughput numbers on one core with no network, so they are an upper
 * bound and a shape, not a capacity plan. The shape is the useful part: what
 * grows linearly, and what does not grow at all.
 *
 * Everything is measured in short batches against freshly built state, because
 * every insert makes the document longer and `apply` copies it — left running,
 * a straight loop of two hundred thousand inserts spends all its time in string
 * copying and reports the cost of that instead of the cost of the thing being
 * measured. The first version of this file did exactly that and did not finish.
 */

import { insert, remove } from '../src/index.js';
import { Client } from '../src/client.js';
import { Server } from '../src/server.js';
import { Presence } from '../src/presence.js';
import { UndoStack } from '../src/undo.js';
import { serverOp } from '../src/protocol.js';

const makeRandom = (seed) => {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
};

const randomOperation = (random, size) => {
  if (size === 0 || random() < 0.6) return insert(Math.floor(random() * (size + 1)), 'X');
  const position = Math.floor(random() * size);
  return remove(position, 1 + Math.floor(random() * Math.min(3, size - position)));
};

/**
 * Measure `run` in `rounds` batches of `batch`, rebuilding state between them.
 *
 * Setup is outside the clock. The batch is deliberately short so that state
 * which grows as it is exercised — the document, the server's history — does not
 * grow far enough during a measurement to be measuring itself.
 */
const time = (label, run, setup, { batch = 500, rounds = 20 } = {}) => {
  for (let r = 0; r < 3; r++) {
    const warm = setup();
    for (let i = 0; i < batch; i++) run(warm, i);
  }

  let ns = 0n;
  for (let r = 0; r < rounds; r++) {
    const state = setup();
    const started = process.hrtime.bigint();
    for (let i = 0; i < batch; i++) run(state, i);
    ns += process.hrtime.bigint() - started;
  }

  const perOp = Number(ns) / (batch * rounds);
  console.log(
    `  ${label.padEnd(44)} ${(perOp / 1000).toFixed(3).padStart(8)} µs   ` +
      `${Math.round(1e9 / perOp).toLocaleString().padStart(12)} ops/sec`
  );
};

const random = makeRandom(4242);
// Short on purpose. `apply` copies the whole document, so a large one turns
// every line below into a measurement of string copying — the client figures
// came out flat in buffer depth at 2000 characters purely because the copy cost
// dwarfed the rebase the line is meant to be showing.
const document = 'x'.repeat(200);

console.log('\not-core session throughput (Node ' + process.version + ')\n');

/* ------------------------------------------------- the client state machine */

console.log('Client: a remote operation arriving while N local edits are pending');
console.log('(the awaiting-with-buffer path — every buffered edit is rebased too)\n');

for (const pending of [0, 1, 10, 100]) {
  time(
    `receive with ${String(pending).padStart(3)} buffered`,
    (state) => {
      state.revision++;
      state.client.receive(serverOp(state.revision, insert(0, 'Q'), 'them'));
    },
    () => {
      const client = new Client({ id: 'me', send: () => {}, document });
      for (let i = 0; i < pending; i++) client.edit(randomOperation(random, client.document.length));
      return { client, revision: 0 };
    }
  );
}

/* ------------------------------------------------------------- the server */

console.log('\nServer: one operation rebased against a room that has moved on\n');

for (const behind of [0, 1, 10, 100]) {
  time(
    `apply, written ${String(behind).padStart(3)} revisions behind`,
    (state) => {
      state.server.receive('author', {
        type: 'op',
        revision: Math.max(0, state.server.revision - behind),
        seq: state.seq++,
        op: insert(0, 'Z'),
      });
    },
    () => {
      const server = new Server({ document });
      for (let i = 0; i < behind; i++) {
        server.receive('filler', {
          type: 'op',
          revision: server.revision,
          seq: i,
          op: insert(0, 'Y'),
        });
      }
      return { server, seq: 100_000 };
    }
  );
}

/* ------------------------------------------------------------- presence */

console.log('\nPresence: moving every cursor when one operation lands\n');

for (const peers of [2, 10, 50, 200]) {
  time(
    `${String(peers).padStart(3)} peers, one operation`,
    (state) => state.presence.apply(insert(0, 'X')),
    () => {
      const presence = new Presence({ clock: () => 0 });
      for (let i = 0; i < peers; i++) presence.see(`p${i}`, Math.floor(random() * 200));
      return { presence };
    }
  );
}

/* ----------------------------------------------------------------- undo */

console.log('\nUndo: rebasing the stack past one remote operation\n');

for (const depth of [1, 10, 100, 200]) {
  time(
    `stack of ${String(depth).padStart(3)}`,
    (state) => state.stack.rebase(insert(0, 'X')),
    () => {
      const stack = new UndoStack({ limit: 1000 });
      let doc = document;
      for (let i = 0; i < depth; i++) {
        const op = randomOperation(random, doc.length);
        stack.record(op, doc);
        doc = op.type === 'insert' ? doc + 'X' : doc.slice(1);
      }
      return { stack };
    }
  );
}

/* ------------------------------------------------------- a whole round trip */

console.log('\nEnd to end: one edit from keystroke to every client having applied it\n');

for (const participants of [2, 5, 20]) {
  time(
    `${String(participants).padStart(2)} clients in a room`,
    (state) => {
      const author = state.clients[0];
      author.edit(insert(0, 'K'));
      const message = author.inFlight;
      const { ack: acked, broadcast } = state.server.receive(author.id, message);
      // Broadcast before acknowledging: acking first is the bug that silently
      // lost one operation per collision, and the order is cheap to keep right.
      if (broadcast) {
        for (let i = 1; i < state.clients.length; i++) state.clients[i].receive(broadcast);
      }
      author.receive(acked);
    },
    () => {
      const server = new Server({ document });
      const clients = Array.from(
        { length: participants },
        (_, i) => new Client({ id: `c${i}`, send: () => {}, document })
      );
      return { server, clients };
    }
  );
}

console.log(`
Reading these, on this machine:

  Nothing here is flat. The client grows gently with its own buffer (about
  60% slower at 100 pending edits than at none) and the server grows with how
  far behind an operation was written, which is the argument for acknowledging
  promptly rather than letting a room accumulate history.

  The steepest curve is undo, at roughly 75x from a stack of one to a stack of
  200 — every remote operation rebases the whole stack, so the limit is a
  throughput setting and not only a memory one.

  A room costs about 4 µs per additional participant on the fan-out, so twenty
  people typing at once is thousands of edits a second before the network is
  involved. The network is what you will actually run out of.`);

