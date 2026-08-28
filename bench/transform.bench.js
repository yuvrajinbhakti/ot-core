/**
 * How fast is the transform, and does it stay flat as history grows?
 *
 * The second question is the one that matters. A single transform is trivially
 * fast; what decides whether a server keeps up is rebasing one late operation
 * against everything that landed while it was in flight, and that is linear in
 * the length of the history. This measures both so the number in the README is
 * something measured rather than remembered.
 */

import { insert, remove, transform, transformAgainst } from '../src/index.js';

const makeRandom = (seed) => {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
};

const randomOperation = (random, size) => {
  if (size === 0 || random() < 0.5) return insert(Math.floor(random() * (size + 1)), 'X');
  const position = Math.floor(random() * size);
  return remove(position, 1 + Math.floor(random() * Math.min(3, size - position)));
};

const time = (label, iterations, run) => {
  run(); // let the JIT settle before the numbers are taken
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) run();
  const ns = Number(process.hrtime.bigint() - started);
  const perOp = ns / iterations;
  const rate = 1e9 / perOp;
  console.log(
    `  ${label.padEnd(38)} ${(perOp / 1000).toFixed(3).padStart(8)} µs   ` +
      `${Math.round(rate).toLocaleString().padStart(12)} ops/sec`
  );
};

const random = makeRandom(2024);

console.log('\nOT transform throughput (Node ' + process.version + ')\n');

const a = insert(40, 'hello');
const b = remove(10, 5);
time('transform(a, b)', 2_000_000, () => transform(a, b, 'left'));

console.log('');
for (const depth of [1, 10, 100, 1000]) {
  const history = Array.from({ length: depth }, () => randomOperation(random, 200));
  const late = insert(100, 'Q');
  const iterations = depth >= 1000 ? 2_000 : depth >= 100 ? 20_000 : 200_000;
  time(`rebase against ${String(depth).padStart(4)} operations`, iterations, () =>
    transformAgainst(late, history, 'left')
  );
}

console.log('\nRebasing is linear in history depth, which is why a server should');
console.log('acknowledge and compact rather than let a room accumulate history.\n');
