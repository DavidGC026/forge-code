'use strict';

// Edits: the pure application of them, the all-or-nothing service that
// validates versions, and the containers extensions build.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyTextEdits,
  isTextEditPayload,
  offsetAt,
  lineStarts,
} = require('../../dist-electron/extensions/domain/text-edits.js');
const {
  WorkspaceEditService,
  parseWorkspaceEdit,
} = require('../../dist-electron/extensions/application/workspace-edit-service.js');
const {
  DocumentMirror,
} = require('../../dist-electron/extensions/application/document-mirror.js');
const {
  TextEdit,
  TextEditorEdit,
  WorkspaceEdit,
} = require('../../dist-electron/extension-host/vscode-api/workspace-edit.js');
const {
  Position,
  Range,
} = require('../../dist-electron/extension-host/vscode-api/primitives.js');
const { applyEditsToText } = require('../../src/extensions/documentSync.ts');

const edit = (startLine, startCharacter, endLine, endCharacter, newText) => ({
  startLine,
  startCharacter,
  endLine,
  endCharacter,
  newText,
});

// ── Pure application ────────────────────────────────────────────────────

test('edits address the original text, so several apply together correctly', () => {
  const content = 'const viejo = 1;\nconst otro = viejo;';

  const result = applyTextEdits(content, [
    edit(0, 6, 0, 11, 'nuevo'),
    edit(1, 13, 1, 18, 'nuevo'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.content, 'const nuevo = 1;\nconst otro = nuevo;');
});

test('order of declaration does not matter: positions are resolved first', () => {
  const content = 'abcdef';
  const forwards = applyTextEdits(content, [edit(0, 0, 0, 1, 'X'), edit(0, 5, 0, 6, 'Y')]);
  const backwards = applyTextEdits(content, [edit(0, 5, 0, 6, 'Y'), edit(0, 0, 0, 1, 'X')]);

  assert.equal(forwards.content, 'XbcdeY');
  assert.equal(forwards.content, backwards.content, 'the declared order does not change the result');
});

test('overlapping edits are refused, never merged', () => {
  const result = applyTextEdits('0123456789', [edit(0, 0, 0, 5, 'uno'), edit(0, 3, 0, 8, 'dos')]);

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'overlapping');
});

test('touching edits are fine: an insert at the end of a replace is not an overlap', () => {
  const result = applyTextEdits('abcdef', [edit(0, 0, 0, 3, 'X'), edit(0, 3, 0, 3, '-')]);

  assert.equal(result.ok, true);
  assert.equal(result.content, 'X-def');
});

test('two inserts at the same point keep the order they were declared in', () => {
  const result = applyTextEdits('ab', [edit(0, 1, 0, 1, 'uno'), edit(0, 1, 0, 1, 'dos')]);

  assert.equal(result.content, 'aunodosb');
});

test('a backwards range is normalised instead of rejected', () => {
  const result = applyTextEdits('abcdef', [edit(0, 4, 0, 1, 'X')]);

  assert.equal(result.ok, true);
  assert.equal(result.content, 'aXef');
});

test('positions past the end clamp to the line, and multiline edits work', () => {
  const content = 'uno\ndos\ntres';
  const starts = lineStarts(content);

  assert.equal(offsetAt(content, starts, 0, 99), 3, 'clamped to the line, not the document');
  assert.equal(offsetAt(content, starts, 99, 0), 8, 'clamped to the last line');

  const result = applyTextEdits(content, [edit(0, 2, 2, 1, 'X')]);
  assert.equal(result.content, 'unXres');
});

test('an edit with no newText is refused rather than treated as a delete', () => {
  const result = applyTextEdits('abc', [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }]);

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'invalid');
  assert.equal(isTextEditPayload({ startLine: 0 }), false);
  assert.equal(isTextEditPayload(edit(0, 0, 0, 1, '')), true);
});

test('an empty edit list leaves the content untouched', () => {
  assert.deepEqual(applyTextEdits('abc', []), { ok: true, content: 'abc' });
});

test('the renderer applies edits the same way main computed them', () => {
  // The two implementations must agree: main validated against its own
  // result, and a divergence here would apply something else to the buffer.
  const content = 'const viejo = 1;\nconst otro = viejo;';
  const edits = [edit(0, 6, 0, 11, 'nuevo'), edit(1, 13, 1, 18, 'nuevo')];

  assert.equal(applyEditsToText(content, edits), applyTextEdits(content, edits).content);
  assert.equal(
    applyEditsToText('0123456789', [edit(0, 0, 0, 5, 'a'), edit(0, 3, 0, 8, 'b')]),
    null,
    'and both refuse overlaps',
  );
});

// ── Service ─────────────────────────────────────────────────────────────

