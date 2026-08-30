import type { Operation } from './index.js';
import type { Client } from './client.js';
import type { Server } from './server.js';

/** Anything with the shape of a browser WebSocket or of `ws`. */
export interface SocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: any) => void): void;
  on?(type: string, listener: (...args: any[]) => void): void;
}

/**
 * Wire a socket to a new Client. The document arrives as `init`, so wait for
 * `onReady` before letting anyone type.
 */
export function connect(
  socket: SocketLike,
  options: {
    id: string;
    onRemote?: (op: Operation) => void;
    onChange?: (client: Client) => void;
    onReady?: (client: Client) => void;
    onError?: (e: { code: string; reason: string; discarded?: Operation[] }) => void;
  }
): Client;

/** One Server, several sockets, and the fan-out between them. */
export class Room {
  constructor(server: Server, options?: { compact?: boolean });
  readonly server: Server;
  readonly members: Map<string, { socket: SocketLike; revision: number }>;
  join(clientId: string, socket: SocketLike): void;
  leave(clientId: string): boolean;
}
