import type { Operation, Selection } from './index.js';
import type { ClientMessage, HistoryEntry } from './protocol.js';

export const SYNCHRONIZED: 'synchronized';
export const AWAITING: 'awaiting';
export const AWAITING_WITH_BUFFER: 'awaiting-with-buffer';

export type ClientState = 'synchronized' | 'awaiting' | 'awaiting-with-buffer';

export interface ClientError {
  code: string;
  reason: string;
  /**
   * Unconfirmed edits the client had to drop. The server rejected the operation
   * in flight, so these exist nowhere else — hand them to the user or replay
   * them after re-requesting `init`.
   */
  discarded?: Operation[];
}

/**
 * One operation in flight at a time; edits made while waiting are buffered and
 * composed, so a burst of typing that spans a round trip leaves as one message.
 */
export class Client {
  constructor(options: {
    id: string;
    send: (message: ClientMessage) => void;
    document?: string;
    revision?: number;
    onRemote?: (op: Operation) => void;
    onError?: (e: ClientError) => void;
  });

  readonly id: string;
  document: string;
  revision: number;
  readonly state: ClientState;
  /** Edits the server has not confirmed. */
  readonly unconfirmed: Operation[];
  connected: boolean;
  /** Kept in step with remote edits. Null to track your own instead. */
  selection: Selection | null;

  /** A local edit, written against this client's current document. */
  edit(op: Operation): void;
  /** The same, from an editor that hands you a whole new value. */
  editText(text: string): void;
  receive(message: unknown): void;

  /** Stop sending. Edits keep working and accumulate. */
  disconnect(): void;
  /** Catch up on `server.since(client.revision)`, then re-send what was in flight. */
  reconnect(missed?: Array<{ revision: number; op: Operation; author: string }>): void;
}
