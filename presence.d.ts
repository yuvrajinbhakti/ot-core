import type { Operation } from './index.js';
import type { Client } from './client.js';

export interface Selection {
  anchor: number;
  head: number;
}

export interface Peer {
  id: string;
  /** Code-point offsets into the *current* document. */
  selection: Selection;
  /** The revision this peer's position has been transformed up to. */
  revision: number;
  /** `clock()` when the peer was last heard from. */
  at: number;
  meta: Record<string, unknown>;
  /** True when the peer is present but has no cursor to draw. */
  absent: boolean;
}

export interface PresenceOptions {
  onChange?: (peers: Peer[]) => void;
  /** Recent operations kept for catching up late reports. Default 256. */
  retain?: number;
  /** Silence after which `sweep` drops a peer, in ms. Default 45000. */
  timeout?: number;
  clock?: () => number;
  /** Your own unacknowledged edits; incoming reports are rebased past them. */
  pending?: () => Operation[];
}

/**
 * Where everybody else's cursor is, and how those positions move as the
 * document changes.
 *
 * A data structure and the arithmetic, not a transport: presence is ephemeral,
 * lossy-tolerant and high-frequency, so it does not belong in the operation
 * channel. Send cursors however you like and hand what arrives to `see`.
 */
export class Presence {
  constructor(options?: PresenceOptions);

  peers: Map<string, Peer>;
  revision: number;
  pending: () => Operation[];

  /** A server-ordered operation was applied. Moves every peer. */
  apply(op: Operation, revision?: number): void;

  /**
   * An unacknowledged local edit was applied. Moves every peer, but is not
   * recorded as history — incoming reports are rebased past it via `pending`.
   */
  applyLocal(op: Operation): void;

  /**
   * A peer reported a position. Pass `revision` for anything off a network:
   * without it the report is treated as current and will drift.
   */
  see(
    id: string,
    selection: Selection | number | null,
    options?: { revision?: number; meta?: Record<string, unknown> }
  ): void;

  forget(id: string): void;

  /** Drop peers unheard from within `timeout`. Returns the ids dropped. */
  sweep(): string[];

  /** Everyone present with a cursor to draw. */
  list(): Peer[];

  get(id: string): Peer | null;

  clear(): void;
}

/** Keep a `Presence` in step with a `Client`. Returns a detach function. */
export function track(client: Client, presence: Presence): () => void;