function createService({ open = {}, disk = {}, rendererFails = false, refuse = [] } = {}) {
  const mirror = new DocumentMirror({});
  for (const [uri, document] of Object.entries(open)) {
    mirror.apply({
      kind: 'open',
      document: {
        uri,
        languageId: 'plaintext',
        version: document.version ?? 1,
        content: document.content,
        isDirty: false,
      },
    });
  }
  const written = [];
  const rendererEdits = [];
  const files = { ...disk };

  const service = new WorkspaceEditService({
    mirror,
    authorise: async (uri) => {
      if (refuse.includes(uri)) throw new Error(`"${uri}" fuera de política`);
    },
    readFile: async (uri) => {
      if (!(uri in files)) throw new Error(`"${uri}" no existe`);
      return files[uri];
    },
    writeFile: async (uri, content) => {
      files[uri] = content;
      written.push(uri);
    },
    applyInRenderer: async (uri, edits) => {
      rendererEdits.push({ uri, edits });
      return !rendererFails;
    },
  });

  return { service, mirror, files, written, rendererEdits };
}

test('a multi-file edit applies to the open buffer and to the closed file', async () => {
  const s = createService({
    open: { '/w/abierto.ts': { content: 'const viejo = 1;', version: 3 } },
    disk: { '/w/cerrado.ts': 'const viejo = 2;' },
  });

  const result = await s.service.apply({
    files: [
      { uri: '/w/abierto.ts', version: 3, edits: [edit(0, 6, 0, 11, 'nuevo')] },
      { uri: '/w/cerrado.ts', version: null, edits: [edit(0, 6, 0, 11, 'nuevo')] },
    ],
  }, 'acme.demo');

  assert.equal(result.applied, true);
  assert.deepEqual(result.files, ['/w/abierto.ts', '/w/cerrado.ts']);
  assert.equal(s.files['/w/cerrado.ts'], 'const nuevo = 2;', 'the closed file was written');
  assert.deepEqual(s.rendererEdits[0].uri, '/w/abierto.ts', 'the open one went to the editor');
  assert.deepEqual(s.written, ['/w/cerrado.ts'], 'and only the closed one was written to disk');
});

test('a stale version rejects the whole edit, touching nothing', async () => {
  const s = createService({
    open: { '/w/a.ts': { content: 'viejo', version: 7 } },
    disk: { '/w/b.ts': 'viejo' },
  });

  const result = await s.service.apply({
    files: [
      { uri: '/w/b.ts', version: null, edits: [edit(0, 0, 0, 5, 'nuevo')] },
      { uri: '/w/a.ts', version: 5, edits: [edit(0, 0, 0, 5, 'nuevo')] },
    ],
  }, 'acme.demo');

  assert.equal(result.applied, false);
  assert.match(result.reason, /cambió mientras/);
  assert.deepEqual(result.files, []);
  assert.equal(s.files['/w/b.ts'], 'viejo', 'the other file was never written');
  assert.deepEqual(s.rendererEdits, []);
});

test('an overlap anywhere rejects the whole edit before writing anything', async () => {
  const s = createService({ disk: { '/w/a.ts': '0123456789', '/w/b.ts': 'abc' } });

  const result = await s.service.apply({
    files: [
      { uri: '/w/b.ts', version: null, edits: [edit(0, 0, 0, 1, 'X')] },
      { uri: '/w/a.ts', version: null, edits: [edit(0, 0, 0, 5, 'uno'), edit(0, 3, 0, 8, 'dos')] },
    ],
  }, 'acme.demo');

  assert.equal(result.applied, false);
  assert.match(result.reason, /solapan/);
  assert.deepEqual(s.written, [], 'nothing was written, not even the valid file');
});

test('a path outside the policy rejects the edit', async () => {
  const s = createService({ disk: { '/etc/passwd': 'x' }, refuse: ['/etc/passwd'] });

  await assert.rejects(
    s.service.apply({ files: [{ uri: '/etc/passwd', version: null, edits: [edit(0, 0, 0, 1, 'X')] }] }, 'acme.demo'),
    /fuera de política/,
  );
  assert.deepEqual(s.written, []);
});

test('an edit against a version that matches is applied', async () => {
  const s = createService({ open: { '/w/a.ts': { content: 'viejo', version: 4 } } });

  const result = await s.service.apply({
    files: [{ uri: '/w/a.ts', version: 4, edits: [edit(0, 0, 0, 5, 'nuevo')] }],
  }, 'acme.demo');

  assert.equal(result.applied, true);
});

test('a null version skips the check, as VS Code allows for closed files', async () => {
  const s = createService({ open: { '/w/a.ts': { content: 'viejo', version: 9 } } });

  const result = await s.service.apply({
    files: [{ uri: '/w/a.ts', version: null, edits: [edit(0, 0, 0, 5, 'nuevo')] }],
  }, 'acme.demo');

  assert.equal(result.applied, true);
});

