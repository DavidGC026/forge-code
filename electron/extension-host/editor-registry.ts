/**
 * `window.activeTextEditor`, `visibleTextEditors` and their events.
 *
 * An editor is a *view* of a document, and the renderer owns both. This
 * registry keeps host-side objects in step with what main mirrors, on the
 * same terms as `DocumentRegistry`:
 *
 * - the `TextEditor` instance for a document is stable, so an extension can
 *   hold on to it across selection changes;
 * - an editor whose document the host does not know is dropped, not
 *   invented, because `editor.document` must be the same object extensions
 *   got from `workspace.textDocuments`.
 *
 * `editor.edit()` collects its edits and hands them to the same path as
 * `workspace.applyEdit`, which is what makes them one undo step: two routes
 * into the buffer would mean two ways for a version check to be skipped.
 */
import { EventEmitter, Selection, Range } from './vscode-api/primitives';
import type { Event } from './vscode-api/primitives';
import { TextEditorEdit, WorkspaceEdit } from './vscode-api/workspace-edit';
import type { DocumentRegistry } from './document-registry';
import type { TextDocument } from './vscode-api/text-document';

/** One selection as it crosses the wire. */
export interface SelectionState {
  anchorLine: number;
  anchorCharacter: number;
  activeLine: number;
  activeCharacter: number;
}

export interface EditorState {
  uri: string;
  /** Editor group, 1-based, as `vscode.ViewColumn`. */
  viewColumn: number;
  selections: SelectionState[];
  visibleRanges?: { startLine: number; endLine: number }[];
}

export interface TextEditorLike {
  document: TextDocument;
  selection: Selection;
  selections: Selection[];
  visibleRanges: Range[];
  viewColumn: number;
  /** `editor.edit(builder => …)`: collects the edits and applies them as
   *  one, through the same path as `workspace.applyEdit`. */
  edit(callback: (builder: TextEditorEdit) => void): Promise<boolean>;
}

export interface TextEditorSelectionChangeEvent {
  textEditor: TextEditorLike;
  selections: readonly Selection[];
  /** VS Code reports why the selection moved; Forge cannot tell yet, and
   *  `undefined` is what the API already documents for that case. */
  kind: undefined;
}

export interface EditorRegistryOptions {
  /** Applies a set of edits to one document, as `workspace.applyEdit` does.
   *  Injected so the registry stays free of transport. */
  applyEdit?: (edit: WorkspaceEdit) => Promise<boolean>;
}

export class EditorRegistry {
  private readonly editors = new Map<string, TextEditorLike>();
  private activeUri: string | null = null;
  private readonly onActive = new EventEmitter<TextEditorLike | undefined>();
  private readonly onSelection = new EventEmitter<TextEditorSelectionChangeEvent>();
  private readonly onVisible = new EventEmitter<readonly TextEditorLike[]>();

  private readonly documents: DocumentRegistry;
  private readonly options: EditorRegistryOptions;

  constructor(documents: DocumentRegistry, options: EditorRegistryOptions = {}) {
    this.documents = documents;
    this.options = options;
  }

  /** The `edit()` an editor exposes. The callback runs synchronously and
   *  everything it collected is applied as one operation — that is what
   *  makes it a single undo step for the user. */
  private editFor(uri: string): (callback: (builder: TextEditorEdit) => void) => Promise<boolean> {
    return async (callback) => {
      const builder = new TextEditorEdit();
      callback(builder);
      const edits = builder.close();
      if (edits.length === 0) return true;
      if (!this.options.applyEdit) return false;
      const edit = new WorkspaceEdit();
      edit.set(uri, edits);
      return this.options.applyEdit(edit);
    };
  }

  get visibleTextEditors(): TextEditorLike[] {
    return [...this.editors.values()];
  }

  get activeTextEditor(): TextEditorLike | undefined {
    return this.activeUri ? this.editors.get(this.activeUri) : undefined;
  }

  get onDidChangeActiveTextEditor(): Event<TextEditorLike | undefined> {
    return this.onActive.event;
  }

  get onDidChangeTextEditorSelection(): Event<TextEditorSelectionChangeEvent> {
    return this.onSelection.event;
  }

  get onDidChangeVisibleTextEditors(): Event<readonly TextEditorLike[]> {
    return this.onVisible.event;
  }

  /** Replaces the whole editor layout. The renderer sends the full picture
   *  rather than deltas: there are a handful of editors, and reconciling a
   *  list is cheaper to get right than a stream of moves. */
  sync(states: EditorState[], activeUri: string | null): void {
    const seen = new Set<string>();
    let visibleChanged = false;
    let selectionChanged: TextEditorLike | null = null;

    for (const state of states) {
      const document = this.documents.get(state.uri);
      // No document, no editor: `editor.document` has to be the same object
      // the extension already has.
      if (!document) continue;
      seen.add(state.uri);

      const selections = state.selections.length > 0
        ? state.selections.map(toSelection)
        : [new Selection(0, 0, 0, 0)];
      const visibleRanges = (state.visibleRanges ?? []).map(
        (range) => new Range(range.startLine, 0, range.endLine, 0),
      );

      const existing = this.editors.get(state.uri);
      if (!existing) {
        this.editors.set(state.uri, {
          document,
          selection: selections[0],
          selections,
          visibleRanges,
          viewColumn: state.viewColumn,
          edit: this.editFor(state.uri),
        });
        visibleChanged = true;
        continue;
      }

      if (!sameSelections(existing.selections, selections)) {
        existing.selection = selections[0];
        existing.selections = selections;
        selectionChanged = existing;
      }
      existing.visibleRanges = visibleRanges;
      existing.viewColumn = state.viewColumn;
      // The document object may have been replaced by a re-open.
      existing.document = document;
    }

    for (const uri of [...this.editors.keys()]) {
      if (!seen.has(uri)) {
        this.editors.delete(uri);
        visibleChanged = true;
      }
    }

    const nextActive = activeUri && this.editors.has(activeUri) ? activeUri : null;
    const activeChanged = nextActive !== this.activeUri;
    this.activeUri = nextActive;

    if (visibleChanged) this.onVisible.fire(this.visibleTextEditors);
    if (selectionChanged) {
      this.onSelection.fire({
        textEditor: selectionChanged,
        selections: selectionChanged.selections,
        kind: undefined,
      });
    }
    if (activeChanged) this.onActive.fire(this.activeTextEditor);
  }

  dispose(): void {
    this.editors.clear();
    this.activeUri = null;
    this.onActive.dispose();
    this.onSelection.dispose();
    this.onVisible.dispose();
  }
}

function toSelection(state: SelectionState): Selection {
  return new Selection(
    state.anchorLine,
    state.anchorCharacter,
    state.activeLine,
    state.activeCharacter,
  );
}

function sameSelections(current: readonly Selection[], next: readonly Selection[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((selection, index) => (
    selection.isEqual(next[index])
    && selection.active.isEqual(next[index].active)
  ));
}
