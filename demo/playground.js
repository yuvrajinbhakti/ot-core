/**
 * The playground.
 *
 * Imported straight from ../src — no bundler, no build step, because the
 * library is plain ESM with no dependencies and it is worth being able to see
 * that rather than being told it.
 *
 * Two modes, and the second one is the point. "With a server" runs the real
 * Client and Server over a wire you can make as bad as you like. "Peer to peer"
 * removes the server and keeps everything else, which is enough to make the
 * documents disagree — because convergence over a *pair* of operations (TP1) is
 * not convergence when different participants transform in different orders
 * (TP2), and this operation model does not have the second one.
 */

import { insert, remove, transform, apply, diff } from '../src/index.js';
import { Client } from '../src/client.js';
import { Server } from '../src/server.js';
import { attach, Room } from '../src/websocket.js';

const OPENING = 'the quick brown fox';
const IDS = ['Ana', 'Bo', 'Cy'];

/** What a rebuilt world starts from. The counterexample needs its own. */
let startText = OPENING;

const $ = (id) => document.getElementById(id);
const el = {
  clients: $('clients'), log: $('log'), status: $('status'),
  statusText: $('status-text'), statusDetail: $('status-detail'),
  serverPane: $('server-pane'), serverDoc: $('server-doc'), serverMeta: $('server-meta'),
  modeNote: $('mode-note'), logNote: $('log-note'),
};

const settings = { latency: 120, jitter: 60, flaky: 0, dupe: 0 };
let mode = 'server';
let world = null;

/* ---------------------------------------------------------------- logging */

let logCount = 0;
function log(text, kind = '') {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  el.log.append(line);
  if (++logCount > 220) { el.log.firstChild?.remove(); logCount--; }
  el.log.scrollTop = el.log.scrollHeight;
}

const describe = (op) =>
  op.type === 'insert'
    ? `insert(${op.position}, ${JSON.stringify(op.content)})`
    : `remove(${op.position}, ${op.length})`;

function summarise(raw) {
  const m = JSON.parse(raw);
  if (m.type === 'op' && m.author !== undefined) return `op    rev ${m.revision}  ${describe(m.op)}  by ${m.author}`;
  if (m.type === 'op') return `op    rev ${m.revision}  seq ${m.seq}  ${describe(m.op)}`;
  if (m.type === 'ack') return `ack   rev ${m.revision}  seq ${m.seq}`;
  if (m.type === 'init') return `init  rev ${m.revision}  ${JSON.stringify(m.document)}`;
  return `error ${m.code}: ${m.reason}`;
}

/* ------------------------------------------------------------------- wire */

/**
 * One direction of a socket, with the hazards a real one has.
 *
 * Delivery is FIFO per link even under jitter. A single socket does not reorder
 * — TCP will not hand you byte 900 before byte 100 — and a demo that pretends
 * otherwise would be showing a failure mode that does not exist while hiding
 * the ones that do.
 */
class Link {
  constructor(name) {
    this.name = name;
    this.partner = null;
    this.listeners = new Map();
    this.closed = false;
    this.lastDelivery = 0;
    this.timers = new Set();
  }

  static pair(label) {
    const a = new Link(`${label}→server`);
    const b = new Link(`server→${label}`);
    a.partner = b;
    b.partner = a;
    return [a, b];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data) {
    if (this.closed) return;
    const kind = this.name.startsWith('server') ? 'to-client' : 'to-server';

    // Not "drop this message" — a WebSocket does not do that. The connection
    // dies, which is a different problem with a different answer: the client
    // notices, reconnects, catches up through since(), and resends what was in
    // flight. Modelling a lost message instead would wedge the client forever
    // and would be showing a failure mode nobody has.
    if (Math.random() < settings.flaky / 100) {
      log(`  ✕ connection lost  ${this.name}`, 'drop');
      onSocketDeath?.(this);
      this.close();
      return;
    }

    const copies = Math.random() < settings.dupe / 100 ? 2 : 1;
    if (copies === 2) log(`  ⇉ duplicated ${this.name.padEnd(13)} ${summarise(data)}`, 'dupe');

    for (let i = 0; i < copies; i++) this.#schedule(data, kind);
  }

