'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const sync = require('../../src/extensions/documentSync.ts');
const { DocumentRegistry } = require('../../dist-electron/extension-host/document-registry.js');
const { EditorRegistry } = require('../../dist-electron/extension-host/editor-registry.js');

test('the editor hook publishes a new document before its first editor layout', () => {
  const documents = new DocumentRegistry();
  const editors = new EditorRegistry(documents);
  const documentSyncService = new sync.DocumentSyncService({ send: event => {
    if (event.kind === 'open') documents.open(event.document);
    if (event.kind === 'close') documents.close(event.uri);
  } });
  const editorSyncService = new sync.EditorSyncService({ send: layout => editors.sync(layout.editors, layout.activeUri) });
  const effects = [];
  const store = {
    openTabs: [{ id: 'tab', path: '/w/hello.ts', language: 'typescript', content: 'dirty user buffer', isUnsaved: true }],
    activeTabId: 'tab', updateTabContent() {}, openFilePath() {},
  };
  // Run the production hook's effects without a browser. React/store/LSP
  // are seams; document/editor synchronization and host registries are real.
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/components/Editor/useEditorSync.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dependencies = {
    react: { useCallback: callback => callback, useEffect: effect => effects.push(effect), useRef: current => ({ current }) },
    '../../store': { useStore: selector => selector(store) },
    '../../lsp/client': { lspClient: {}, getLspLanguageId: () => null },
    '../../extensions/registry': { documentSyncService, editorSyncService },
    '../../extensions/documentSync': sync,
  };
  const exports = {};
  new Function('require', 'exports', 'window', compiled)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports, {});
  exports.useEditorSync({ current: null });
  for (const effect of effects) effect();
  assert.equal(editors.activeTextEditor.document.fileName, '/w/hello.ts');
  assert.equal(editors.activeTextEditor.document.getText(), 'dirty user buffer');
  assert.equal(editors.activeTextEditor.document, documents.textDocuments[0]);
  assert.equal(editors.visibleTextEditors.length, 1);
  documentSyncService.reset(); editors.dispose(); documents.dispose();
});
