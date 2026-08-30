/**
 * Undo, in a document somebody else is also typing in.
 *
 * Single-player undo is a stack of inverses. Collaborative undo is the same
 * stack with one hard requirement bolted on, and getting that requirement wrong
 * is how undo becomes the feature that corrupts documents.
 *
 * ## The property
 *
 * Undo removes **what survives of your contribution**, and nothing else. It does
 * not restore the document to how it looked when you made the edit, because that
 * document no longer exists — other people have typed since, and rolling back to
 * a remembered snapshot would silently discard their work.
 *
 * That distinction sounds pedantic until you write the test. I got it wrong the
 * first time in this repository: I asserted that undoing an operation should
 * reproduce the document you would have had if you had never made it, which is a
 * different and much stronger claim, and I nearly "fixed" correct code to
 * satisfy it. The two agree exactly when nobody else has typed, which is every
 * example you would write by hand, and diverge the moment anyone has.
 *
 * ## The mechanism
 *
 * Store `invert(op, documentBefore)`. Then, as remote operations arrive, rebase
 * every stored inverse past them — the same `transform` the client uses, for the
 * same reason. An inverse that has been rebased past everything that happened
 * since is by construction an operation that removes exactly the surviving part
 * of the original edit, and it applies cleanly to the current document.
 *
 * An edit entirely deleted by somebody else leaves an inverse of length zero.
 * That entry is dropped rather than kept, because an undo that visibly does
 * nothing reads as a broken button; skipping to the next real entry is what
 * every editor does.
 *
 * ## Redo
 *
 * Redo is the same trick pointed the other way, and the redo stack has to be
 * rebased by incoming operations too. It is discarded on a fresh local edit,
 * which is the universal convention and also the only cheap way to stay correct:
 * once you have branched, the redo entries describe a future that no longer
 * follows from the present.
 *
 * ## A limitation worth stating plainly
 *
 * If somebody types *inside* a run of text you inserted, undoing your insert
 * removes their characters too.
 *
 * This is not a bug in this file; it is the library's central trade-off arriving
 * somewhere visible. `transform` resolves an insert landing inside a concurrently
 * deleted range by dropping the insert and letting the delete swallow it — the
 * README explains why, and it is what keeps this model free of the TP2 property
 * it does not have. Your undo is a delete, their text is inside it, so the same
 * rule applies and takes their character with yours.
 *
 * Most editors split the delete around foreign text instead, which needs undo to
 * yield several operations rather than one and needs the stack to track which
 * code points are actually yours. That is a real improvement and a larger change
 * than this module; until it exists, this is documented behaviour rather than a
 * surprise, and `test/undo.test.js` asserts it so it cannot change silently.
 */

import { transform } from './transform.js';
import { invert } from './invert.js';
import { isNoop } from './operation.js';

/** @typedef {import('./operation.js').Operation} Operation */

export class UndoStack {
  /**
   * @param {object} [options]
   * @param {number} [options.limit=200]
   *   How many undo entries to keep. Every remote operation rebases the whole
   *   stack, so this bounds per-keystroke work as well as memory.
   */
  constructor({ limit = 200 } = {}) {
    this.limit = limit;
    /** @type {Operation[]} inverses, oldest first; the tail is undone next */
    this.undoable = [];
    /** @type {Operation[]} */
    this.redoable = [];
    /**
     * Set while `undo`/`redo` feed an operation back to the application, so the
     * resulting local edit is recognised as this stack's own work rather than
     * recorded as a fresh one — which would push an inverse of the inverse and
     * make undo a toggle between two states forever.
     */
    this.applying = false;
  }

  get canUndo() {
    return this.undoable.length > 0;
  }

  get canRedo() {
    return this.redoable.length > 0;
  }

  /**
   * Record a local edit.
   *
   * @param {Operation} op
   * @param {string} before  the document as it was immediately before `op`
   */
  record(op, before) {
    if (this.applying) return;
    if (isNoop(op)) return;

    this.undoable.push(invert(op, before));
    if (this.undoable.length > this.limit) this.undoable.shift();
    // Branched. See the note above about why redo cannot survive this.
    this.redoable = [];
  }