  #schedule(data, kind) {
    const now = performance.now();
    const wait = settings.latency + Math.random() * settings.jitter;
    // Never before the message in front of it.
    const at = Math.max(now + wait, this.lastDelivery + 1);
    this.lastDelivery = at;

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed || this.partner.closed) return;
      log(`  → ${this.name.padEnd(14)} ${summarise(data)}`, kind);
      this.partner.emit('message', { data });
      render();
    }, Math.max(0, at - now));
    this.timers.add(timer);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.emit('close', {});
    this.partner.close();
  }
}

/**
 * Set by the server world so a dying link can tell it whose it was. A module
 * global rather than a constructor argument because links are made in pairs and
 * either end can be the one that goes.
 */
let onSocketDeath = null;

/* ----------------------------------------------------------- server world */

function buildServerWorld() {
  const server = new Server({ document: startText });
  const room = new Room(server);
  const peers = IDS.map((id) => {
    const client = new Client({
      id,
      send: () => {},
      onError: (e) => log(`  ! ${id}: ${e.code} — ${e.reason}`, 'drop'),
    });
    const peer = { id, client, link: null, online: true, ready: false, manual: false };
    openSocket(room, peer);
    return peer;
  });

  const built = { kind: 'server', server, room, peers };

  onSocketDeath = (link) => {
    const peer = peers.find((p) => p.link === link || p.link?.partner === link);
    if (!peer || !peer.online || world !== built) return;
    peer.online = true;              // not a deliberate departure
    dropConnection(built, peer);
  };

  return built;
}

/** The socket died under us. Come back the way a real client would. */
function dropConnection(w, peer) {
  peer.client.disconnect();
  w.room.leave(peer.id);
  peer.online = false;
  render();
  setTimeout(() => {
    if (world !== w || peer.manual || peer.online) return;
    peer.online = true;
    openSocket(w.room, peer, { rejoin: true });
    peer.client.reconnect();
    log(`  ↻ ${peer.id} reconnected at revision ${peer.client.revision}`, 'good');
    render();
  }, 700 + Math.random() * 500);
}

function openSocket(room, peer, { rejoin = false } = {}) {
  const [clientSide, serverSide] = Link.pair(peer.id);
  peer.link = clientSide;
  // Rejoining clients are already holding the document; only a fresh join waits
  // for `init`.
  peer.ready = rejoin;
  attach(peer.client, clientSide, {
    onChange: render,
    onReady: () => { peer.ready = true; render(); },
  });
  room.join(peer.id, serverSide, rejoin ? { revision: peer.client.revision } : undefined);
}

/** Nobody may type until the document has actually arrived. */
const allReady = () => world.kind === 'p2p' || world.peers.every((p) => p.ready);

function whenReady(then) {
  if (allReady()) { then(); return; }
  setTimeout(() => whenReady(then), 40);
}

/* -------------------------------------------------------------- p2p world */

/**
 * The same three people with the server taken away.
 *
 * Each peer folds an arriving operation through everything it has already
 * applied, in its own arrival order, with a stable tie-break both sides
 * compute identically. That is the obvious thing to do and it is not enough:
 * it needs TP2, and transform does not have it.
 */
class Peer {
  constructor(id) {
    this.id = id;
    this.document = startText;
    this.applied = [];
  }
  local(op) {
    this.document = apply(this.document, op);
    this.applied.push({ id: this.id, op });
  }
  remote(fromId, op) {
    let incoming = op;
    for (const prev of this.applied) {
      incoming = transform(incoming, prev.op, fromId < prev.id ? 'left' : 'right');
    }
    this.applied.push({ id: fromId, op: incoming });
    this.document = apply(this.document, incoming);
  }
}

function buildPeerWorld() {
  return {
    kind: 'p2p',
    peers: IDS.map((id) => ({ id, peer: new Peer(id), online: true })),
  };
}

function broadcastPeer(from, op) {
  for (const other of world.peers) {
    if (other.id === from.id || !other.online) continue;
    const wait = settings.latency + Math.random() * settings.jitter;
    setTimeout(() => {
      if (world?.kind !== 'p2p') return;
      other.peer.remote(from.id, op);
      log(`  → ${from.id}→${other.id}`.padEnd(18) + describe(op), 'to-client');
      render();
    }, wait);
  }
}

/* ------------------------------------------------------------------ edits */

