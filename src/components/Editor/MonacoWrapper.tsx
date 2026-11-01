import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useStore } from '../../store';
import { lspClient, getLspLanguageId } from '../../lsp/client';
import { documentSyncService, attachMonaco as attachExtensionMonaco, isThemeAvailable } from '../../extensions/registry';
import { runEditorAIAction, type EditorAIActionKind } from '../../ai/quickActions';
import { defineForgeTheme } from './forgeTheme';
import { useEditorSync } from './useEditorSync';
import WelcomeScreen from '../WelcomeScreen';
import ImageViewer from '../ImageViewer';
import GitDiffEditor from '../GitDiffEditor';
import ExtensionDetailView from '../ExtensionDetailView';

function toFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(normalized);
}

export default function MonacoWrapper() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const updateTabContent = useStore((s) => s.updateTabContent);
  const setCursorPosition = useStore((s) => s.setCursorPosition);
  const editorFontSize = useStore((s) => s.editorFontSize);
  const activeTheme = useStore((s) => s.activeTheme);
  const wordWrap = useStore((s) => s.wordWrap);
  const minimapEnabled = useStore((s) => s.minimapEnabled);
  const tabSize = useStore((s) => s.tabSize);
  const registerFormatActiveDocument = useStore((s) => s.registerFormatActiveDocument);
  const pendingEditorReveal = useStore((s) => s.pendingEditorReveal);
  const clearPendingEditorReveal = useStore((s) => s.clearPendingEditorReveal);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const { selectionsRef, publishEditorLayout } = useEditorSync(editorRef);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const activeTabRef = useRef(activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    defineForgeTheme(monaco);

    // Register themes/snippets contributed by installed VSIX extensions.
    // If the extension list was fetched before Monaco loaded, this replays it.
    try {
      attachExtensionMonaco(monaco);
    } catch (err) {
      console.warn('[forge] extension registry attach failed:', (err as Error)?.message);
    }

    // ── Disable Monaco's built-in TS/JS semantic diagnostics ──────────
    // Monaco ships a bundled TypeScript service that doesn't know about
    // the user's tsconfig, node_modules or types-installed packages.
    // typescript-language-server (running in the Electron main process)
    // gives us accurate, project-aware diagnostics; we plumb those in
    // via lspClient.applyDiagnostics() instead. Syntax validation is
    // kept ON because Monaco's parser also tokens cheap stuff (mismatched
    // braces, stray characters) we want to highlight regardless.
    try {
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false,
      });
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug('[forge] Monaco TS diagnostics setup skipped:', (err as Error)?.message);
    }

    // Wire the LSP client into Monaco. attachMonaco is idempotent — it
    // registers the providers and the diagnostics listener exactly once.
    try {
      lspClient.attachMonaco(monaco);
    } catch (err) {
      console.warn('[forge] LSP attach failed:', (err as Error)?.message);
    }
  }, []);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.focus();

    registerFormatActiveDocument(async () => {
      const action = editor.getAction('editor.action.formatDocument');
      if (action) await action.run();
    });

    useStore.getState().registerRunEditorAction(async (actionId: string) => {
      editor.focus();
      const action = editor.getAction(actionId);
      if (action) await action.run();
    });

    // ── AI quick actions (context menu) ───────────────────────────────
    // Operate on the selection, or the whole file when nothing is selected.
    const runAIAction = (kind: EditorAIActionKind) => {
      const tab = activeTabRef.current;
      const model = editor.getModel();
      if (!tab || tab.imageDataUrl || !model) return;

      const selection = editor.getSelection();
      const hasSelection = Boolean(selection && !selection.isEmpty());
      const code = hasSelection && selection ? model.getValueInRange(selection) : model.getValue();

      const ws = useStore.getState().workspacePath;
      const norm = tab.path.replace(/\\/g, '/');
      const wsNorm = ws ? ws.replace(/\\/g, '/') : '';
      const relPath =
        wsNorm && norm.startsWith(wsNorm + '/') ? norm.slice(wsNorm.length + 1) : tab.name;

      void runEditorAIAction(
        kind,
        {
          relPath,
          language: tab.language || 'plaintext',
          code,
          wholeFile: !hasSelection,
          startLine: selection?.startLineNumber,
          endLine: selection?.endLineNumber,
        },
        tab.path,
      );
    };

    const aiActions: { id: string; label: string; kind: EditorAIActionKind; order: number }[] = [
      { id: 'forge-ai-explain', label: 'IA: Explicar selección', kind: 'explain', order: 1 },
      { id: 'forge-ai-refactor', label: 'IA: Refactorizar selección', kind: 'refactor', order: 2 },
      { id: 'forge-ai-document', label: 'IA: Documentar selección', kind: 'document', order: 3 },
      { id: 'forge-ai-fix', label: 'IA: Corregir con diagnósticos', kind: 'fix', order: 4 },
    ];
    for (const a of aiActions) {
      editor.addAction({
        id: a.id,
        label: a.label,
        contextMenuGroupId: '0_forge_ai',
        contextMenuOrder: a.order,
        run: () => runAIAction(a.kind),
      });
    }

    editor.onDidChangeCursorPosition((e) => {
      setCursorPosition({
        line: e.position.lineNumber,
        column: e.position.column,
      });
    });

    editor.onDidChangeCursorSelection((e) => {
      const tab = activeTabRef.current;
      const model = editor.getModel();
      // Extensions read the caret too. Monaco is 1-based and the VS Code API
      // is 0-based; converting here keeps that off every consumer.
      if (tab?.path) {
        selectionsRef.current[tab.path] = editor.getSelections()?.map((sel) => ({
          anchorLine: sel.selectionStartLineNumber - 1,
          anchorCharacter: sel.selectionStartColumn - 1,
          activeLine: sel.positionLineNumber - 1,
          activeCharacter: sel.positionColumn - 1,
        })) ?? [];
        publishEditorLayout();
      }
      if (!tab || tab.imageDataUrl || !model) {
        window.electronAPI?.claudeIde?.updateSelection(null);
        return;
      }

      const selection = e.selection;
      const text = model.getValueInRange(selection);
      window.electronAPI?.claudeIde?.updateSelection({
        text,
        filePath: tab.path,
        fileUrl: toFileUri(tab.path),
        selection: {
          start: {
            line: selection.startLineNumber - 1,
            character: selection.startColumn - 1,
          },
          end: {
            line: selection.endLineNumber - 1,
            character: selection.endColumn - 1,
          },
          isEmpty: selection.isEmpty(),
        },
      });
    });
  }, [setCursorPosition, registerFormatActiveDocument]);

  useEffect(() => {
    return () => {
      registerFormatActiveDocument(null);
      useStore.getState().registerRunEditorAction(null);
    };
  }, [registerFormatActiveDocument]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: editorFontSize });
  }, [editorFontSize]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: minimapEnabled },
      tabSize,
    });
  }, [wordWrap, minimapEnabled, tabSize]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab || !pendingEditorReveal) return;
    if (activeTab.path !== pendingEditorReveal.filePath) return;
    if (pendingEditorReveal.selection) {
      editor.setSelection(pendingEditorReveal.selection);
      editor.revealRangeInCenter(pendingEditorReveal.selection);
      editor.focus();
    }
    clearPendingEditorReveal(pendingEditorReveal.id);
  }, [activeTab, pendingEditorReveal, clearPendingEditorReveal]);

  useEffect(() => {
    if (!activeTab || activeTab.imageDataUrl) {
      window.electronAPI?.claudeIde?.updateSelection(null);
    }
  }, [activeTab]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        const tab = activeTab;
        // Image tabs are read-only previews; ignore any spurious change
        // event Monaco might fire while we're mounted alongside them.
        if (tab?.imageDataUrl) return;

        // ── Agent streaming guard ─────────────────────────────────────
        // While the AI agent is streaming chunks into this file's buffer
        // (via `agentStreamAppendTab`) the React `value` prop changes on
        // every chunk. @monaco-editor/react does flag those as external
        // edits, but in practice a `controlled-component` race can still
        // make Monaco fire `onChange` with a STALE editor value just
        // after the next chunk lands in the store — which would clobber
        // the streamed content with the previous frame and ultimately
        // cause `agentStreamFinalizeTab` to persist OLD content to disk.
        //
        // We read the latest state via `getState()` so the callback's
        // dependency array stays narrow (no re-creation on every chunk).
        const streamingPaths = useStore.getState().agentStreamingPaths;
        if (tab && streamingPaths.has(tab.path)) {
          return;
        }

        updateTabContent(activeTabId, value);
        // Notify the LSP about the change (no-op for non-TS/JS files).
        if (tab && getLspLanguageId(tab.path)) {
          lspClient.changeDocument(tab.path, value);
        }
        // Extensions see every buffer, debounced by the sync service.
        if (tab?.path) documentSyncService.change(tab.path, value);
      }
    },
    [activeTabId, updateTabContent, activeTab]
  );

  if (!activeTab) return <WelcomeScreen />;

  if (activeTab.gitDiff) {
    return <GitDiffEditor tab={activeTab} />;
  }

  // Extension-detail tabs render a marketplace page (icon, stats, README)
  // instead of a Monaco text editor.
  if (activeTab.extension) {
    return <ExtensionDetailView key={activeTab.id} extension={activeTab.extension} />;
  }

  // Image tabs are rendered as a non-editable preview instead of being
  // forced through Monaco (which would otherwise show garbled binary text
  // for PNG/JPG/etc.).
  if (activeTab.imageDataUrl) {
    return (
      <ImageViewer
        key={activeTab.id}
        fileName={activeTab.name}
        dataUrl={activeTab.imageDataUrl}
        fileSize={activeTab.fileSize}
      />
    );
  }

  return (
    <div className="w-full h-full bg-forge-editor">
      <Editor
        key={activeTab.id}
        // path becomes part of the Monaco model URI so completion / hover
        // providers can identify which file the request is for.
        path={activeTab.path}
        language={activeTab.language}
        value={activeTab.content}
        theme={isThemeAvailable(activeTheme) ? activeTheme : 'forge-dark'}
        beforeMount={handleBeforeMount}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontSize: editorFontSize,
          fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          minimap: { enabled: minimapEnabled },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'all',
          wordWrap: wordWrap ? 'on' : 'off',
          lineNumbers: 'on',
          glyphMargin: false,
          folding: true,
          bracketPairColorization: { enabled: true },
          automaticLayout: true,
          tabSize,
          padding: { top: 8 },
          suggest: {
            showWords: true,
            showSnippets: true,
          },
        }}
      />
    </div>
  );
}