  /**
   * Rebase both stacks past an operation somebody else made.
   *
   * @param {Operation} remote  in the coordinates of the current document
   */
  rebase(remote) {
    this.undoable = rebaseAll(this.undoable, remote);
    this.redoable = rebaseAll(this.redoable, remote);
  }

  /**
   * The operation that undoes the most recent surviving local edit, or null.
   *
   * Applying it is the caller's job — hand it to `client.edit` — because this
   * module does not own the document. What it does own is the bookkeeping: the
   * entry moves to the redo stack as its own inverse, so the caller must apply
   * the returned operation for the stacks to stay true.
   *
   * @param {string} document  the current document, needed to invert for redo
   * @returns {Operation | null}
   */
  undo(document) {
    return this.#pop(this.undoable, this.redoable, document);
  }

  /**
   * @param {string} document
   * @returns {Operation | null}
   */
  redo(document) {
    return this.#pop(this.redoable, this.undoable, document);
  }

  /**
   * Take from one stack, push its inverse onto the other.
   *
   * Entries flattened to nothing by other people's edits are dropped on the way
   * past rather than returned, so the button does something or reports that
   * there is nothing left to do.
   */
  #pop(from, to, document) {
    while (from.length > 0) {
      const op = from.pop();
      if (isNoop(op)) continue;
      to.push(invert(op, document));
      return op;
    }
    return null;
  }

  clear() {
    this.undoable = [];
    this.redoable = [];
  }
}

/**
 * `transform` returns the pair; the stack keeps the left side — its own
 * operation rebased past the remote one. The remote operation is rebased in turn
 * as it moves down the stack, because each stored inverse sits in the
 * coordinates left by the one before it. Using the original remote operation for
 * every entry is the plausible-looking version of this loop, and it is wrong for
 * every entry after the first.
 */
function rebaseAll(stack, remote) {
  let against = remote;
  const rebased = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    // Sides match the client's convention: mine yields at a tie, theirs holds.
    // `transform` returns one operation, so the pair takes two calls — the
    // second is what carries the remote operation down into the coordinates of
    // the next entry.
    const mine = transform(stack[i], against, 'right');
    against = transform(against, stack[i], 'left');
    rebased.unshift(mine);
  }
  return rebased;
}

/**
 * Wire an `UndoStack` to a `Client` so it records and rebases itself.
 *
 * Returns `undo` and `redo` that apply through the client, plus `detach`. This
 * is the whole integration for an editor that wants a working undo button:
 *
 * ```js
 * const history = attachHistory(client);
 * button.onclick = () => history.undo();
 * ```
 *
 * @param {import('./client.js').Client} client
 * @param {object} [options]
 * @param {number} [options.limit]
 */
export function attachHistory(client, { limit } = {}) {
  const stack = new UndoStack({ limit });
  const previousLocal = client.onLocal;
  const previousRemote = client.onRemote;

  client.onLocal = (op, before) => {
    // The pre-image comes from the client rather than being reconstructed,
    // because a delete does not carry the text it removed and so the post-image
    // simply does not contain the information. An earlier draft of this tried
    // to rebuild it and produced inverses of the right shape carrying an empty
    // string — a corruption that passes every type check and only shows up when
    // somebody presses the button.
    stack.record(op, before);
    previousLocal?.(op, before);
  };

  client.onRemote = (op) => {
    stack.rebase(op);
    previousRemote?.(op);
  };

  return {
    stack,
    get canUndo() {
      return stack.canUndo;
    },
    get canRedo() {
      return stack.canRedo;
    },
    undo() {
      const op = stack.undo(client.document);
      if (op) {
        stack.applying = true;
        try {
          client.edit(op);
        } finally {
          stack.applying = false;
        }
      }
      return op;
    },
    redo() {
      const op = stack.redo(client.document);
      if (op) {
        stack.applying = true;
        try {
          client.edit(op);
        } finally {
          stack.applying = false;
        }
      }
      return op;
    },
    detach() {
      client.onLocal = previousLocal;
      client.onRemote = previousRemote;
    },
  };
}
