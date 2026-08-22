'use strict';

// Documents: the text model extensions read, main's mirror of the user's
// buffers, and the renderer service that keeps the two in step.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  Position,
  Range,
  Selection,
} = require('../../dist-electron/extension-host/vscode-api/primitives.js');
const {
  TextDocument,
} = require('../../dist-electron/extension-host/vscode-api/text-document.js');
const {
  DocumentRegistry,
} = require('../../dist-electron/extension-host/document-registry.js');
const {
  DocumentMirror,
  parseDocumentSyncEvent,
} = require('../../dist-electron/extensions/application/document-mirror.js');
const { DocumentSyncService } = require('../../src/extensions/documentSync.ts');

// ── Position / Range ────────────────────────────────────────────────────

test('positions compare, translate and clamp negatives instead of carrying them', () => {
  const a = new Position(1, 4);
  const b = new Position(2, 0);

  assert.equal(a.isBefore(b), true);
  assert.equal(b.isAfter(a), true);
  assert.equal(a.isEqual(new Position(1, 4)), true);
  assert.equal(a.compareTo(b), -1);
  assert.deepEqual(
    { line: a.translate(1, -2).line, character: a.translate(1, -2).character },
    { line: 2, character: 2 },
  );
  assert.equal(new Position(-3, -1).line, 0, 'a negative coordinate is a caller bug, not a state');
});

test('a range normalises its ends, so a backwards selection still works', () => {
  const forward = new Range(1, 0, 3, 5);
  const backward = new Range(new Position(3, 5), new Position(1, 0));

  assert.equal(backward.isEqual(forward), true);
  assert.equal(forward.isSingleLine, false);
  assert.equal(new Range(2, 1, 2, 1).isEmpty, true);
  assert.equal(forward.contains(new Position(2, 0)), true);
  assert.equal(forward.contains(new Position(4, 0)), false);
  assert.equal(forward.intersection(new Range(2, 0, 9, 0)).isEqual(new Range(2, 0, 3, 5)), true);
  assert.equal(forward.intersection(new Range(8, 0, 9, 0)), undefined);
  assert.equal(forward.union(new Range(0, 0, 1, 1)).isEqual(new Range(0, 0, 3, 5)), true);
});

test('a selection keeps which end the caret is on, even though the range does not', () => {
  const reversed = new Selection(new Position(3, 0), new Position(1, 0));

  assert.equal(reversed.isReversed, true);
  assert.equal(reversed.start.line, 1, 'the range is still normalised');
  assert.equal(reversed.active.line, 1);
  assert.equal(reversed.anchor.line, 3);
});

// ── TextDocument ────────────────────────────────────────────────────────

const doc = (content, overrides = {}) => new TextDocument({
  uri: '/w/a.ts',
  languageId: 'typescript',
  version: 1,
  content,
  isDirty: false,
  ...overrides,
});

test('a document exposes its identity and text', () => {
  const document = doc('const a = 1;\nconst b = 2;\n');

  assert.equal(document.fileName, '/w/a.ts');
  assert.equal(document.uri.fsPath, '/w/a.ts');
  assert.equal(document.languageId, 'typescript');
  assert.equal(document.version, 1);
  assert.equal(document.lineCount, 3, 'the trailing newline opens a last, empty line');
  assert.equal(document.getText(new Range(0, 6, 0, 7)), 'a');
});

test('an empty document still has one line', () => {
  assert.equal(doc('').lineCount, 1);
  assert.equal(doc('').lineAt(0).text, '');
});

test('lineAt reports the text, its ranges and its indentation', () => {
  const line = doc('const a = 1;\n    indented\n').lineAt(1);

  assert.equal(line.lineNumber, 1);
  assert.equal(line.text, '    indented', 'the line break is not part of the text');
  assert.equal(line.rangeIncludingLineBreak.end.character, 13);
  assert.equal(line.firstNonWhitespaceCharacterIndex, 4);
  assert.equal(line.isEmptyOrWhitespace, false);
  assert.equal(doc('\n   \n').lineAt(1).isEmptyOrWhitespace, true);
});

