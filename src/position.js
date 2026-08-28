/**
 * Moving a cursor when somebody else edits.
 *
 * Transforming the document is only half of collaborative editing. The other
 * half is that your caret, your selection and every highlight anchored to the
 * text have to move with it — otherwise a remote insert three lines above you
 * silently slides your cursor into the middle of a word.
 *
 * This is a separate function from `transform` because a position is not an
 * operation. It has no length and it cannot be cancelled; it just needs to
 * still point at the same character afterwards.
 */

/**
 * Where does `position` end up once `op` has been applied?
 *
 * @param {number} position  a code-point offset into the document before `op`
 * @param {import('./operation.js').Operation} op
 * @param {'left'|'right'} [bias='left']
 *   What happens when an insert lands exactly on the position. 'left' keeps the
 *   cursor where it is, so the incoming text appears after it; 'right' pushes
 *   the cursor along, so the text appears before it.
 *
 *   'left' is the default because the common case is a *remote* insert at your
 *   caret, and the caret should hold its ground rather than being dragged by
 *   someone else's typing. Use 'right' for the local echo of your own insert,
 *   where the caret is supposed to follow what you typed.
 * @returns {number}
 */
export function transformPosition(position, op, bias = 'left') {
  if (!Number.isInteger(position) || position < 0) {
    throw new RangeError(`transformPosition() position must be a non-negative integer, got ${position}`);
  }

  if (op.type === 'insert') {
    if (op.position < position) return position + op.length;
    if (op.position > position) return position;
    return bias === 'right' ? position + op.length : position;
  }

  const start = op.position;
  const end = op.position + op.length;

  if (position <= start) return position;
  if (position >= end) return position - op.length;
  // The character this pointed at was deleted. There is nowhere sensible left
  // except the point where the text used to be.
  return start;
}

/**
 * Move both ends of a selection.
 *
 * The ends take opposite biases so a selection does not swallow text that
 * someone else inserts at its edges — an insert at the anchor lands outside the
 * selection, and so does one at the head. A collapsed selection stays collapsed.
 *
 * @param {{ anchor: number, head: number }} selection
 * @param {import('./operation.js').Operation} op
 * @returns {{ anchor: number, head: number }}
 */
export function transformSelection(selection, op) {
  const { anchor, head } = selection;
  if (anchor === head) {
    const moved = transformPosition(anchor, op, 'left');
    return { anchor: moved, head: moved };
  }
  // Each end leans *outward*, so an insert landing exactly on a boundary falls
  // outside the selection rather than being absorbed by it. The start yields to
  // text arriving before it; the end holds its ground against text arriving
  // after it. Leaning the other way — which is the intuitive-looking choice —
  // makes a selection quietly grow to cover whatever a collaborator types at
  // either edge of it.
  const forward = anchor <= head;
  return {
    anchor: transformPosition(anchor, op, forward ? 'right' : 'left'),
    head: transformPosition(head, op, forward ? 'left' : 'right'),
  };
}