const docOf = (p) => (world.kind === 'server' ? p.client.document : p.peer.document);

/** Code-point offsets in, UTF-16 offsets out — the library counts the former. */
const toUtf16 = (text, codePoint) => Array.from(text).slice(0, codePoint).join('').length;
const toCodePoints = (text, utf16) => Array.from(text.slice(0, utf16)).length;

function applyLocal(p, op) {
  if (world.kind === 'server') {
    p.client.edit(op);
  } else {
    p.peer.local(op);
    broadcastPeer(p, op);
  }
  render();
}

/* ------------------------------------------------------------------- view */

function renderClients() {
  el.clients.replaceChildren(...world.peers.map((p) => {
    const node = document.createElement('div');
    node.className = 'client';
    node.dataset.id = p.id;
    node.innerHTML = `
      <div class="pane-head">
        <span class="name"></span>
        <span class="badge"></span>
        <span class="meta"></span>
      </div>
      <textarea spellcheck="false" aria-label=""></textarea>
      <div class="client-foot">
        <span class="pending"></span>
        <button class="act toggle"></button>
      </div>`;
    node.querySelector('.name').textContent = p.id;
    const area = node.querySelector('textarea');
    area.setAttribute('aria-label', `${p.id}'s copy of the document`);
    area.value = docOf(p);

    area.addEventListener('input', () => {
      const caret = toCodePoints(area.value, area.selectionStart);
      if (world.kind === 'server') {
        p.client.selection = { anchor: caret, head: caret };
        p.client.editText(area.value);
      } else {
        // Same diff the client would do, applied by hand so the peer stays a
        // deliberately minimal thing.
        const before = p.peer.document;
        const ops = diff(before, area.value);
        for (const op of ops) { p.peer.local(op); broadcastPeer(p, op); }
      }
      render();
    });

    node.querySelector('.toggle').addEventListener('click', () => toggleOnline(p));
    return node;
  }));
}

function render() {
  const docs = world.peers.map(docOf);

  if (world.kind === 'server') {
    el.serverPane.hidden = false;
    el.serverDoc.textContent = world.server.document;
    el.serverMeta.textContent =
      `revision ${world.server.revision} · history ${world.server.history.length}`;
  } else {
    el.serverPane.hidden = true;
  }

  for (const p of world.peers) {
    const node = el.clients.querySelector(`[data-id="${p.id}"]`);
    if (!node) continue;
    const area = node.querySelector('textarea');
    const doc = docOf(p);

    if (area.value !== doc && document.activeElement !== area) {
      area.value = doc;
    } else if (area.value !== doc) {
      // Focused: keep the caret where the text is, not where the offset was.
      const caret = world.kind === 'server' && p.client.selection
        ? toUtf16(doc, p.client.selection.head)
        : Math.min(area.selectionStart, doc.length);
      area.value = doc;
      area.setSelectionRange(caret, caret);
    }

    const state = !p.online ? 'offline'
      : world.kind === 'server' ? p.client.state
      : 'synchronized';
    const badge = node.querySelector('.badge');
    badge.textContent = state;
    badge.dataset.state = state;

    node.dataset.offline = String(!p.online);
    node.dataset.diverged = String(world.kind === 'server'
      ? doc !== world.server.document
      : docs.some((d) => d !== doc));

    node.querySelector('.meta').textContent =
      world.kind === 'server' ? `rev ${p.client.revision}` : `${p.peer.applied.length} applied`;
    node.querySelector('.pending').textContent =
      world.kind === 'server'
        ? `${p.client.unconfirmed.length} unconfirmed`
        : `${Array.from(doc).length} code points`;
    node.querySelector('.toggle').textContent = p.online ? 'Go offline' : 'Reconnect';
    // An edit made before `init` lands is written against a document this
    // client does not have yet, and `init` will discard it when it arrives.
    area.disabled = world.kind === 'server' && !p.ready;
  }

  renderStatus(docs);
}