test('offsets and positions round-trip, and clamp instead of spilling', () => {
  const document = doc('abc\ndefgh\nij');

  assert.equal(document.offsetAt(new Position(1, 2)), 6);
  assert.equal(document.positionAt(6).line, 1);
  assert.equal(document.positionAt(6).character, 2);

  // A character past the end of its line must not leak into the next one.
  assert.equal(document.offsetAt(new Position(0, 99)), 3);
  assert.equal(document.positionAt(9999).line, 2);
  assert.equal(document.offsetAt(new Position(99, 0)), document.offsetAt(new Position(2, 0)));
});

test('CRLF content is measured with its two-character break', () => {
  const document = doc('uno\r\ndos');

  assert.equal(document.eol, 2);
  assert.equal(document.lineAt(0).text, 'uno');
  assert.equal(document.offsetAt(new Position(1, 0)), 5);
});

test('the word at a position is found, and nothing is found between words', () => {
  const document = doc('const nombre = valor;');

  assert.equal(document.getText(document.getWordRangeAtPosition(new Position(0, 8))), 'nombre');
  assert.equal(document.getWordRangeAtPosition(new Position(0, 13)), undefined);
});

test('an update keeps the same object and rebuilds the line index', () => {
  const document = doc('una linea');
  document.update({ content: 'dos\nlineas', version: 2 });

  assert.equal(document.version, 2);
  assert.equal(document.lineCount, 2);
  assert.equal(document.lineAt(1).text, 'lineas');
});

// ── DocumentRegistry (host) ─────────────────────────────────────────────

function createRegistry() {
  const events = [];
  const registry = new DocumentRegistry();
  registry.onDidOpenTextDocument((d) => events.push(`open:${d.fileName}`));
  registry.onDidChangeTextDocument((e) => events.push(`change:${e.document.fileName}:v${e.document.version}`));
  registry.onDidSaveTextDocument((d) => events.push(`save:${d.fileName}`));
  registry.onDidCloseTextDocument((d) => events.push(`close:${d.fileName}`));
  return { registry, events };
}

const state = (uri, content, version = 1) => ({
  uri,
  languageId: 'plaintext',
  version,
  content,
  isDirty: false,
});

test('the registry fires the lifecycle and keeps the document instance stable', () => {
  const r = createRegistry();

  const opened = r.registry.open(state('/w/a.txt', 'uno'));
  const changed = r.registry.change('/w/a.txt', { content: 'dos', version: 2 });
  r.registry.save('/w/a.txt');
  r.registry.close('/w/a.txt');

  assert.equal(changed, opened, 'an extension holds the document it was given');
  assert.deepEqual(r.events, [
    'open:/w/a.txt',
    'change:/w/a.txt:v2',
    'save:/w/a.txt',
    'close:/w/a.txt',
  ]);
  assert.deepEqual(r.registry.textDocuments, []);
});

test('re-opening a tracked document is a change, not a second open', () => {
  const r = createRegistry();
  r.registry.open(state('/w/a.txt', 'uno'));
  r.registry.open(state('/w/a.txt', 'dos', 2));

  assert.deepEqual(r.events, ['open:/w/a.txt', 'change:/w/a.txt:v2']);
});

test('a change for something never opened is dropped, not invented', () => {
  const r = createRegistry();

  assert.equal(r.registry.change('/w/ghost.txt', { content: 'x' }), null);
  assert.deepEqual(r.events, []);
});

test('save clears the dirty flag, and reset seeds without firing anything', () => {
  const r = createRegistry();
  r.registry.open({ ...state('/w/a.txt', 'uno'), isDirty: true });
  r.registry.save('/w/a.txt');
  assert.equal(r.registry.get('/w/a.txt').isDirty, false);

  const seeded = createRegistry();
  seeded.registry.reset([state('/w/b.txt', 'ya estaba')]);
  assert.deepEqual(seeded.events, [], 'what already existed is state, not an event');
  assert.equal(seeded.registry.textDocuments.length, 1);
});

