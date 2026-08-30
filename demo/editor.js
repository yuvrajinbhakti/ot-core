/**
 * Two CodeMirror editors on one document.
 *
 * Everything here except the editors themselves is the library: a `Server`, a
 * `Room`, two `Client`s, and `collaborate()` from ot-core/codemirror wiring each
 * client to a view. The sockets are two arrays with a delay, because the point
 * is the binding rather than the transport — the transport has its own tests
 * over a real WebSocket.
 */

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

import { Server } from '../src/server.js';
import { Client } from '../src/client.js';
import { attach, Room } from '../src/websocket.js';
import { collaborate } from '../src/codemirror.js';

const OPENING = 'the quick brown fox\njumps over the lazy dog';
const PEOPLE = [
  { id: 'Ana', colour: '#60a5fa' },
  { id: 'Bo', colour: '#34d399' },
];

const $ = (id) => document.getElementById(id);
let latency = 400;
let world = null;

/* ------------------------------------------------------------------ wire */

class Link {
  constructor(name) {
    this.name = name;
    this.partner = null;
    this.listeners = new Map();
    this.closed = false;
    this.last = 0;
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
    const now = performance.now();
    // FIFO per link, so a slider that adds jitter cannot reorder a socket.
    const at = Math.max(now + latency, this.last + 1);
    this.last = at;
    setTimeout(() => {
      if (this.closed || this.partner.closed) return;
      this.partner.emit('message', { data });
      render();
    }, Math.max(0, at - now));
  }
  close() {
    this.closed = true;
    this.emit('close', {});
  }
}

/* ------------------------------------------------------------------- log */

function log(text, colour) {
  const line = document.createElement('div');
  line.textContent = text;
  if (colour) line.style.color = colour;
  $('log').append(line);
  while ($('log').childElementCount > 200) $('log').firstChild.remove();
  $('log').scrollTop = $('log').scrollHeight;
}

const describe = (op) =>
  op.type === 'insert'
    ? `insert(${op.position}, ${JSON.stringify(op.content)})`
    : `remove(${op.position}, ${op.length})`;

/* ----------------------------------------------------------------- build */

function build() {
  if (world) {
    for (const m of world.members) { m.link.close(); m.view.destroy(); }
  }
  $('log').replaceChildren();
  $('editors').replaceChildren();

  const server = new Server({ document: OPENING });
  const room = new Room(server);

  const members = PEOPLE.map(({ id, colour }) => {
    const pane = document.createElement('div');
    pane.className = 'editor-pane';
    pane.style.setProperty('--who', colour);
    pane.innerHTML = `
      <div class="pane-head">
        <span class="name" style="color:${colour}">${id}</span>
        <span class="badge"></span>
        <span class="meta"></span>
      </div>
      <div class="host"></div>`;
    $('editors').append(pane);

    const client = new Client({
      id,
      document: OPENING,
      send: () => {},
      onError: (e) => log(`  ! ${id}: ${e.code} — ${e.reason}`, 'var(--bad)'),
    });

    // Log what the binding produces, without changing what it does.
    const edit = client.edit.bind(client);
    client.edit = (op) => {
      log(`  ${id} → ${describe(op)}`, colour);
      return edit(op);
    };

    const view = new EditorView({
      state: EditorState.create({
        doc: OPENING,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          collaborate(client),
          EditorView.updateListener.of(() => render()),
        ],
      }),
      parent: pane.querySelector('.host'),
    });

    const [clientSide, serverSide] = Link.pair(id);
    attach(client, clientSide, { onChange: render });
    room.join(id, serverSide);

    return { id, colour, client, view, pane, link: clientSide };
  });

  world = { server, room, members };
  render();
}

/* ---------------------------------------------------------------- render */

function render() {
  if (!world) return;
  const { server, members } = world;

  $('server-doc').textContent = server.document;
  $('server-meta').textContent = `revision ${server.revision}`;

  for (const m of members) {
    m.pane.querySelector('.badge').textContent = m.client.state;
    m.pane.querySelector('.badge').dataset.state = m.client.state;
    m.pane.querySelector('.meta').textContent =
      `rev ${m.client.revision} · ${m.client.unconfirmed.length} unconfirmed`;
  }

  // The check that matters: the editor's own text, not the client's copy of it.
  const editorTexts = members.map((m) => m.view.state.doc.toString());
  const agreed = editorTexts.every((t) => t === editorTexts[0]);
  const settled = agreed && editorTexts[0] === server.document &&
    members.every((m) => m.client.state === 'synchronized');

  const status = $('status');
  if (settled) {
    status.dataset.state = 'converged';
    $('status-text').textContent = 'Both editors agree.';
    $('status-detail').textContent = `and match the server, at revision ${server.revision}.`;
  } else if (members.some((m) => m.client.state !== 'synchronized')) {
    status.dataset.state = 'settling';
    $('status-text').textContent = 'Settling…';
    $('status-detail').textContent = 'Operations are on the wire.';
  } else {
    status.dataset.state = 'diverged';
    $('status-text').textContent = 'Diverged.';
    $('status-detail').textContent = 'Nothing in flight, and the editors disagree.';
  }
}

/* --------------------------------------------------------------- actions */

/** Type into an editor the way a person would: a real transaction. */
function typeInto(member, text, at) {
  const doc = member.view.state.doc;
  const from = Math.max(0, Math.min(at ?? doc.length, doc.length));
  member.view.dispatch({ changes: { from, insert: text } });
}

$('latency').addEventListener('input', (e) => {
  latency = Number(e.target.value);
  $('latency-v').textContent = e.target.value;
});

$('collide').addEventListener('click', () => {
  // Both into the same word, before either can hear about the other.
  typeInto(world.members[0], 'very ', 4);
  typeInto(world.members[1], 'rather ', 4);
});

$('emoji').addEventListener('click', () => {
  // The units case. One inserts an astral character, the other edits just past
  // where it lands, so the two coordinate systems have to agree.
  typeInto(world.members[0], '🚀', 3);
  typeInto(world.members[1], '!', 9);
});

$('reset').addEventListener('click', build);

build();
