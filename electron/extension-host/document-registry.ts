/**
 * The documents the host knows about, and the events extensions subscribe to.
 *
 * Main is the source of truth (it mirrors the renderer); this side keeps the
 * `TextDocument` instances and fires `onDidOpen/Change/Save/Close`. Two
 * decisions matter:
 *
 * - **A document instance is stable.** An extension stores the document it
 *   was handed in `onDidOpenTextDocument` and reads it later; handing out a
 *   new object on every change would freeze its view of the file without any
 *   error to explain it.
 * - **Events are shared by every extension**, but each subscription belongs
 *   to the extension that made it, so `deactivate` takes its listeners with
 *   it (the ownership pattern of `HostCommandRegistry`).
 */
import { EventEmitter } from './vscode-api/primitives';
import type { Event } from './vscode-api/primitives';
import { TextDocument } from './vscode-api/text-document';
import type { TextDocumentState } from './vscode-api/text-document';

export interface TextDocumentChangeEvent {
  document: TextDocument;
  /** Forge syncs whole content (design §4), so the granular list is empty
   *  rather than fabricated: an extension that inspects it must see "no
   *  detail available", not invented ranges. */
  contentChanges: readonly never[];
  reason: undefined;
}

export class DocumentRegistry {
  private readonly documents = new Map<string, TextDocument>();
  private readonly onOpen = new EventEmitter<TextDocument>();
  private readonly onChange = new EventEmitter<TextDocumentChangeEvent>();
  private readonly onSave = new EventEmitter<TextDocument>();
  private readonly onClose = new EventEmitter<TextDocument>();
  private readonly requestSave: ((uri: string) => Promise<boolean>) | null;

  constructor(requestSave?: (uri: string) => Promise<boolean>) {
    this.requestSave = requestSave ?? null;
  }

  get textDocuments(): TextDocument[] {
    return [...this.documents.values()];
  }

  get onDidOpenTextDocument(): Event<TextDocument> {
    return this.onOpen.event;
  }

  get onDidChangeTextDocument(): Event<TextDocumentChangeEvent> {
    return this.onChange.event;
  }

  get onDidSaveTextDocument(): Event<TextDocument> {
    return this.onSave.event;
  }

  get onDidCloseTextDocument(): Event<TextDocument> {
    return this.onClose.event;
  }

  get(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  /** Seeds the registry without firing events: this is the state that
   *  already existed when the host started, not something that happened. */
  reset(states: TextDocumentState[]): void {
    this.documents.clear();
    for (const state of states) {
      this.documents.set(state.uri, this.create(state));
    }
  }

  open(state: TextDocumentState): TextDocument {
    const existing = this.documents.get(state.uri);
    if (existing) {
      // A re-open of something already tracked is a change, not a second
      // open: firing `onDidOpen` twice makes extensions register duplicates.
      existing.update(state);
      this.onChange.fire({ document: existing, contentChanges: [], reason: undefined });
      return existing;
    }
    const document = this.create(state);
    this.documents.set(state.uri, document);
    this.onOpen.fire(document);
    return document;
  }

  change(uri: string, state: Partial<TextDocumentState>): TextDocument | null {
    const document = this.documents.get(uri);
    // A change for something never opened is dropped: inventing the document
    // here would give extensions a file with no `onDidOpen` behind it.
    if (!document) return null;
    document.update(state);
    this.onChange.fire({ document, contentChanges: [], reason: undefined });
    return document;
  }

  save(uri: string, state?: Partial<TextDocumentState>): TextDocument | null {
    const document = this.documents.get(uri);
    if (!document) return null;
    document.update({ ...state, isDirty: false });
    this.onSave.fire(document);
    return document;
  }

  close(uri: string): TextDocument | null {
    const document = this.documents.get(uri);
    if (!document) return null;
    this.documents.delete(uri);
    document.update({ isClosed: true });
    this.onClose.fire(document);
    return document;
  }

  /** Documents opened by `workspace.openTextDocument` for a file with no
   *  editor: they are readable but never fire lifecycle events. */
  adopt(state: TextDocumentState): TextDocument {
    const existing = this.documents.get(state.uri);
    if (existing) return existing;
    const document = this.create(state);
    this.documents.set(state.uri, document);
    this.onOpen.fire(document);
    return document;
  }

  dispose(): void {
    this.documents.clear();
    this.onOpen.dispose();
    this.onChange.dispose();
    this.onSave.dispose();
    this.onClose.dispose();
  }

  private create(state: TextDocumentState): TextDocument {
    return new TextDocument(state, (document) => (
      this.requestSave ? this.requestSave(document.fileName) : Promise.resolve(false)
    ));
  }
}
