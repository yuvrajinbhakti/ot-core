/**
 * The transform function, which is the whole of Operational Transform.
 *
 * Two people edit the same document at the same moment. Each sends their edit
 * to the other. Applied naively, the second edit lands at a position that no
 * longer means what it meant when it was written, and the two documents drift
 * apart. `transform(a, b)` rewrites `a` so it still means the same thing after
 * `b` has been applied.
 *
 * The property this has to satisfy is called TP1, and it is the only thing that
 * matters:
 *
 *     apply(apply(doc, a), transform(b, a, 'right'))
 *       === apply(apply(doc, b), transform(a, b, 'left'))
 *
 * Both people, having seen both edits in opposite orders, end up with the same
 * text. test/convergence.test.js asserts this over a few hundred thousand
 * random edit pairs, which is the only honest way to make the claim.
 */

/** @typedef {{ type: 'insert'|'delete', position: number, content: string, length: number }} Operation */

// A delete of nothing. Used where an operation is cancelled by the one it was
// transformed against — see the insert-inside-delete case below.
const NOOP = Object.freeze({ type: 'delete', position: 0, content: '', length: 0 });

/**
 * Rewrite `a` so it can be applied after `b`.
 *
 * @param {Operation} a  the operation to rewrite
 * @param {Operation} b  the operation that has already been applied
 * @param {'left'|'right'} side
 *   Which of the two yields when they collide at the same index. The two
 *   participants must pass opposite values — derive it from something both
 *   agree on and that is stable, such as comparing site ids. Getting this
 *   wrong is silent: everything works until two people type in the same place.
 * @returns {Operation}
 */
export function transform(a, b, side) {
  if (side !== 'left' && side !== 'right') {
    throw new TypeError(`transform() needs side 'left' or 'right', got ${JSON.stringify(side)}`);
  }

  if (a.type === 'insert' && b.type === 'insert') {
    if (a.position < b.position) return a;
    if (a.position > b.position) return { ...a, position: a.position + b.length };
    // Same index. Exactly one side has to move, or both keep their position,
    // both insert at the same offset, and the result depends on which message
    // arrived first — which is the definition of divergence.
    return side === 'left' ? a : { ...a, position: a.position + b.length };
  }

  if (a.type === 'insert' && b.type === 'delete') {
    const start = b.position;
    const end = b.position + b.length;
    if (a.position <= start) return a;
    if (a.position >= end) return { ...a, position: a.position - b.length };
    // The insert landed inside text that was deleted concurrently. There is no
    // position left for it to occupy, and the model below cannot split `b`
    // around it, so the insert is dropped — and the delete-vs-insert branch
    // must swallow it to match. See the trade-off note in the README.
    return NOOP;
  }

  if (a.type === 'delete' && b.type === 'insert') {
    const start = a.position;
    const end = a.position + a.length;
    if (b.position <= start) return { ...a, position: a.position + b.length };
    if (b.position >= end) return a;
    // Mirror of the case above: the inserted text sits inside this delete's
    // range, so the delete grows to cover it.
    return { ...a, length: a.length + b.length };
  }

  // delete vs delete. Whatever `b` already removed, `a` must not remove twice —
  // and `a`'s start shifts left by however much of `b` fell before it.
  //
  // The surviving part of `a` is [s1,e1) minus [s2,e2). When `b` sits strictly
  // inside `a` that leaves two fragments, but once `b`'s characters are gone
  // they are adjacent, so a single delete still expresses it.
  const s1 = a.position;
  const e1 = a.position + a.length;
  const s2 = b.position;
  const e2 = b.position + b.length;

  const overlap = Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  const removedBefore = Math.max(0, Math.min(s1, e2) - s2);

  return { ...a, position: s1 - removedBefore, length: a.length - overlap };
}

/**
 * Rewrite `a` against a run of operations that were applied before it, oldest
 * first. This is the shape a server needs when a client's edit arrives behind
 * the current version.
 *
 * @param {Operation} a
 * @param {Operation[]} others  applied in order, oldest first
 * @param {'left'|'right'} side
 * @returns {Operation}
 */
export function transformAgainst(a, others, side) {
  let out = a;
  for (const b of others) out = transform(out, b, side);
  return out;
}

export { NOOP };
