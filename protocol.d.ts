import type { Operation } from './index.js';

export interface ClientMessage {
  type: 'op';
  /** The document version this edit was written against. */
  revision: number;
  /**
   * Identifies the operation, not the transmission. A resend reuses it, which
   * is how the server tells "you already have this" from "here is a new edit".
   */
  seq: number;
  op: Operation;
}

export type ServerMessage =
  | { type: 'init'; revision: number; document: string }
  | { type: 'ack'; revision: number; seq: number }
  | { type: 'op'; revision: number; op: Operation; author: string }
  | { type: 'error'; code: string; reason: string };

export const ERRORS: {
  readonly MALFORMED: 'malformed';
  readonly FUTURE_REVISION: 'future-revision';
  /** History was compacted past this client's revision. It has to rejoin. */
  readonly BEHIND_HISTORY: 'behind-history';
  readonly OUT_OF_RANGE: 'out-of-range';
};

export function clientOp(revision: number, seq: number, op: Operation): ClientMessage;
export function init(revision: number, document: string): ServerMessage;
export function ack(revision: number, seq: number): ServerMessage;
export function serverOp(revision: number, op: Operation, author: string): ServerMessage;
export function error(code: string, reason: string): ServerMessage;

export function whyInvalidClientMessage(message: unknown): string | null;
export function whyInvalidServerMessage(message: unknown): string | null;
export function isClientMessage(message: unknown): boolean;
export function isServerMessage(message: unknown): boolean;

export function encode(message: ClientMessage | ServerMessage): string;
export function decodeClientMessage(text: string): ClientMessage;
export function decodeServerMessage(text: string): ServerMessage;
