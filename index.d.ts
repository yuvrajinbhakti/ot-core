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
