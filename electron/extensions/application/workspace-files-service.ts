import { ExtensionFileSystemError } from './extension-file-system';
import type { ExtensionFileSystem, ExtensionFileSystemPort } from './extension-file-system';
import { isInside } from '../domain/file-access';
import { RpcError } from '../domain/rpc-protocol';
import { normalizeResource, parseWorkspaceGlob } from '../domain/workspace-glob';
import type { WorkspaceFileEvent, WorkspaceGlob } from '../domain/workspace-glob';
import { assertNotCancelled, scanWorkspaceFiles } from './workspace-file-scan';
import type { ScannedFile } from './workspace-file-scan';

interface OwnedTask { owner: string; id: string; cancelled: boolean }
interface Watch extends OwnedTask {
  root: string;
  glob: WorkspaceGlob;
  snapshot: Map<string, string>;
  timer: unknown;
  ignored: Set<string>;
}
export interface WorkspaceFilesServiceOptions {
  fs: ExtensionFileSystemPort;
  access: ExtensionFileSystem;
  workspace: () => string | null;
  configuration?: () => Record<string, unknown>;
  emit: (owner: string, event: WorkspaceFileEvent) => void;
  warn?: (message: string) => void;
  pollIntervalMs?: number;
  setTimer?: (handler: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Owns main-side IO, including pending registrations and searches. */
export class WorkspaceFilesService {
  private readonly watches = new Map<string, Watch>();
  private readonly searches = new Map<string, OwnedTask>();
  constructor(private readonly options: WorkspaceFilesServiceOptions) {}

  async handle(owner: string, operation: string, payload: unknown): Promise<unknown> {
    if (!owner) throw new RpcError('INVALID_PAYLOAD', 'La operación requiere una extensión.');
    const body = (payload ?? {}) as Record<string, unknown>;
    if (operation === 'disposeOwner') { this.disposeOwner(owner); return { ok: true }; }
    const id = body.id;
    if (typeof id !== 'string' || !id || id.length > 128) {
      throw new RpcError('INVALID_PAYLOAD', 'La operación requiere un id.');
    }
    const key = this.key(owner, id);
    switch (operation) {
      case 'find': return this.find(owner, id, body);
      case 'cancel': {
        const search = this.searches.get(key);
        if (search) search.cancelled = true;
        return { ok: true };
      }
      case 'watch': return this.watch(owner, id, body);
      case 'unwatch': {
        const watch = this.watches.get(key);
        if (watch) this.release(watch);
        return { ok: true };
      }
      default: throw new RpcError('UNSUPPORTED_API', `workspace.files.${operation} no está soportado.`);
    }
  }

  private async find(owner: string, id: string, body: Record<string, unknown>): Promise<unknown> {
    const key = this.key(owner, id);
    if (this.searches.has(key)) throw new RpcError('INVALID_PAYLOAD', 'Búsqueda duplicada.');
    const task: OwnedTask = { owner, id, cancelled: false };
    this.searches.set(key, task);
    try {
      const glob = parseWorkspaceGlob(body.include);
      const workspace = this.options.workspace();
      if (!workspace) return { uris: [] };
      const root = await this.rootFor(owner, glob.base ?? workspace);
      const workspaceRoot = normalizeResource(await this.options.fs.realpath(workspace));
      if (!isInside(workspaceRoot, root)) {
        throw new ExtensionFileSystemError('NoPermissions', 'findFiles sólo busca dentro del workspace.');
      }
      const maxResults = body.maxResults;
      if (maxResults !== undefined && (!Number.isSafeInteger(maxResults) || (maxResults as number) < 0)) {
        throw new RpcError('INVALID_PAYLOAD', 'maxResults debe ser un entero no negativo.');
      }
      const excludes = body.exclude === undefined ? this.defaultExcludes() : body.exclude === null
        ? [] : [parseWorkspaceGlob(body.exclude)];
      const files = await this.scan(task, root, { ...glob, base: root }, excludes, false, maxResults as number | undefined);
      assertNotCancelled(() => task.cancelled);
      return { uris: files.map((file) => file.uri) };
    } finally { if (this.searches.get(key) === task) this.searches.delete(key); }
  }

  private async watch(owner: string, id: string, body: Record<string, unknown>): Promise<unknown> {
    const key = this.key(owner, id);
    if (this.watches.has(key)) throw new RpcError('INVALID_PAYLOAD', 'Watcher duplicado.');
    if ([...this.watches.values()].filter((watch) => watch.owner === owner).length >= 64) {
      throw new ExtensionFileSystemError('Unavailable', 'Una extensión admite hasta 64 watchers.');
    }
    const glob = parseWorkspaceGlob(body.glob);
    const base = glob.base ?? this.options.workspace();
    const watch: Watch = {
      owner, id, cancelled: false, root: base ?? '', glob,
      snapshot: new Map(), timer: null,
      ignored: new Set(['create', 'change', 'delete'].filter((kind) => body[`ignore${kind}`] === true)),
    };
    // Insert BEFORE the first await: disposal while the initial scan is in
    // flight must cancel that scan and prevent it from scheduling a timer.
    this.watches.set(key, watch);
    try {
      if (base) {
        watch.root = await this.rootFor(owner, base);
        watch.glob = { ...glob, base: watch.root };
        watch.snapshot = snapshot(await this.scan(watch, watch.root, watch.glob, [], true));
      }
      assertNotCancelled(() => watch.cancelled);
      if (base) this.schedule(watch);
      return { ok: true };
    } catch (err) { this.release(watch); throw err; }
  }

  private async rootFor(owner: string, root: string): Promise<string> {
    const normalized = normalizeResource(root);
    const canonical = await this.options.fs.realpath(normalized);
    return this.options.access.authorise(owner, canonical, 'read');
  }

  private scan(task: OwnedTask, root: string, glob: WorkspaceGlob, excludes: WorkspaceGlob[],
    directories: boolean, maxResults?: number): Promise<ScannedFile[]> {
    return scanWorkspaceFiles({
      fs: this.options.fs, root, include: glob, excludes, directories, maxResults,
      authorise: (target) => this.options.access.authorise(task.owner, target, 'read'),
      cancelled: () => task.cancelled,
    });
  }

  private schedule(watch: Watch): void {
    if (watch.cancelled) return;
    const callback = () => { watch.timer = null; return this.poll(watch); };
    watch.timer = this.options.setTimer ? this.options.setTimer(callback, this.options.pollIntervalMs ?? 1000)
      : setTimeout(callback, this.options.pollIntervalMs ?? 1000);
    (watch.timer as { unref?: () => void })?.unref?.();
  }

  private async poll(watch: Watch): Promise<void> {
    try {
      const current = snapshot(await this.scan(watch, watch.root, watch.glob, [], true));
      if (watch.cancelled) return;
      const emit = (kind: WorkspaceFileEvent['kind'], uri: string) => {
        if (!watch.cancelled && !watch.ignored.has(kind)) this.options.emit(watch.owner, { id: watch.id, kind, uri });
      };
      for (const [uri, stamp] of current) {
        if (!watch.snapshot.has(uri)) emit('create', uri);
        else if (watch.snapshot.get(uri) !== stamp) emit('change', uri);
      }
      for (const uri of watch.snapshot.keys()) if (!current.has(uri)) emit('delete', uri);
      watch.snapshot = current;
    } catch (err) {
      // Keep the last COMPLETE snapshot: a transport failure is not a mass
      // deletion. Cancellation is expected during owner/generation cleanup.
      if (!watch.cancelled) this.options.warn?.(`Watcher ${watch.id}: ${(err as Error).message}`);
    } finally { this.schedule(watch); }
  }

  private defaultExcludes(): WorkspaceGlob[] {
    const configured = this.options.configuration?.()['files.exclude'];
    if (!configured || typeof configured !== 'object') return [];
    return Object.entries(configured).filter(([, value]) => value === true)
      .map(([pattern]) => ({ pattern }));
  }

  disposeOwner(owner: string): void {
    for (const watch of this.watches.values()) if (watch.owner === owner) this.release(watch);
    for (const [key, task] of this.searches) if (task.owner === owner) {
      task.cancelled = true;
      this.searches.delete(key);
    }
  }

  dispose(): void {
    for (const watch of this.watches.values()) this.release(watch);
    for (const task of this.searches.values()) task.cancelled = true;
    this.searches.clear();
  }

  private release(watch: Watch): void {
    watch.cancelled = true;
    if (watch.timer !== null) {
      if (this.options.clearTimer) this.options.clearTimer(watch.timer);
      else clearTimeout(watch.timer as ReturnType<typeof setTimeout>);
    }
    watch.timer = null;
    const key = this.key(watch.owner, watch.id);
    if (this.watches.get(key) === watch) this.watches.delete(key);
  }

  private key(owner: string, id: string): string { return JSON.stringify([owner, id]); }
}

function snapshot(files: ScannedFile[]): Map<string, string> {
  return new Map(files.map((file) => [file.uri, file.stamp]));
}
