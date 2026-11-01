import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { editor } from 'monaco-editor';
import { useStore } from '../../store';
import { lspClient, getLspLanguageId } from '../../lsp/client';
import { documentSyncService, editorSyncService } from '../../extensions/registry';
import { applyEditsToText, buildEditorLayout } from '../../extensions/documentSync';

/** Preserve the editor and extension document lifecycle independently of chrome. */
export function useEditorSync(editorRef: RefObject<editor.IStandaloneCodeEditor | null>) {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const updateTabContent = useStore((s) => s.updateTabContent);
  const openFilePath = useStore((s) => s.openFilePath);
  // Track which tab paths we've sent textDocument/didOpen for, so we
  // can fire didOpen exactly once per tab and didClose when the tab
  // disappears.
  const openedTabPathsRef = useRef<Set<string>>(new Set());

  // Caret per file, for `window.activeTextEditor`. A ref, not state: it
  // changes on every keystroke and nothing in React needs to re-render.
  const selectionsRef = useRef<Record<string, {
    anchorLine: number;
    anchorCharacter: number;
    activeLine: number;
    activeCharacter: number;
  }[]>>({});
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  /** Publishes the editor layout to the Extension Host. Dedup happens in
   *  the service, so calling it liberally is fine. */
  const publishEditorLayout = useCallback(() => {
    const tabs = openTabsRef.current.filter(
      (tab) => !tab.imageDataUrl && !tab.extension && !tab.gitDiff && tab.path,
    );
    const active = tabs.find((tab) => tab.id === activeTabIdRef.current);
    editorSyncService.publish(
      buildEditorLayout(tabs, active?.path ?? null, selectionsRef.current),
    );
  }, []);

  // ── Manage didOpen / didClose for each tab ────────────────────────────
  // Whenever the set of open tabs changes we diff against what we last
  // sent: new tabs get didOpen, removed ones get didClose. Tabs whose
  // language LSP doesn't care about (e.g. markdown, json, images) are
  // skipped.
  useEffect(() => {
    const currentPaths = new Set(openTabs.map((t) => t.path));
    const previouslyOpened = openedTabPathsRef.current;

    // didOpen for newly opened tabs.
    for (const tab of openTabs) {
      if (previouslyOpened.has(tab.path)) continue;
      // Image and extension-detail tabs are never sent to the language server.
      if (tab.imageDataUrl || tab.extension) continue;
      if (!getLspLanguageId(tab.path)) continue;
      lspClient.openDocument(tab.path, tab.content);
      previouslyOpened.add(tab.path);
    }

    // didClose for tabs that have been closed.
    for (const oldPath of Array.from(previouslyOpened)) {
      if (!currentPaths.has(oldPath)) {
        lspClient.closeDocument(oldPath);
        previouslyOpened.delete(oldPath);
      }
    }

    // The Extension Host mirrors every text buffer, not just the ones a
    // language server understands: an extension may care about any file.
    // One reconciliation call covers both new and closed tabs.
    documentSyncService.syncOpenDocuments(
      openTabs
        .filter((tab) => !tab.imageDataUrl && !tab.extension && !tab.gitDiff && tab.path)
        .map((tab) => ({
          path: tab.path,
          language: tab.language,
          content: tab.content,
          isUnsaved: tab.isUnsaved,
        })),
    );

    // Publish documents first: the host can only create editor views for
    // documents it already knows. Layout dedup would otherwise prevent a
    // dropped initial view from being repaired until the caret moved.
    publishEditorLayout();
  }, [openTabs, publishEditorLayout]);

  // Focus moving between tabs is an `onDidChangeActiveTextEditor` for every
  // extension listening.
  useEffect(() => {
    publishEditorLayout();
  }, [activeTabId, publishEditorLayout]);

  // `workspace.applyEdit` on an open buffer. Monaco applies the whole set in
  // one `executeEdits`, which is what makes it a single undo step for the
  // user: an extension's refactor is taken back with one Ctrl+Z, not one per
  // touched line.
  useEffect(() => {
    const api = window.electronAPI?.ext;
    if (!api?.onApplyEdits) return;
    const subscription = api.onApplyEdits((request) => {
      let applied = false;
      try {
        const editorInstance = editorRef.current;
        const model = editorInstance?.getModel();
        const tab = openTabsRef.current.find((entry) => entry.path === request.uri);

        if (model && tab && tab.id === activeTabIdRef.current) {
          // The visible buffer: edit through Monaco so undo, decorations and
          // the caret all behave as if the user had typed it.
          model.pushStackElement();
          model.pushEditOperations(
            [],
            request.edits.map((edit) => ({
              range: {
                startLineNumber: edit.startLine + 1,
                startColumn: edit.startCharacter + 1,
                endLineNumber: edit.endLine + 1,
                endColumn: edit.endCharacter + 1,
              },
              text: edit.newText,
            })),
            () => null,
          );
          model.pushStackElement();
          updateTabContent(tab.id, model.getValue());
          applied = true;
        } else if (tab) {
          // Open but not on screen: there is no Monaco model to edit, so the
          // buffer is updated directly and stays dirty, exactly as if the
          // user had typed into it.
          const next = applyEditsToText(tab.content, request.edits);
          if (next !== null) {
            updateTabContent(tab.id, next);
            applied = true;
          }
        }
      } catch (err) {
        console.error('[forge:ext] no se pudieron aplicar las ediciones:', err);
        applied = false;
      }
      api.respondApplyEdits?.(request.id, applied);
    });
    return () => subscription.dispose();
  }, [updateTabContent]);

  // `window.showTextDocument`: main relays the request and waits for the
  // answer, so the extension's promise resolves when the tab really exists.
  useEffect(() => {
    const api = window.electronAPI?.ext;
    if (!api?.onShowDocument) return;
    const subscription = api.onShowDocument((request) => {
      void (async () => {
        let shown = false;
        try {
          // `preserveFocus` decides whether the tab comes to the front: an
          // extension revealing a document in the background must not steal
          // the user's caret.
          const result = await openFilePath(request.uri, {
            makeFrontmost: !request.preserveFocus,
          });
          shown = result.success;
        } catch {
          shown = false;
        }
        api.respondShowDocument?.(request.id, shown);
      })();
    });
    return () => subscription.dispose();
  }, [openFilePath]);

  return { selectionsRef, publishEditorLayout };
}
