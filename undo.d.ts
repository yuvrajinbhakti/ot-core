import type { Operation } from './index.js';
import type { Client } from './client.js';

/**
 * Undo in a document somebody else is also typing in.
 *
 * Undo removes **what survives of your contribution** — it does not restore the
 * document to how it looked before your edit, because that document no longer
 * exists.
 *
 * Known limitation: if somebody types inside a run of text you inserted, undoing
 * your insert removes their characters too. That is this library's central
 * trade-off (an insert inside a concurrently deleted range is swallowed)
 * arriving somewhere visible.
 */
export class UndoStack {
  constructor(options?: { limit?: number });

  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undoable: Operation[];
  redoable: Operation[];

  /** Record a local edit, with the document as it was immediately before it. */
  record(op: Operation, before: string): void;

  /** Rebase both stacks past an operation somebody else made. */
  rebase(remote: Operation): void;

  /** The operation that undoes the most recent surviving local edit, or null. */
  undo(document: string): Operation | null;

  redo(document: string): Operation | null;

  clear(): void;
}

export interface History {
  stack: UndoStack;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): Operation | null;
  redo(): Operation | null;
  detach(): void;
}

/** Wire an `UndoStack` to a `Client` so it records and rebases itself. */
export function attachHistory(client: Client, options?: { limit?: number }): History;
