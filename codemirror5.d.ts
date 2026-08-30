import type { Operation } from './index.js';
import type { Client } from './client.js';

/** A CodeMirror 5 change, as reported by the `changes` event. */
export interface Change {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
  text: string[];
  removed?: string[];
  origin?: string;
}

/**
 * Keeps a CodeMirror 5 editor and an ot-core `Client` in step.
 *
 * ```ts
 * const detach = collaborate(cm, client);
 * ```
 *
 * Separate from the version 6 binding because the two report changes in
 * different coordinate systems: version 6 gives every change against the
 * pre-image, version 5 reports them sequentially.
 */
export function collaborate(cm: any, client: Client): () => void;

/** The `origin` given to changes this binding applies. */
export const REMOTE_ORIGIN: string;

/** The operations equivalent to one `changes` batch, to apply in order. */
export function operationsFromChanges(before: string, changes: Change[]): Operation[];

/** Apply one operation to a CodeMirror 5 instance. No-ops are skipped. */
export function applyOperation(cm: any, op: Operation): void;

/** Snap an offset out of the middle of a surrogate pair. */
export function snapToBoundary(text: string, offset: number, direction: 'down' | 'up'): number;

/** UTF-16 code units to code points. */
export function toCodePoint(text: string, offset: number): number;

/** Code points to UTF-16 code units. */
export function toOffset(text: string, position: number): number;
