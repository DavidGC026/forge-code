import { CancellationError, Disposable, EventEmitter, Uri } from './primitives';
import type { CancellationToken } from './primitives';
import { toFileSystemError } from './workspace-fs';
import type { WorkspaceFileEvent } from '../../extensions/domain/workspace-glob';
import { resourcePath, resourceUri } from './resource-uri';
export { resourcePath, resourceUri } from './resource-uri';

export class RelativePattern {
  baseUri: Uri;
  pattern: string;
  constructor(base: string | Uri | { uri: Uri }, pattern: string) {
    this.baseUri = typeof base === 'string' ? resourceUri(base) : base instanceof Uri ? base : base.uri;
    this.pattern = pattern;
  }
  get base(): string { return this.baseUri.fsPath; }
  set base(value: string) { this.baseUri = Uri.file(value); }
}

export type GlobPattern = string | RelativePattern;
interface WorkspaceFilesBridge {
  request: (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  warn: (message: string) => void;
}

function serializeGlob(glob: GlobPattern): unknown {
  if (typeof glob === 'string') return glob;
  if (!glob?.baseUri || typeof glob.pattern !== 'string') throw new TypeError('GlobPattern inválido.');
  return { base: resourcePath(glob.baseUri), pattern: glob.pattern };
}

export class HostFileSystemWatcher {
  readonly ignoreCreateEvents: boolean;
  readonly ignoreChangeEvents: boolean;
  readonly ignoreDeleteEvents: boolean;
  private readonly creates = new EventEmitter<Uri>();
  private readonly changes = new EventEmitter<Uri>();
  private readonly deletes = new EventEmitter<Uri>();
  readonly onDidCreate = this.creates.event;
  readonly onDidChange = this.changes.event;
  readonly onDidDelete = this.deletes.event;
  private disposed = false;

  constructor(readonly id: string, flags: boolean[], private readonly release: () => void) {
    [this.ignoreCreateEvents, this.ignoreChangeEvents, this.ignoreDeleteEvents] = flags;
  }
  accept(event: WorkspaceFileEvent): void {
    if (this.disposed) return;
    const uri = resourceUri(event.uri);
    if (event.kind === 'create' && !this.ignoreCreateEvents) this.creates.fire(uri);
    if (event.kind === 'change' && !this.ignoreChangeEvents) this.changes.fire(uri);
    if (event.kind === 'delete' && !this.ignoreDeleteEvents) this.deletes.fire(uri);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.creates.dispose(); this.changes.dispose(); this.deletes.dispose();
    this.release();
  }
}

/** Owned even when an extension forgets context.subscriptions. */
export class HostWorkspaceFiles {
  private sequence = 0;
  private touched = false;
  private disposed = false;
  private readonly watchers = new Map<string, HostFileSystemWatcher>();
  private readonly searches = new Map<string, () => void>();
  constructor(private readonly bridge: WorkspaceFilesBridge) {}

  createFileSystemWatcher = (glob: GlobPattern, ignoreCreateEvents = false,
    ignoreChangeEvents = false, ignoreDeleteEvents = false): HostFileSystemWatcher => {
    if (this.disposed) throw new CancellationError();
    const serialized = serializeGlob(glob);
    this.touched = true;
    const id = `watch-${++this.sequence}`;
    const watcher = new HostFileSystemWatcher(id,
      [ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents], () => {
        this.watchers.delete(id);
        void this.bridge.request('unwatch', { id }).catch((err) => this.bridge.warn(String(err)));
      });
    this.watchers.set(id, watcher);
    // The public API is synchronous. Registration failures are reported and
    // the unusable watcher is disposed; no floating rejected promise escapes.
    void this.bridge.request('watch', { id, glob: serialized,
      ignorecreate: ignoreCreateEvents, ignorechange: ignoreChangeEvents, ignoredelete: ignoreDeleteEvents,
    }).catch((err) => { this.bridge.warn(`createFileSystemWatcher: ${String(err)}`); watcher.dispose(); });
    return watcher;
  };

  findFiles = async (include: GlobPattern, exclude?: GlobPattern | null, maxResults?: number,
    token?: CancellationToken): Promise<Uri[]> => {
    if (this.disposed || token?.isCancellationRequested) throw new CancellationError();
    this.touched = true;
    const id = `find-${++this.sequence}`;
    const body = { id, include: serializeGlob(include),
      ...(exclude === undefined ? {} : { exclude: exclude === null ? null : serializeGlob(exclude) }),
      ...(maxResults === undefined ? {} : { maxResults }) };
    let cancel: () => void = () => undefined;
    let subscription: Disposable | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => {
        reject(new CancellationError());
        void this.bridge.request('cancel', { id }).catch((err) => this.bridge.warn(String(err)));
      };
    });
    this.searches.set(id, cancel);
    try {
      // Send the search first so a synchronous cancellation cannot overtake it.
      const request = this.bridge.request('find', body);
      subscription = token?.onCancellationRequested(cancel);
      if (token?.isCancellationRequested) cancel();
      const answer = await Promise.race([request, cancelled]) as { uris?: string[] } | null;
      if (token?.isCancellationRequested) throw new CancellationError();
      return (answer?.uris ?? []).map(resourceUri);
    } catch (err) {
      if (err instanceof CancellationError || (err as { code?: string })?.code === 'CANCELLED') {
        throw new CancellationError();
      }
      if ((err as { data?: { code?: string } })?.data?.code) throw toFileSystemError(err);
      throw err;
    } finally { subscription?.dispose(); this.searches.delete(id); }
  };

  accept(event: WorkspaceFileEvent): void { this.watchers.get(event.id)?.accept(event); }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.touched) return;
    this.touched = false;
    for (const watcher of this.watchers.values()) watcher.dispose();
    for (const cancel of this.searches.values()) cancel();
    this.searches.clear();
    await this.bridge.request('disposeOwner', {}).catch((err) => this.bridge.warn(String(err)));
  }

  resume(): void { this.disposed = false; }
}
