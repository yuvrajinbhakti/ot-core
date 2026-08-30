export interface Operation {
  type: 'insert' | 'delete';
  /** Offset in Unicode code points, not UTF-16 units. */
  position: number;
  /** The inserted text; empty for a delete. */
  content: string;
  /** Code points inserted or removed. Zero means the operation is a no-op. */
  length: number;
}

/**
 * Which participant yields when two inserts collide at the same index. The two
 * sides must pass opposite values, derived from something stable that both
 * agree on — comparing site ids, for instance.
 */
export type Side = 'left' | 'right';

export function insert(position: number, content: string): Operation;
export function remove(position: number, length: number): Operation;
export function isNoop(op: Operation): boolean;

export function apply(doc: string, op: Operation): string;
export function applyAll(doc: string, ops: readonly Operation[]): string;

/** Rewrite `a` so it can be applied after `b`. */
export function transform(a: Operation, b: Operation, side: Side): Operation;

/** Rewrite `a` over a run of operations applied before it, oldest first. */
export function transformAgainst(a: Operation, others: readonly Operation[], side: Side): Operation;

export interface Selection {
  anchor: number;
  head: number;
}

/**
 * Where does `position` end up once `op` is applied?
 *
 * `bias` decides only what happens when an insert lands exactly on the
 * position: 'left' (the default) keeps the cursor put, so a collaborator typing
 * at your caret does not drag it; 'right' pushes it along, which is what you
 * want for the local echo of your own typing.
 */
export function transformPosition(position: number, op: Operation, bias?: Side): number;

/**
 * Move both ends of a selection. Each end leans outward, so text arriving at a
 * boundary lands outside the selection rather than being absorbed into it.
 */
export function transformSelection(selection: Selection, op: Operation): Selection;

/** Turn "the document used to say this and now says that" into operations. */
export function diff(before: string, after: string): Operation[];

/**
 * One operation equivalent to `a` then `b`, or `null` where the model cannot
 * express it. `b` must be written against the document as it stands after `a`.
 *
 *     apply(doc, compose(a, b)) === apply(apply(doc, a), b)
 *
 * Merges a burst of typing into one operation, and a backspace run into one
 * delete. Returns `null` for edits in two places, and for a replacement — which
 * is irreducibly two operations here, and is why `diff` returns two.
 */
export function compose(a: Operation, b: Operation): Operation | null;

/** Compose a run as far as it will go, dropping anything that cancels out. */
export function composeAll(ops: readonly Operation[]): Operation[];

/**
 * The operation that undoes `op`, given the document `op` was applied to.
 *
 *     apply(apply(doc, op), invert(op, doc)) === doc
 *
 * Needs the document because a delete does not record what it removed. To undo
 * in a shared document, transform the inverse past everything that has happened
 * since — see `transformAgainst`.
 *
 * @throws {RangeError} if `op` is not in range for `doc`.
 */
export function invert(op: Operation, doc: string): Operation;

/** Invert a run into a run that undoes it, in the order to apply them. */
export function invertAll(ops: readonly Operation[], doc: string): Operation[];

/**
 * Why `op` is not usable, or `null` if it is. For operations arriving over a
 * network, where `apply` clamping an out-of-range position means silently
 * damaging the document rather than throwing.
 *
 * Pass `documentLength` in code points to also check the operation fits.
 */
export function whyInvalid(op: unknown, documentLength?: number): string | null;

export function isValid(op: unknown, documentLength?: number): boolean;

/** @throws {TypeError} with the reason. Returns the operation for chaining. */
export function assertValid(op: unknown, documentLength?: number): Operation;