test('a renderer that cannot apply reports what was already done', async () => {
  const s = createService({
    open: { '/w/a.ts': { content: 'viejo', version: 1 } },
    disk: { '/w/b.ts': 'viejo' },
    rendererFails: true,
  });

  const result = await s.service.apply({
    files: [
      { uri: '/w/b.ts', version: null, edits: [edit(0, 0, 0, 5, 'nuevo')] },
      { uri: '/w/a.ts', version: 1, edits: [edit(0, 0, 0, 5, 'nuevo')] },
    ],
  }, 'acme.demo');

  assert.equal(result.applied, false);
  assert.deepEqual(result.files, ['/w/b.ts'], 'what did happen is reported, not hidden');
  assert.match(result.reason, /no pudo aplicar/);
});

test('a malformed edit is refused at the boundary', async () => {
  const s = createService();

  assert.equal(parseWorkspaceEdit(null), null);
  assert.equal(parseWorkspaceEdit({ files: 'no' }), null);
  assert.equal(parseWorkspaceEdit({ files: [{ uri: '', edits: [] }] }), null);
  assert.equal(parseWorkspaceEdit({ files: [{ uri: '/w/a', edits: [{ bad: true }] }] }), null);

  await assert.rejects(s.service.apply({ files: 'nope' }, 'acme.demo'), (err) => {
    assert.equal(err.code, 'INVALID_PAYLOAD');
    return true;
  });
});

test('an edit with no files is a no-op that succeeds', async () => {
  const s = createService();
  assert.deepEqual(await s.service.apply({ files: [] }, 'acme.demo'), { applied: true, files: [] });
});

// ── Containers (host) ───────────────────────────────────────────────────

test('WorkspaceEdit collects per file, in order, and serialises with versions', () => {
  const edit = new WorkspaceEdit();
  edit.replace('/w/a.ts', new Range(0, 0, 0, 3), 'uno');
  edit.insert('/w/a.ts', new Position(1, 0), 'dos');
  edit.delete('/w/b.ts', new Range(2, 0, 2, 5));

  assert.equal(edit.size, 2);
  assert.equal(edit.has('/w/a.ts'), true);
  assert.equal(edit.get('/w/a.ts').length, 2);
  assert.deepEqual(edit.entries().map(([uri]) => uri.fsPath), ['/w/a.ts', '/w/b.ts']);

  const payload = edit.serialize((uri) => (uri === '/w/a.ts' ? 4 : null));
  assert.deepEqual(payload.files[0], {
    uri: '/w/a.ts',
    version: 4,
    edits: [
      { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3, newText: 'uno' },
      { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 0, newText: 'dos' },
    ],
  });
  assert.equal(payload.files[1].version, null);
});

test('set replaces the edits of a file, and an empty set removes it', () => {
  const edit = new WorkspaceEdit();
  edit.replace('/w/a.ts', new Range(0, 0, 0, 1), 'x');
  edit.set('/w/a.ts', [TextEdit.replace(new Range(1, 0, 1, 1), 'y')]);
  assert.deepEqual(edit.get('/w/a.ts').map((e) => e.newText), ['y']);

  edit.set('/w/a.ts', []);
  assert.equal(edit.has('/w/a.ts'), false);
});

test('file operations say they are unsupported instead of being ignored', () => {
  const edit = new WorkspaceEdit();

  assert.throws(() => edit.createFile(), /workspace\.fs\.writeFile/);
  assert.throws(() => edit.deleteFile(), /workspace\.fs\.delete/);
  assert.throws(() => edit.renameFile(), /workspace\.fs\.rename/);
});

test('TextEdit factories build the ranges VS Code documents', () => {
  assert.equal(TextEdit.insert(new Position(1, 2), 'x').range.isEmpty, true);
  assert.equal(TextEdit.delete(new Range(0, 0, 0, 3)).newText, '');
  assert.equal(TextEdit.replace(new Range(0, 0, 0, 3), 'x').newText, 'x');
});

test('the editor builder collects synchronously and refuses use after closing', () => {
  const builder = new TextEditorEdit();
  builder.replace(new Range(0, 0, 0, 1), 'x');
  builder.insert(new Position(1, 0), 'y');
  builder.delete(new Range(2, 0, 2, 1));

  const edits = builder.close();
  assert.deepEqual(edits.map((e) => e.newText), ['x', 'y', '']);
  assert.throws(() => builder.insert(new Position(0, 0), 'z'), /ya se cerró/);
});

test('the builder accepts a position where a range is expected, as VS Code does', () => {
  const builder = new TextEditorEdit();
  builder.replace(new Position(3, 1), 'x');

  const [collected] = builder.close();
  assert.equal(collected.range.isEmpty, true);
  assert.equal(collected.range.start.line, 3);
});
