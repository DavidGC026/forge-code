import { ExtensionFileSystemError } from './extension-file-system';
import type { ExtensionFileSystemPort } from './extension-file-system';
import { isInside } from '../domain/file-access';
import { compileWorkspaceGlob, joinResource } from '../domain/workspace-glob';
import type { WorkspaceGlob } from '../domain/workspace-glob';
import { RpcError } from '../domain/rpc-protocol';

export interface FileScanOptions {
  fs: ExtensionFileSystemPort;
  root: string;
  include: WorkspaceGlob;
  excludes: WorkspaceGlob[];
  authorise: (target: string) => Promise<string>;
  cancelled: () => boolean;
  directories?: boolean;
  maxResults?: number;
  maxEntries?: number;
}

export interface ScannedFile { uri: string; stamp: string }

export function assertNotCancelled(cancelled: () => boolean): void {
  if (cancelled()) throw new RpcError('CANCELLED', 'Búsqueda cancelada.');
}

/** No symlinks are followed. A partial snapshot must never look like deletions. */
export async function scanWorkspaceFiles(options: FileScanOptions): Promise<ScannedFile[]> {
  const { fs, root, cancelled } = options;
  const include = matcher(options.include, root);
  const excludes = options.excludes.map((glob) => matcher(glob, root));
  const queue = [{ uri: root, depth: 0 }];
  const found: ScannedFile[] = [];
  let visited = 0;
  if (options.maxResults === 0) return found;

  for (let cursor = 0; cursor < queue.length; cursor++) {
    assertNotCancelled(cancelled);
    const { uri, depth } = queue[cursor];
    const canonical = await options.authorise(await fs.realpath(uri));
    assertNotCancelled(cancelled);
    if (!isInside(root, canonical)) continue;
    let directory;
    try { directory = await fs.stat(canonical); }
    catch (err) {
      if (err instanceof ExtensionFileSystemError && err.code === 'FileNotFound') continue;
      throw err;
    }
    assertNotCancelled(cancelled);
    if (directory.type & 64) continue;
    if (!(directory.type & 2)) throw new ExtensionFileSystemError('FileNotADirectory', uri);
    let entries;
    try { entries = await fs.readDirectory(canonical); }
    catch (err) {
      if (err instanceof ExtensionFileSystemError && err.code === 'FileNotFound') continue;
      throw err;
    }
    assertNotCancelled(cancelled);
    for (const entry of entries) {
      if (++visited > (options.maxEntries ?? 20_000)) {
        throw new ExtensionFileSystemError('Unavailable', 'El recorrido supera el límite de 20000 entradas.');
      }
      if (visited % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      assertNotCancelled(cancelled);
      // A provider returns names, never paths. Reject separators and dot
      // entries before joining so a malformed provider cannot escape its root.
      if (!entry.name || /[\\/\0]/.test(entry.name) || entry.name === '.' || entry.name === '..'
        || (entry.type & 64)) continue;
      const target = joinResource(uri, entry.name);
      if (excludes.some((match) => match(target) || ((entry.type & 2) && match(`${target}/`)))) continue;
      let real: string;
      try {
        real = await fs.realpath(target);
        assertNotCancelled(cancelled);
        if (!isInside(root, real)) continue;
        await options.authorise(real);
      } catch (err) {
        if (err instanceof ExtensionFileSystemError
          && (err.code === 'NoPermissions' || err.code === 'FileNotFound')) continue;
        throw err;
      }
      assertNotCancelled(cancelled);
      let stat;
      try { stat = await fs.stat(real); }
      catch (err) {
        if (err instanceof ExtensionFileSystemError && err.code === 'FileNotFound') continue;
        throw err;
      }
      assertNotCancelled(cancelled);
      if (stat.type & 64) continue;
      const isDirectory = Boolean(stat.type & 2);
      if (include(target) && (!isDirectory || options.directories)) {
        found.push({ uri: target, stamp: `${stat.type}:${stat.mtime}:${stat.ctime}:${stat.size}` });
        if (found.length >= (options.maxResults ?? Infinity)) return found;
      }
      if (isDirectory) {
        if (depth >= 64) throw new ExtensionFileSystemError('Unavailable', 'El recorrido supera 64 niveles.');
        queue.push({ uri: target, depth: depth + 1 });
      }
    }
  }
  return found;
}

function matcher(glob: WorkspaceGlob, root: string): (target: string) => boolean {
  const base = glob.base ?? root;
  const expression = compileWorkspaceGlob(glob.pattern);
  return (target) => {
    if (!isInside(base, target)) return false;
    const relative = target.slice(base.length).replace(/^\//, '');
    return expression.test(base.startsWith('ssh://') ? decodeURI(relative) : relative);
  };
}
