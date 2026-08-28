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

/** Turn "the document used to say this and now says that" into operations. */
export function diff(before: string, after: string): Operation[];
