# ot-core

[![test](https://github.com/yuvrajinbhakti/ot-core/actions/workflows/test.yml/badge.svg)](https://github.com/yuvrajinbhakti/ot-core/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/ot-core.svg)](https://www.npmjs.com/package/ot-core)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Operational Transform for plain text, with the convergence property actually
tested.

```bash
npm install ot-core
```

Zero dependencies. ESM. Node 18+ and any modern browser.

---

## Why this exists

I wrote an OT implementation for a collaborative code editor, load-tested it to
1,000 concurrent clients, and shipped it. It looked correct. Every manual test
passed.

Then I wrote a property test for TP1 — the one law OT exists to uphold — and
fed it random pairs of concurrent edits.

**16.2% of them diverged.** Two people editing at once ended up with different
documents, in every category of edit:

| concurrent pair   | diverged |
| ----------------- | -------: |
| delete vs delete  |    1,530 |
| insert vs insert  |      675 |
| insert vs delete  |      561 |
| delete vs insert  |      483 |
| **of 20,000**     | **3,249** |

This library is that implementation with the bugs found and fixed. The test
suite is the point of it.

```
200,000 random concurrent pairs   0 divergences
 50,000 on longer documents       0 divergences
 20,000 on emoji                  0 divergences
100,000 cursor moves              0 drifted off their character
240,000 compositions              0 disagreed with applying both
260,000 inversions                0 failed to round trip
 25,000 multi-client sessions     0 clients left holding a different document
```

## The three bugs

**1. No tie-breaker.** When two people insert at the same index, something has
to decide who goes first. The original returned both operations unchanged, so
each client kept its own position and the result depended on which message
happened to arrive first. `transform` now takes a `side` argument and exactly
one participant yields.

**2. Delete-versus-delete arithmetic.** Nested and partially-overlapping ranges
double-counted characters that the other delete had already removed. Replaced
with explicit interval arithmetic: subtract the overlap from the length, shift
the start by however much of the other delete fell before it.

**3. Insert inside a deleted range.** The two sides disagreed about whether the
inserted text survived. They now agree — see the trade-off below.

## Using it

```js
import { insert, remove, apply, transform, diff } from 'ot-core';

const doc = 'the cat sat';

// Two people edit the same text at the same moment.
const mine   = insert(4, 'big ');   // on its own: "the big cat sat"
const theirs = remove(4, 4);        // on its own: "the sat"

// Each applies their own edit, then the other's — transformed.
const iSee    = apply(apply(doc, mine),   transform(theirs, mine,   'right'));
const theySee = apply(apply(doc, theirs), transform(mine,   theirs, 'left'));

iSee;             // "the big sat"
iSee === theySee; // true, and that is the whole job
```

### Wiring it to an editor

A textarea hands you a new value, not an edit. `diff` bridges the gap, and
covers paste, drag-and-drop and autocorrect, which keystroke interception does
not:

```js
textarea.addEventListener('input', () => {
  for (const op of diff(lastValue, textarea.value)) socket.send(op);
  lastValue = textarea.value;
});
```

### Rebasing a late operation

When an edit written against version N arrives and the document is already at
N+2, fold it over everything it missed:

```js
import { transformAgainst } from 'ot-core';

const rebased = transformAgainst(incoming, historySince(incoming.version), 'left');
```

Two things this assumes, and neither is checked for you: the history is in the
order it was actually applied, and `incoming` was written against the document
as it stood immediately before the first of them. Fold the wrong range in and
the result is silently wrong rather than an error.

A single `side` for the whole run is correct when a server decides the order,
because the question is only ever "does the incoming edit yield to the settled
history" — and the answer is the same for every operation in it.

## You need a server, and here is the proof

This used to say that peer-to-peer "needs a side per originating peer", which
implied that choosing sides carefully was enough. It is not, and the difference
matters enough to state with an example rather than a caveat.

Convergence over a *pair* of operations is TP1, which this library has and tests
exhaustively. Convergence when different participants transform in *different
orders* is TP2, which this library does not have — and almost no operational
transform does. Take a two-character document and three edits:

```js
const doc = 'ab';
insert(1, 'X')      // peer 0
insert(0, 'XY')     // peer 1
remove(0, 1)        // peer 2
```

Deliver those three to six peers in the six possible orders, with a stable
per-peer tie-break, and they land on two different documents:

```
0 → 1 → 2    "XYXb"
0 → 2 → 1    "XYXb"
1 → 0 → 2    "XYXb"
1 → 2 → 0    "XYXb"
2 → 0 → 1    "XXYb"     <-
2 → 1 → 0    "XXYb"     <-
```

That is the smallest case there is; it was found by exhaustive search, and it is
asserted in `test/session.test.js` so it cannot quietly stop being true. Across
random triples the rate is about 3.6%.

Impose one order — any order, as long as everybody sees the same one — and it
goes to zero across 200,000 triples. That is what the server is for. It is not a
deployment detail you can engineer around with a cleverer `side`.

What *is* tested end to end: 20,000 simulated sessions of up to five clients
against one server, with edits in flight and acknowledgements arriving late, all
converging on the server's document — and, at every acknowledgement, the client's
own rebase of its pending operation matching the server's, which is the invariant
the whole protocol rests on.

## The client and the server

The algebra above is the hard part and it is not a collaborative editor. What
was missing was everything between two people's keyboards: who holds an edit
while an earlier one is in flight, what happens to a socket that drops after the
server accepted an edit but before the acknowledgement got home, and what a
client does with the four hundred milliseconds of typing it did while offline.

Those ship now, as subpaths of the same package.

```js
// browser
import { connect } from 'ot-core/websocket';

const client = connect(new WebSocket(url), {
  id: myUserId,
  onReady: () => textarea.removeAttribute('disabled'),
  onChange: (c) => { textarea.value = c.document; },
});

textarea.addEventListener('input', () => client.editText(textarea.value));
```

```js
// server
import { Server } from 'ot-core/server';
import { Room } from 'ot-core/websocket';

const room = new Room(new Server({ document: load(docId) }));
wss.on('connection', (socket, request) => room.join(userIdFrom(request), socket));
```

### One package, four entry points

Not four packages, and the reason is specific to this problem rather than a
preference. A client and a server running different versions of `transform`
diverge silently — no error, no crash, two documents that drift apart over an
hour and cannot be reconciled afterwards. Four packages with independent version
ranges make that a thing a lockfile can do to you. One package makes it
impossible. Subpaths tree-shake identically: `ot-core/websocket` in a browser
bundle does not drag the server in.

### What the client actually does

```
synchronized ──edit──► awaiting ──edit──► awaiting-with-buffer
     ▲                    │                        │
     └────────ack─────────┘                        │
     ▲                    ▲───────ack──────────────┘
```

One operation on the wire at a time. Edits made while waiting go into a buffer
and are composed as they arrive, so a burst of typing that spans a round trip
leaves as one message rather than twelve.

The third state is where the bodies are. An operation arriving from the server
has to be transformed past the outstanding operation *and* past every buffered
one in order, while each of those is rebased past it. Doing only the first half
looks entirely plausible and works until three people overlap.

### Four bugs this found, and none of them were in the algebra

Written against 30,000 simulated sessions with a deliberately hostile wire.
Every one of these passed a hand-written example first.

**A resend must replay the message, not rebuild it.** Between the first send and
the resend, arriving operations rebase the outstanding operation — so a rebuilt
message carries a *different operation under the same sequence number*. The
server applies one and deduplicates the other, and the two sides disagree about
which, permanently. Messages are immutable; the server rebases from the revision
the message carries.

**Reconnecting must not transmit mid-catch-up.** Recognising your own operation
in the history you missed and promoting the next buffered one is right; sending
it there is not, because the rest of the missed history has not rebased it yet.
Same failure as above, reached from the other direction.

**A client must ignore operations it already has.** A reconnecting client
catches up through `since()`, and a broadcast of one of those revisions can
still be in flight. Applying it twice inserts the text twice, permanently, and
nothing downstream can tell that from an OT bug. The revision is already on the
message, so the check is free.

**A rejected operation has to be let go of.** A client whose edit the server
refused sat in `awaiting` forever, transforming everybody else's operations
against something that did not exist. It now drops the unconfirmed work and
hands it back in `onError({ discarded })` so the application can decide, rather
than diverging quietly.

The test harness asserts that a well-formed client is *never* rejected — the
recovery path exists, and letting it run would hide the next real bug.

### Offline

Falls out of the state machine rather than being a feature bolted to it.
`disconnect()` stops sending; edits keep applying locally and accumulating.
`reconnect(server.since(client.revision))` catches up and pushes.

```js
client.disconnect();
client.editText('...typed on a train...');
client.reconnect(await fetchMissedOperations(client.revision));
```

The resend is unconditional, because from the client's side "the acknowledgement
never arrived" and "the edit never arrived" are the same observation. The `seq`
on the message is what lets the server tell them apart.

### Compaction

Rebasing is linear in history depth — 0.016µs against one operation, 22µs
against a thousand — so a room that never drops history gets slower for as long
as it stays open. `Room` compacts to the slowest member still connected;
`Server.compact(revision)` is there if you are managing membership yourself. A
client behind the compaction point is told `behind-history` and has to rejoin,
which is a real answer rather than a wrong document.


### Choosing a side

`side` must be `'left'` for one participant and `'right'` for the other, and
both must agree without talking about it. Compare something stable — site ids,
or client id against server:

```js
const side = myId < peerId ? 'left' : 'right';
```

Getting this wrong is silent. Everything works until two people type in the same
place.

### Moving cursors and selections

Transforming the document is half of collaborative editing. The other half is
that every caret, selection and highlight anchored to the text has to move with
it, or a remote insert three lines up quietly slides your cursor into the middle
of a word.

```js
import { transformPosition, transformSelection } from 'ot-core';

socket.on('operation', (op) => {
  setDoc((doc) => apply(doc, op));
  setCaret((caret) => transformPosition(caret, op));
  setSelection((selection) => transformSelection(selection, op));
});
```

`transformPosition` takes the same `'left'` / `'right'` bias, and it decides one
thing: what happens when an insert lands *exactly* on the position. `'left'` is
the default and keeps the cursor where it is, so a collaborator typing at your
caret does not drag it along. Use `'right'` for the local echo of your own
typing, where the caret should follow what you wrote.

`transformSelection` leans each end outward, so text arriving at either boundary
falls *outside* the selection. The intuitive-looking choice — leaning both ends
inward — makes a selection silently grow to cover whatever a collaborator types
at its edges.

### Batching and undo

Five keystrokes are five operations on the wire, five entries in the history
every future operation has to be transformed against, and five steps in an undo
stack that will undo one character at a time. They are also, obviously, one
insert:

```js
import { composeAll, insert } from 'ot-core';

composeAll([insert(4, 'h'), insert(5, 'e'), insert(6, 'y')]);
// [ insert(4, 'hey') ]
```

`compose(a, b)` returns `null` when the model cannot express the pair as one
operation — edits in two places, or a replacement. `composeAll` keeps those
separate and drops anything that cancels out entirely, so typing a word and
deleting it again produces nothing to send.

Undo is `invert`, and then the same transform as everything else, because by the
time somebody presses Ctrl-Z other people have edited:

```js
import { invert, transformAgainst } from 'ot-core';

const inverse = invert(myOperation, documentBeforeIt);
const undo = transformAgainst(inverse, everythingSince, 'left');
```

One thing to expect: if somebody has already deleted across the text you typed,
your undo correctly does nothing. Undo here means "remove what is left of my
contribution", not "recompute history as though I never typed" — the second is
exclusion transformation, and this library does not do it.

### Operations off the network

`insert()` and `remove()` validate their arguments, which does not help with the
operation a client sent you. `apply` clamps an out-of-range position on purpose,
so a malformed delete does not throw — it removes the wrong text, and every
client converges on the damage:

```js
import { assertValid } from 'ot-core';

socket.on('operation', (raw) => {
  const op = assertValid(raw, Array.from(doc).length);  // throws with the reason
  doc = apply(doc, op);
});
```

## The trade-off you should know about

If you type into text that someone else is deleting at that exact moment, your
character is dropped.

This is forced by the operation model. An operation here is one position and one
length, and preserving your insert would require splitting their delete into two
pieces — which this model cannot express. The alternative is to model operations
as *sequences* of retain/insert/delete components, the way
[Quill Delta](https://quilljs.com/docs/delta/) and ShareDB do. That is strictly
more capable and considerably more machinery.

The single-operation model is the right trade for cursor-level editing, where
concurrent insert-into-deleted-text is rare and losing one character to it is
defensible: the text you were typing into no longer exists.

## Performance

Measured with `npm run bench` on Node 22, Apple silicon:

```
transform(a, b)                    0.015 µs      66,000,000 ops/sec
rebase against    1 operations     0.031 µs      32,000,000 ops/sec
rebase against   10 operations     0.099 µs      10,000,000 ops/sec
rebase against  100 operations     1.011 µs         989,000 ops/sec
rebase against 1000 operations    22.467 µs          44,500 ops/sec
```

Rebasing is linear in history depth. A single transform is never the
bottleneck; letting a room accumulate unbounded history is. Acknowledge and
compact.

## API

| export                              | does                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `insert(position, content)`         | build an insert operation                                 |
| `remove(position, length)`          | build a delete operation                                  |
| `apply(doc, op)`                    | apply one operation to a string                           |
| `applyAll(doc, ops)`                | apply several, in order                                   |
| `transform(a, b, side)`             | rewrite `a` to apply after `b`                            |
| `transformAgainst(a, ops, side)`    | rewrite `a` over a run of operations, oldest first        |
| `transformPosition(pos, op, bias)`  | move a caret when `op` is applied                         |
| `transformSelection(sel, op)`       | move both ends of a `{ anchor, head }` selection          |
| `diff(before, after)`               | turn two document states into operations                  |
| `isNoop(op)`                        | did transform cancel this operation?                      |
| `compose(a, b)`                     | one operation meaning `a` then `b`, or `null`             |
| `composeAll(ops)`                   | collapse a run as far as the model allows                 |
| `invert(op, doc)`                   | the operation that undoes `op`                            |
| `invertAll(ops, doc)`               | a run that undoes a run                                   |
| `isValid(op, docLength?)`           | is this safe to apply?                                    |
| `whyInvalid(op, docLength?)`        | the reason it is not, or `null`                           |
| `assertValid(op, docLength?)`       | the same, but throws                                      |

From `ot-core/client`, `ot-core/server`, `ot-core/websocket` and
`ot-core/protocol`:

| export                              | does                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `Client`                            | the three-state client, buffering and rebasing             |
| `Server`                            | the authority: orders operations, rebases late ones        |
| `connect(socket, options)`          | a `Client` wired to a WebSocket-shaped thing               |
| `Room(server)`                      | a `Server` plus fan-out, membership and compaction         |
| `encode` / `decodeClientMessage`    | JSON with the validation a bare parse leaves to chance     |
| `ERRORS`                            | rejection codes a client has to branch on                  |

Positions count Unicode code points, not UTF-16 units, so an emoji is one
position rather than two.

## Testing

```bash
npm test     # 85 tests, 920,000 property checks + 55,000 simulated sessions
npm run bench
```

The fuzzer uses a fixed seed, so a failure is reproducible rather than a story
about something that happened once on CI. It also biases hard towards
collisions — short alphabet, short documents, small edits — because the bugs it
is looking for only appear when two edits genuinely overlap.

## What this is not

Not a CRDT: it needs a server to order operations, and the section above shows
what happens without one. Not rich text: plain strings only. No presence, no
transport, no editor bindings — those belong in packages that depend on this
one, not in it.

No undo *stack*, though `invert` is the piece one needs. Deciding what a user
meant by Ctrl-Z — their last edit, or the last edit in the document — is an
application's question, not this library's.

This section used to claim there was no `compose` and could not be one, on the
grounds that two operations far apart cannot be expressed as one position and
one length. The first half was true and the second half was wrong. Edits far
apart do stay separate, but consecutive keystrokes are not far apart: typing a
five-letter word produces five inserts that are exactly one insert, and a
backspace run is one delete. `compose` merges those and returns `null` for the
rest, which is why `composeAll` returns an array rather than an operation.

## License

MIT
