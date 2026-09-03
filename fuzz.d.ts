import type { Operation } from './index.js';

/** A deterministic pseudo-random source, so a failure reproduces from its seed. */
export function makeRandom(seed: number): () => number;

/** One random edit against `doc`, biased towards collisions rather than realism. */
export function randomOperation(random: () => number, doc: string): Operation;

/** A short document, biased small so random edits overlap often. */
export function randomDocument(random: () => number): string;

/**
 * Both orderings of a concurrent pair: `[yours-then-theirs, theirs-then-yours]`.
 * Convergence means these two strings are equal.
 */
export function bothOrderings(doc: string, a: Operation, b: Operation): [string, string];

/** Human-readable form of an operation, for reporting a counterexample. */
export function describe(op: Operation): string;

/** A pair that failed to converge, with everything needed to reproduce it. */
export interface Divergence {
  doc: string;
  a: Operation;
  b: Operation;
  /** What the participant who applied `a` first ended up holding. */
  left: string;
  /** What the participant who applied `b` first ended up holding. */
  right: string;
}

export interface ConvergenceResult {
  pairs: number;
  divergences: number;
  ms: number;
  examples: Divergence[];
}

export interface ConvergenceOptions {
  /** How many concurrent pairs to check. Default 100000. */
  pairs?: number;
  /** Fixed seed, so a failure is reproducible. Default 42. */
  seed?: number;
  /** How many counterexamples to keep. Default 5. */
  maxExamples?: number;
  /** Called with (done, total) during the run. */
  onProgress?: (done: number, total: number) => void;
  /** Pairs between `onProgress` calls. Default 5000. */
  progressEvery?: number;
  /** Clock, injectable for testing. Default `Date.now`. */
  now?: () => number;
}

/**
 * Run the TP1 convergence property over random concurrent pairs.
 *
 * Counts divergences rather than throwing, so a caller can report them.
 * `divergences === 0` is the assertion; `examples` is how you debug a failure.
 */
export function checkConvergence(options?: ConvergenceOptions): ConvergenceResult;
