/**
 * The type declarations, checked against the package that ships.
 *
 * Every .d.ts in this repo is hand-written, and until this file existed nothing
 * compared them to the JavaScript. That is the same failure this library is
 * otherwise about: a claim — "these are the types" — with no check pointed at
 * it. Three real exports were undeclared when this was added, one of them added
 * the same week and forgotten (`identityTransform`), which is how quickly the
 * drift starts.
 *
 * This imports through the package's own subpath exports rather than the source
 * files, so it exercises what a consumer actually resolves: the `exports` map,
 * the `types` field of each entry, and the declarations themselves.
 *
 * It asserts nothing at runtime. `tsc --noEmit` failing is the assertion.
 */

import {
  insert, remove, apply, applyAll, isNoop,
  transform, transformAgainst,
  transformPosition, transformSelection,
  diff, compose, composeAll, invert, invertAll,
  isValid, whyInvalid, assertValid,
  type Operation, type Side,
} from 'ot-core';

import { Client, SYNCHRONIZED, AWAITING, AWAITING_WITH_BUFFER } from 'ot-core/client';
import { Server } from 'ot-core/server';
import { decode, decodeClientMessage, decodeServerMessage, isClientMessage } from 'ot-core/protocol';
import { attach, connect, type SocketLike } from 'ot-core/websocket';
import { Presence, track } from 'ot-core/presence';
import { UndoStack, attachHistory } from 'ot-core/undo';
import { checkConvergence, identityTransform, makeRandom, randomOperation } from 'ot-core/fuzz';

// --- the primitives -------------------------------------------------------

const a: Operation = insert(0, 'hello');
const b: Operation = remove(2, 3);
const doc: string = apply('hello world', a);
const doc2: string = applyAll('hello', [a, b]);
const noop: boolean = isNoop(a);

const side: Side = 'left';
const rebased: Operation = transform(a, b, side);
const rebasedAll: Operation = transformAgainst(a, [b], 'right');

// --- positions and selections --------------------------------------------

const pos: number = transformPosition(5, a);
const sel = transformSelection({ anchor: 1, head: 4 }, a);
const anchor: number = sel.anchor;

// --- composition and inversion -------------------------------------------

const composed: Operation | null = compose(a, b);
const composedAll: Operation[] = composeAll([a, b]);
const undone: Operation = invert(a, 'hello world');
const undoneAll: Operation[] = invertAll([a, b], 'hello world');

// --- validation -----------------------------------------------------------

const ok: boolean = isValid(a);
const why: string | null = whyInvalid(a, 11);
const checked: Operation = assertValid(a);

// --- diff -----------------------------------------------------------------

const changes: Operation[] = diff('before', 'after');

// --- client and server ----------------------------------------------------

const client = new Client({
  id: 'me',
  send: (message) => void message,
  document: 'hello',
  revision: 0,
});
const state: string = client.state;
client.edit(insert(0, 'x'));
const _states: string[] = [SYNCHRONIZED, AWAITING, AWAITING_WITH_BUFFER];

const server = new Server({ document: 'hello' });
const snapshot = server.snapshot();
const revision: number = snapshot.revision;

// --- protocol -------------------------------------------------------------

const anyMessage = decode('{}', () => null);
const clientMessage = decodeClientMessage('{"type":"op","revision":0,"op":{}}');
const serverMessage = decodeServerMessage('{"type":"ack","revision":1}');
// A union — narrowing is the point of typing it this way.
const ackRevision: number | undefined =
  serverMessage.type === 'ack' ? serverMessage.revision : undefined;
const looksRight: boolean = isClientMessage({});

// --- websocket ------------------------------------------------------------

declare const socket: SocketLike;
const attached: Client = attach(client, socket, { onChange: (c) => void c.document });

// --- presence -------------------------------------------------------------

const presence = new Presence({ onChange: () => {} });
presence.see('someone', { anchor: 0, head: 0 });
track(client, presence);

// --- undo -----------------------------------------------------------------

const stack = new UndoStack({ limit: 50 });
attachHistory(client, { limit: 50 });

// --- fuzz -----------------------------------------------------------------

const result = checkConvergence({ pairs: 1000, seed: 1 });
const divergences: number = result.divergences;
const broken = checkConvergence({ pairs: 1000, transform: identityTransform });
const rng = makeRandom(42);
const randomOp: Operation = randomOperation(rng, 'abc');

// Keep every binding used so noUnusedLocals would not be the thing that fails.
export const _used = [
  doc, doc2, noop, rebased, rebasedAll, pos, anchor, composed, composedAll,
  undone, undoneAll, ok, why, checked, changes, state, revision, anyMessage,
  clientMessage, serverMessage, ackRevision, looksRight, attached, stack, divergences,
  broken, randomOp, connect, Presence, track,
] as const;
