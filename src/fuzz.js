/**
 * The convergence fuzzer, as a module you can run yourself.
 *
 * This used to live inside `test/convergence.test.js`, where it was the private
 * business of the test suite. It is exported now for two reasons.
 *
 * The first is honesty about drift. The visualiser shows a live convergence
 * count, and if it carried its own copy of the generator, that number would
 * slowly stop meaning what the test means — a page reporting "0 divergences"
 * from a weaker generator than the suite uses is worse than no page, because it
 * looks like evidence. One generator, imported by both, cannot drift.
 *
 * The second is that the property is more useful to you than to me. If you wrap
 * this library, or write your own transform, or want to check that a change of
 * yours preserved convergence, the check is the same check — so here it is.
 *
 *   import { checkConvergence } from 'ot-core/fuzz';
 *   const result = checkConvergence({ pairs: 100_000 });
 *   // { pairs: 100000, divergences: 0, ms: 412, examples: [] }
 *
 * ## What it actually tests
 *
 * TP1, and only TP1: for two operations written against the same document,
 *
 *   apply(apply(doc, a), transform(b, a, 'right'))
 *     ===
 *   apply(apply(doc, b), transform(a, b, 'left'))
 *
 * Both participants apply their own edit first and the other's second, and must
 * end up holding identical text. That is what convergence *is*. It is checkable
 * without knowing what the document should say, which is what makes it fuzzable
 * — there is no expected output to write down, only two strings that must match.
 *
 * This library does not claim TP2, and nothing here tests for it.
 */

import { insert, remove, apply } from './operation.js';
import { transform as realTransform } from './transform.js';

/**
 * A small deterministic PRNG.
 *
 * Deliberately not `Math.random`: a divergence found by this fuzzer has to be
 * reproducible from its seed, or the report is an anecdote about something that
 * happened once. Linear congruential, which is a poor generator for anything
 * cryptographic and entirely adequate for shaking out an off-by-one.
 */
export function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/**
 * One random edit against `doc`.
 *
 * The distribution is tuned to collide, not to look realistic. Real prose gives
 * you two people typing in different paragraphs, which converges trivially and
 * tests nothing; the interesting cases are two edits landing on the same few
 * characters. So documents are short, edits are short, and half of everything is
 * a delete.
 */
export function randomOperation(random, doc) {
  const size = Array.from(doc).length;
  if (size === 0 || random() < 0.5) {
    const position = Math.floor(random() * (size + 1));
    // Length 0 to 4. Single-character inserts were all the first version of this
    // generator produced, which left the length arithmetic in three of the four
    // transform branches barely exercised — a one-character insert shifts a
    // position by one whether or not the code meant to use its length. Zero is in
    // the range because a transform that cancels an operation returns an empty
    // one, and those get fed back through.
    const size4 = Math.floor(random() * 5);
    return insert(position, 'XYZW'.slice(0, size4));
  }
  const position = Math.floor(random() * size);
  const length = Math.floor(random() * (Math.min(4, size - position) + 1));
  return remove(position, length);
}

/** A short document, biased small so random edits overlap often. */
export function randomDocument(random) {
  return 'abcdefgh'.slice(0, 3 + Math.floor(random() * 6));
}

/**
 * Both orderings of a concurrent pair. Convergence means these two agree.
 *
 * The `side` arguments are not decoration. When two inserts land on the exact
 * same position there is no fact of the matter about which goes first, so the
 * two participants have to break the tie the same way or they diverge — one is
 * told to yield, the other to hold its ground.
 */
export function bothOrderings(doc, a, b, transform = realTransform) {
  return [
    apply(apply(doc, a), transform(b, a, 'right')),
    apply(apply(doc, b), transform(a, b, 'left')),
  ];
}

/**
 * A transform that does nothing, for checking that the check works.
 *
 * A property test that passes is only evidence if it could have failed, and
 * "zero divergences" looks identical whether the transform is correct or the
 * harness is broken. Running the same fuzzer against a transform that ignores
 * the operation it is supposed to rebase against settles that: it diverges on
 * roughly half of all pairs. If it ever reported zero, the fuzzer would be
 * measuring nothing.
 *
 * This is not a strawman. Returning the operation unchanged is what an OT
 * implementation does before anyone has written the hard part, and it is the
 * shape most naive merge code takes.
 */
export const identityTransform = (a) => a;

/** Human-readable form of an operation, for reporting a counterexample. */
export function describe(op) {
  return op.type === 'insert'
    ? `insert(${op.position}, ${JSON.stringify(op.content)})`
    : `remove(${op.position}, ${op.length})`;
}

/**
 * Run the convergence property over random concurrent pairs.
 *
 * @param {object}   [options]
 * @param {number}   [options.pairs=100000]      how many pairs to check
 * @param {number}   [options.seed=42]           fixed, so failures reproduce
 * @param {number}   [options.maxExamples=5]     counterexamples to keep
 * @param {function} [options.onProgress]        called with (done, total)
 * @param {number}   [options.progressEvery=5000] pairs between progress calls
 * @param {function} [options.now=Date.now]      clock, injectable for testing
 * @param {function} [options.transform]          the transform under test; defaults
 *   to this library's. Pass `identityTransform` to confirm the property can fail.
 * @returns {{pairs: number, divergences: number, ms: number, examples: Array}}
 *
 * Does not throw on divergence — it counts. A caller that wants an assertion can
 * check `divergences === 0`, and a caller that wants to *see* the failures gets
 * them in `examples`, each with the document and both operations needed to
 * reproduce it by hand.
 */
export function checkConvergence(options = {}) {
  const {
    pairs = 100_000,
    seed = 42,
    maxExamples = 5,
    onProgress,
    progressEvery = 5_000,
    now = Date.now,
    transform = realTransform,
  } = options;

  const random = makeRandom(seed);
  const examples = [];
  let divergences = 0;
  const started = now();

  for (let i = 0; i < pairs; i++) {
    const doc = randomDocument(random);
    const a = randomOperation(random, doc);
    const b = randomOperation(random, doc);
    const [left, right] = bothOrderings(doc, a, b, transform);

    if (left !== right) {
      divergences++;
      if (examples.length < maxExamples) {
        examples.push({ doc, a, b, left, right });
      }
    }

    if (onProgress && (i + 1) % progressEvery === 0) {
      onProgress(i + 1, pairs);
    }
  }

  return { pairs, divergences, ms: now() - started, examples };
}
