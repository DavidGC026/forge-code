/**
 * Main's mirror of the renderer's open buffers.
 *
 * Main does not own text — Monaco does — so this is a replica kept in step
 * by events, and its whole purpose is answering one question correctly: what
 * does the *user* see in this file right now. An extension reading a file
 * with unsaved changes must get the buffer, not the disk (design §1).
 *
 * The mirror also decides what reaches the host. Two rules:
 *
 * - **Versions come from the renderer**, never invented here. They are what
 *   makes a future `WorkspaceEdit` verifiable, and a version main made up
 *   would validate an edit against a revision that never existed.
 * - **An out-of-order event is dropped, not applied.** IPC preserves order
 *   per channel, but a stale `change` arriving after a `close` (or after a
 *   newer version) must not resurrect or rewind a document.
 */

export interface MirroredDocument {
  uri: string;
  languageId: string;
  version: number;
  content: string;
  isDirty: boolean;
}

export type DocumentSyncEvent =
  | { kind: 'open'; document: MirroredDocument }
  | { kind: 'change'; uri: string; version: number; content: string; isDirty?: boolean }
  | { kind: 'save'; uri: string; version?: number; content?: string }
  | { kind: 'close'; uri: string };

export interface DocumentMirrorOptions {
  /** Relays one event to the host. Failures are reported, never thrown: the
   *  user typing must not fail because the host is restarting. */
  notifyHost?: (event: DocumentSyncEvent, document: MirroredDocument | null) => void;
  log?: (message: string) => void;
}

export class DocumentMirror {
  private readonly documents = new Map<string, MirroredDocument>();

  constructor(private readonly options: DocumentMirrorOptions = {}) {}

  /** Snapshot for the handshake: what is already open when a generation
   *  starts is state, not a sequence of events to replay. */
  snapshot(): MirroredDocument[] {
    return [...this.documents.values()].map((document) => ({ ...document }));
  }

  get(uri: string): MirroredDocument | null {
    const document = this.documents.get(uri);
    return document ? { ...document } : null;
  }

  /** Content the user sees, or null when the file is not open. Callers fall
   *  back to disk on null — and only then. */
  contentOf(uri: string): string | null {
    return this.documents.get(uri)?.content ?? null;
  }

  apply(event: DocumentSyncEvent): void {
    switch (event.kind) {
      case 'open': {
        const document = { ...event.document };
        this.documents.set(document.uri, document);
        this.publish(event, document);
        return;
      }
      case 'change': {
        const current = this.documents.get(event.uri);
        if (!current) {
          // A change for something we never saw open: dropping it keeps the
          // mirror honest, and the next `open` will carry the full content.
          this.log(`cambio descartado para "${event.uri}": no está abierto`);
          return;
        }
        if (event.version <= current.version) {
          this.log(`cambio obsoleto descartado para "${event.uri}" (v${event.version})`);
          return;
        }
        current.version = event.version;
        current.content = event.content;
        current.isDirty = event.isDirty ?? true;
        this.publish(event, current);
        return;
      }
      case 'save': {
        const current = this.documents.get(event.uri);
        if (!current) return;
        if (typeof event.content === 'string') current.content = event.content;
        if (typeof event.version === 'number' && event.version > current.version) {
          current.version = event.version;
        }
        current.isDirty = false;
        this.publish(event, current);
        return;
      }
      case 'close': {
        const current = this.documents.get(event.uri);
        if (!current) return;
        this.documents.delete(event.uri);
        this.publish(event, current);
      }
    }
  }

  /** Drops everything. Used when the workspace changes: the buffers of the
   *  previous folder are not this session's documents. */
  clear(): void {
    this.documents.clear();
  }

  private publish(event: DocumentSyncEvent, document: MirroredDocument | null): void {
    try {
      this.options.notifyHost?.(event, document ? { ...document } : null);
    } catch (err) {
      this.log(`no se pudo notificar al host: ${(err as Error).message}`);
    }
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

/** Validates what arrives from the renderer at the boundary. Anything
 *  malformed is dropped rather than half-applied. */
export function parseDocumentSyncEvent(value: unknown): DocumentSyncEvent | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const uri = typeof raw.uri === 'string' ? raw.uri : '';

  switch (raw.kind) {
    case 'open': {
      const document = raw.document;
      if (document === null || typeof document !== 'object') return null;
      const body = document as Record<string, unknown>;
      if (typeof body.uri !== 'string' || !body.uri) return null;
      return {
        kind: 'open',
        document: {
          uri: body.uri,
          languageId: typeof body.languageId === 'string' ? body.languageId : 'plaintext',
          version: typeof body.version === 'number' ? body.version : 1,
          content: typeof body.content === 'string' ? body.content : '',
          isDirty: body.isDirty === true,
        },
      };
    }
    case 'change':
      if (!uri || typeof raw.version !== 'number' || typeof raw.content !== 'string') return null;
      return {
        kind: 'change',
        uri,
        version: raw.version,
        content: raw.content,
        isDirty: raw.isDirty === true,
      };
    case 'save':
      if (!uri) return null;
      return {
        kind: 'save',
        uri,
        ...(typeof raw.version === 'number' ? { version: raw.version } : {}),
        ...(typeof raw.content === 'string' ? { content: raw.content } : {}),
      };
    case 'close':
      return uri ? { kind: 'close', uri } : null;
    default:
      return null;
  }
}