function renderStatus(docs) {
  const agreed = docs.every((d) => d === docs[0]);
  const settled = world.kind === 'server'
    ? agreed && docs[0] === world.server.document &&
      world.peers.every((p) => !p.online || p.client.state === 'synchronized')
    : agreed;

  if (settled) {
    el.status.dataset.state = 'converged';
    el.statusText.textContent = 'Everyone agrees.';
    el.statusDetail.textContent = world.kind === 'server'
      ? `${docs.length} clients, one document, revision ${world.server.revision}.`
      : `${docs.length} peers, one document — this time.`;
    return;
  }

  const distinct = new Set(docs).size;
  const anyInFlight = world.kind === 'server' &&
    world.peers.some((p) => p.online && p.client.state !== 'synchronized');

  if (anyInFlight || (world.kind === 'server' && !agreed)) {
    el.status.dataset.state = 'settling';
    el.statusText.textContent = 'Settling…';
    el.statusDetail.textContent = 'Operations are still on the wire.';
    return;
  }

  el.status.dataset.state = 'diverged';
  el.statusText.textContent = `Diverged — ${distinct} different documents.`;
  el.statusDetail.textContent = world.kind === 'p2p'
    ? 'Nothing is on the wire. This is what a missing total order costs.'
    : 'This should not happen with a server. Please open an issue.';
}

/* ---------------------------------------------------------------- actions */

function toggleOnline(p) {
  if (world.kind === 'p2p') {
    p.online = !p.online;
    log(`  ${p.id} is now ${p.online ? 'online' : 'offline'}`, 'note');
    render();
    return;
  }

  if (p.online) {
    p.online = false;
    p.manual = true;
    p.client.disconnect();
    p.link.close();
    world.room.leave(p.id);
    log(`  ${p.id} went offline — edits will queue locally`, 'note');
  } else {
    p.online = true;
    p.manual = false;
    openSocket(world.room, p, { rejoin: true });
    p.client.reconnect();
    log(`  ${p.id} reconnected at revision ${p.client.revision}`, 'good');
  }
  render();
}

/**
 * The three edits from the README, fired at the same instant.
 *
 * With a server they converge. Without one they do not, and it is the same
 * three edits either way — which is the entire argument for the server, made
 * in one click rather than a paragraph.
 */
function counterexample() {
  reset('ab');
  whenReady(() => {
    log('', 'note');
    log('  three concurrent edits on "ab":', 'note');
    const ops = [insert(1, 'X'), insert(0, 'XY'), remove(0, 1)];
    world.peers.forEach((p, i) => {
      log(`    ${p.id.padEnd(4)} ${describe(ops[i])}`, 'note');
      applyLocal(p, ops[i]);
    });
  });
}

/** Everybody types into the same sentence at once. */
function storm() {
  if (!allReady()) return;
  const words = ['very ', 'quite ', 'rather '];
  world.peers.forEach((p, i) => {
    if (!p.online) return;
    const doc = docOf(p);
    const at = Math.min(4 + i, Array.from(doc).length);
    applyLocal(p, insert(at, words[i % words.length]));
  });
}

function reset(text = OPENING) {
  if (world) for (const p of world.peers) p.link?.close();
  startText = text;
  world = mode === 'server' ? buildServerWorld() : buildPeerWorld();
  el.log.replaceChildren();
  logCount = 0;
  renderClients();
  render();
}

/* ------------------------------------------------------------------- wire-up */

for (const key of ['latency', 'jitter', 'flaky', 'dupe']) {
  const input = $(key);
  const label = $(`${key}-v`);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    label.textContent = input.value;
  });
  settings[key] = Number(input.value);
}

const MODE_NOTE = {
  server: 'The server decides one order and everybody follows it. Break the network as hard as you like — it converges.',
  p2p: 'No arbiter. Each peer transforms arriving edits against its own history in its own order, which is the obvious design and is not enough.',
};

function setMode(next) {
  mode = next;
  $('mode-server').setAttribute('aria-pressed', String(next === 'server'));
  $('mode-p2p').setAttribute('aria-pressed', String(next === 'p2p'));
  el.modeNote.textContent = MODE_NOTE[next];
  el.logNote.textContent = next === 'server'
    ? 'every message, as it is sent'
    : 'peer to peer — every edit goes straight to everybody';
  reset();
}

$('mode-server').addEventListener('click', () => setMode('server'));
$('mode-p2p').addEventListener('click', () => setMode('p2p'));
$('collide').addEventListener('click', counterexample);
$('storm').addEventListener('click', storm);
$('reset').addEventListener('click', () => reset());

setMode('server');
