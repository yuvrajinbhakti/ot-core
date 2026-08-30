import type { Extension, Text, ChangeSet, AnnotationType } from '@codemirror/state';
import type { Operation } from './index.js';
import type { Client } from './client.js';

/**
 * Keeps a CodeMirror editor and an ot-core `Client` in step.
 *
 * ```ts
 * const view = new EditorView({
 *   doc: client.document,
 *   parent: element,
 *   extensions: [collaborate(client)],
 * });
 * ```
 *
 * The editor's own selection needs nothing from this library — CodeMirror maps
 * it through the change set it is given. `transformPosition` is for positions
 * held outside the editor.
 */
export function collaborate(client: Client): Extension;

/**
 * Marks a transaction as one the binding applied, so it is not sent back to the
 * server. Exported for applications that dispatch remote changes themselves.
 */
export const fromCollaborator: AnnotationType<boolean>;

/** The operations equivalent to a change set, to apply in order. */
export function operationsFromChanges(before: Text, changes: ChangeSet): Operation[];

/** The change equivalent to one operation, or null if it is a no-op. */
export function changeFromOperation(
  doc: Text,
  op: Operation
): { from: number; to?: number; insert?: string } | null;

/** UTF-16 code units to code points. */
export function toCodePoint(doc: Text, offset: number): number;

/** Code points to UTF-16 code units. */
export function toOffset(doc: Text, position: number): number;

/**
 * Move an offset off the middle of a surrogate pair — `down` to before the
 * character, `up` to after it. CodeMirror's own editing never produces such an
 * offset, but a programmatic dispatch can.
 */
export function snapToBoundary(doc: Text, offset: number, direction: 'down' | 'up'): number;