// ── DocumentMirror (main) ───────────────────────────────────────────────

function createMirror() {
  const relayed = [];
  const logs = [];
  const mirror = new DocumentMirror({
    notifyHost: (event) => relayed.push(`${event.kind}:${event.uri ?? event.document.uri}`),
    log: (message) => logs.push(message),
  });
  return { mirror, relayed, logs };
}

test('the mirror answers with the buffer, which is the point of it existing', () => {
  const m = createMirror();
  m.mirror.apply({ kind: 'open', document: state('/w/a.txt', 'en disco') });
  m.mirror.apply({ kind: 'change', uri: '/w/a.txt', version: 2, content: 'sin guardar' });

  assert.equal(
    m.mirror.contentOf('/w/a.txt'),
    'sin guardar',
    'an extension must see what the user sees, not what is on disk',
  );
  assert.equal(m.mirror.get('/w/a.txt').isDirty, true);
  assert.equal(m.mirror.contentOf('/w/otro.txt'), null, 'not open means fall back to disk');
});

test('a stale or unknown change is dropped instead of rewinding the mirror', () => {
  const m = createMirror();
  m.mirror.apply({ kind: 'open', document: state('/w/a.txt', 'uno') });
  m.mirror.apply({ kind: 'change', uri: '/w/a.txt', version: 5, content: 'cinco' });
  m.mirror.apply({ kind: 'change', uri: '/w/a.txt', version: 3, content: 'tres' });
  m.mirror.apply({ kind: 'change', uri: '/w/ghost.txt', version: 2, content: 'x' });

  assert.equal(m.mirror.contentOf('/w/a.txt'), 'cinco');
  assert.equal(m.logs.length, 2, 'both drops are explained');
});

test('save clears dirty and close removes the document', () => {
  const m = createMirror();
  m.mirror.apply({ kind: 'open', document: { ...state('/w/a.txt', 'uno'), isDirty: true } });
  m.mirror.apply({ kind: 'save', uri: '/w/a.txt', version: 2, content: 'guardado' });

  assert.deepEqual(m.mirror.get('/w/a.txt'), {
    uri: '/w/a.txt',
    languageId: 'plaintext',
    version: 2,
    content: 'guardado',
    isDirty: false,
  });

  m.mirror.apply({ kind: 'close', uri: '/w/a.txt' });
  assert.equal(m.mirror.get('/w/a.txt'), null);
  assert.deepEqual(m.relayed, ['open:/w/a.txt', 'save:/w/a.txt', 'close:/w/a.txt']);
});

test('a host that cannot be notified does not break the user typing', () => {
  const mirror = new DocumentMirror({
    notifyHost: () => { throw new Error('host caído'); },
    log: () => undefined,
  });

  mirror.apply({ kind: 'open', document: state('/w/a.txt', 'uno') });
  assert.equal(mirror.contentOf('/w/a.txt'), 'uno');
});

test('malformed events are rejected at the boundary', () => {
  assert.equal(parseDocumentSyncEvent(null), null);
  assert.equal(parseDocumentSyncEvent({ kind: 'open' }), null);
  assert.equal(parseDocumentSyncEvent({ kind: 'open', document: { uri: '' } }), null);
  assert.equal(parseDocumentSyncEvent({ kind: 'change', uri: '/w/a', version: 'dos', content: '' }), null);
  assert.equal(parseDocumentSyncEvent({ kind: 'nonsense', uri: '/w/a' }), null);

  assert.deepEqual(parseDocumentSyncEvent({ kind: 'close', uri: '/w/a' }), {
    kind: 'close',
    uri: '/w/a',
  });
  assert.deepEqual(
    parseDocumentSyncEvent({ kind: 'open', document: { uri: '/w/a', content: 'x' } }),
    {
      kind: 'open',
      document: { uri: '/w/a', languageId: 'plaintext', version: 1, content: 'x', isDirty: false },
    },
  );
});

