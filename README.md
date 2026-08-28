# ot-engine

Operational Transform for plain text, with the convergence property actually
tested.

```bash
npm install @yuvrajinbhakti/ot-engine
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
import { insert, remove, apply, transform, diff } from '@yuvrajinbhakti/ot-engine';

const doc = 'the cat sat';

// Two people edit the same text at the same moment.
const mine   = insert(4, 'big ');   // "the big cat sat"
const theirs = remove(4, 3);        // "the sat"

// Each applies their own edit, then the other's — transformed.
const iSee    = apply(apply(doc, mine),   transform(theirs, mine,   'right'));
const theySee = apply(apply(doc, theirs), transform(mine,   theirs, 'left'));

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
import { transformAgainst } from '@yuvrajinbhakti/ot-engine';

const rebased = transformAgainst(incoming, historySince(incoming.version), 'left');
```

### Choosing a side

`side` must be `'left'` for one participant and `'right'` for the other, and
both must agree without talking about it. Compare something stable — site ids,
or client id against server:

```js
const side = myId < peerId ? 'left' : 'right';
```

Getting this wrong is silent. Everything works until two people type in the same
place.

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
| `diff(before, after)`               | turn two document states into operations                  |
| `isNoop(op)`                        | did transform cancel this operation?                      |

Positions count Unicode code points, not UTF-16 units, so an emoji is one
position rather than two.

## Testing

```bash
npm test     # 20 tests, 320,000 fuzzed convergence checks
npm run bench
```

The fuzzer uses a fixed seed, so a failure is reproducible rather than a story
about something that happened once on CI. It also biases hard towards
collisions — short alphabet, short documents, small edits — because the bugs it
is looking for only appear when two edits genuinely overlap.

## What this is not

Not a CRDT: it needs a server to order operations. Not rich text: plain strings
only. No undo stack, no cursor transformation, no presence. Those are all
buildable on top, and none of them belong in the part that has to be provably
correct.

## License

MIT
