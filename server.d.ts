import type { Operation } from './index.js';
import type { ServerMessage } from './protocol.js';

export interface HistoryEntry {
  revision: number;
  op: Operation;
  author: string;
}

/**
 * The authority. Its job is to decide an order, because that is the one thing
 * transformation cannot do for itself — three concurrent operations applied in
 * different orders reach different documents about 3.6% of the time.
 *
 * Takes decoded messages and returns what to send. It does not know what a
 * socket is, which is why it can be tested exhaustively without one.
 */
export class Server {
  constructor(options?: { document?: string; revision?: number });

  readonly document: string;
  readonly revision: number;
  readonly history: Array<{ op: Operation; author: string }>;
  /** The oldest revision still rebaseable; non-zero once compacted. */
  readonly baseRevision: number;

  /**
   * What a joining client needs.
   *
   * Narrowed to the `init` variant rather than the whole `ServerMessage` union.
   * This always returns an init — the wide type was not wrong, it was useless:
   * every caller had to narrow a union to reach `document` and `revision`, which
   * are present on every value this can return.
   */
  snapshot(): Extract<ServerMessage, { type: 'init' }>;

  /** @throws {RangeError} if that revision has been compacted away. */
  since(revision: number): HistoryEntry[];

  /**
   * `ack` goes to `clientId`, `broadcast` to everybody else. `broadcast` is null
   * when nothing changed — a duplicate resend, or an edit a concurrent delete
   * cancelled entirely.
   */
  receive(clientId: string, message: unknown): {
    ack: ServerMessage;
    broadcast: ServerMessage | null;
    applied: boolean;
  };

  /** Drop history below `revision`. Returns how many entries went. */
  compact(revision: number): number;

  forget(clientId: string): boolean;
}