// ── DocumentSyncService (renderer) ──────────────────────────────────────

function createSync() {
  const sent = [];
  const timers = [];
  const service = new DocumentSyncService({
    send: (event) => sent.push(event),
    debounceMs: 10,
    setTimer: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimer: (handle) => { timers[handle - 1] = null; },
  });
  return {
    service,
    sent,
    /** Fires every pending debounce, as the clock would. */
    tick: () => {
      const pending = timers.splice(0, timers.length);
      for (const handler of pending) handler?.();
    },
  };
}

test('opening sends the whole document; changes are debounced into one', () => {
  const s = createSync();
  s.service.open('/w/a.txt', 'plaintext', 'uno');
  s.service.change('/w/a.txt', 'un');
  s.service.change('/w/a.txt', 'uno d');
  s.service.change('/w/a.txt', 'uno dos');
  s.tick();

  assert.deepEqual(s.sent, [
    { kind: 'open', document: { uri: '/w/a.txt', languageId: 'plaintext', version: 1, content: 'uno', isDirty: false } },
    { kind: 'change', uri: '/w/a.txt', version: 2, content: 'uno dos', isDirty: true },
  ]);
});

test('an identical content is not a change, however often it is written', () => {
  const s = createSync();
  s.service.open('/w/a.txt', 'plaintext', 'uno');
  s.service.change('/w/a.txt', 'uno');
  s.tick();

  assert.equal(s.sent.length, 1, 'programmatic rewrites of the same text are not edits');
});

test('saving flushes what was pending, so onDidSave sees the saved text', () => {
  const s = createSync();
  s.service.open('/w/a.txt', 'plaintext', 'uno');
  s.service.change('/w/a.txt', 'uno dos');
  s.service.save('/w/a.txt', 'uno dos');

  assert.deepEqual(s.sent.map((event) => event.kind), ['open', 'change', 'save']);
  assert.equal(s.sent.at(-1).content, 'uno dos');
  assert.equal(s.sent.at(-1).version, 2);
});

test('versions only ever move forward, across changes and saves', () => {
  const s = createSync();
  s.service.open('/w/a.txt', 'plaintext', 'a');
  s.service.change('/w/a.txt', 'ab');
  s.tick();
  s.service.change('/w/a.txt', 'abc');
  s.tick();
  s.service.save('/w/a.txt', 'abcd');

  // The open carries its version inside the document; the rest carry it at
  // the top level, exactly as the mirror expects them.
  assert.deepEqual(
    s.sent.map((event) => event.version ?? event.document.version),
    [1, 2, 3, 4],
  );
});

test('reconciling the open tabs opens the new ones and closes the gone ones', () => {
  const s = createSync();
  s.service.syncOpenDocuments([
    { path: '/w/a.txt', language: 'plaintext', content: 'a' },
    { path: '/w/b.txt', language: 'plaintext', content: 'b' },
  ]);
  s.sent.length = 0;

  s.service.syncOpenDocuments([
    { path: '/w/b.txt', language: 'plaintext', content: 'b' },
    { path: '/w/c.txt', language: 'plaintext', content: 'c' },
  ]);

  assert.deepEqual(s.sent.map((event) => `${event.kind}:${event.uri ?? event.document.uri}`), [
    'open:/w/c.txt',
    'close:/w/a.txt',
  ]);
  assert.deepEqual(s.service.tracked, ['/w/b.txt', '/w/c.txt']);
});

test('closing cancels a pending change: the document is gone, its edit is moot', () => {
  const s = createSync();
  s.service.open('/w/a.txt', 'plaintext', 'uno');
  s.service.change('/w/a.txt', 'dos');
  s.service.close('/w/a.txt');
  s.tick();

  assert.deepEqual(s.sent.map((event) => event.kind), ['open', 'close']);
});
