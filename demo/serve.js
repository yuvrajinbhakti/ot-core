/**
 * A static file server, so `npm run demo` needs nothing installed.
 *
 * Thirty lines rather than a dependency, because a library that advertises zero
 * dependencies should not need one to show itself off — and because the whole
 * point of the demo is that the browser imports ../src directly, which any
 * server that sets the right content type can do.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.argv[2] ?? 4180);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';

  // normalize collapses "..", and the prefix check is what stops a request for
  // /../../etc/passwd from being one.
  const file = join(root, normalize(path));
  if (!file.startsWith(root)) {
    response.writeHead(403).end('no');
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(port, () => {
  console.log(`\n  ot-core playground → http://localhost:${port}/demo/\n`);
});
