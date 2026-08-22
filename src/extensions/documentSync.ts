// ── Buffer mirroring for the Extension Host (renderer) ──────────────────
//
// Keeps main's `DocumentMirror` in step with what the user is actually
// looking at. Versions are minted here because the renderer is the only
// place that knows the order in which the buffer really changed; main takes
// them as given and a future `WorkspaceEdit` verifies against them.
//
// Changes are debounced, and content travels whole. That is the same
// strategy `src/lsp/client.ts` already uses to keep the language server in
// step, and reusing it avoids a second, differently-behaved notion of "the
// current text" for the same file.
//
// Erasable TypeScript with injected collaborators, like the rest of
// `src/extensions/`: it is tested with `node --test` and no DOM.

export interface DocumentSyncEventPayload {
  kind: 'open' | 'change' | 'save' | 'close';
  [key: string]: unknown;
}

export interface DocumentSyncOptions {
  /** Sends one event to main. Injected, so tests need no IPC. */
  send: (event: DocumentSyncEventPayload) => void;
  /** Debounce window for `change`. */
  debounceMs?: number;
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface TrackedDocument {
  uri: string;
  languageId: string;
  version: number;
  /** Last content actually sent, to skip no-op changes. */
  sentContent: string;
  pendingContent: string | null;
  timer: unknown;
}

export class DocumentSyncService {
  private readonly documents = new Map<string, TrackedDocument>();
  private readonly options: Required<Omit<DocumentSyncOptions, 'send'>> & {
    send: (event: DocumentSyncEventPayload) => void;
  };

  constructor(options: DocumentSyncOptions) {
    this.options = {
      send: options.send,
      // Long enough that a burst of typing is one event, short enough that
      // an extension reacting to edits does not feel stale.
      debounceMs: options.debounceMs ?? 300,
      setTimer: options.setTimer ?? ((handler, delay) => setTimeout(handler, delay)),
      clearTimer: options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  /** Buffers currently mirrored. */
  get tracked(): string[] {
    return [...this.documents.keys()];
  }

  open(uri: string, languageId: string, content: string, isDirty = false): void {
    const existing = this.documents.get(uri);
    if (existing) {
      // Re-opening a tracked file is a change: `didOpen` twice makes
      // extensions register duplicate listeners for the same document.
      this.change(uri, content, isDirty);
      return;
    }
    this.documents.set(uri, {
      uri,
      languageId,
      version: 1,
      sentContent: content,
      pendingContent: null,
      timer: null,
    });
    this.options.send({
      kind: 'open',
      document: { uri, languageId, version: 1, content, isDirty },
    });
  }

  change(uri: string, content: string, isDirty = true): void {
    const document = this.documents.get(uri);
    if (!document) return;
    // Monaco fires for programmatic writes too (agents streaming into a
    // buffer, for one); an identical content is not a change.
    if (content === document.sentContent && document.pendingContent === null) return;

    document.pendingContent = content;
    if (document.timer !== null) this.options.clearTimer(document.timer);
    document.timer = this.options.setTimer(() => {
      document.timer = null;
      const pending = document.pendingContent;
      document.pendingContent = null;
      if (pending === null || pending === document.sentContent) return;
      document.version += 1;
      document.sentContent = pending;
      this.options.send({
        kind: 'change',
        uri,
        version: document.version,
        content: pending,
        isDirty,
      });
    }, this.options.debounceMs);
  }

  /** Sends whatever is pending right now. Called before events where being
   *  behind would be wrong — a save, mostly. */
  flush(uri: string): void {
    const document = this.documents.get(uri);
    if (!document || document.timer === null) return;
    this.options.clearTimer(document.timer);
    document.timer = null;
    const pending = document.pendingContent;
    document.pendingContent = null;
    if (pending === null || pending === document.sentContent) return;
    document.version += 1;
    document.sentContent = pending;
    this.options.send({
      kind: 'change',
      uri,
      version: document.version,
      content: pending,
      isDirty: true,
    });
  }

  save(uri: string, content?: string): void {
    const document = this.documents.get(uri);
    if (!document) return;
    // The save must not race a pending change: an extension reacting to
    // `onDidSave` reads the document, and it has to be the saved text.
    this.flush(uri);
    if (typeof content === 'string' && content !== document.sentContent) {
      document.version += 1;
      document.sentContent = content;
    }
    this.options.send({
      kind: 'save',
      uri,
      version: document.version,
      content: document.sentContent,
    });
  }

  close(uri: string): void {
    const document = this.documents.get(uri);
    if (!document) return;
    if (document.timer !== null) this.options.clearTimer(document.timer);
    this.documents.delete(uri);
    this.options.send({ kind: 'close', uri });
  }

  /** Reconciles the tracked set against the tabs that are actually open.
   *  One call handles both new tabs and closed ones, which is what keeps
   *  this from drifting when a tab disappears without notice. */
  syncOpenDocuments(
    tabs: readonly { path: string; language: string; content: string; isUnsaved?: boolean }[],
  ): void {
    const alive = new Set<string>();
    for (const tab of tabs) {
      if (!tab.path) continue;
      alive.add(tab.path);
      if (this.documents.has(tab.path)) this.change(tab.path, tab.content, tab.isUnsaved === true);
      else this.open(tab.path, tab.language, tab.content, tab.isUnsaved === true);
    }
    for (const uri of this.tracked) {
      if (!alive.has(uri)) this.close(uri);
    }
  }

  /** Drops everything without notifying: used when the workspace changes,
   *  where main clears its own mirror too. */
  reset(): void {
    for (const document of this.documents.values()) {
      if (document.timer !== null) this.options.clearTimer(document.timer);
    }
    this.documents.clear();
  }
}
