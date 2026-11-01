/**
 * `ExtensionFileSystemPort` over the real filesystem.
 *
 * Local paths go through `fs.promises`. Remote (SSH) workspaces go through
 * a bridge main injects, because the SSH plumbing lives with the rest of
 * the remote workspace code and pulling it in here would tie this module —
 * and the whole extension subsystem — to it.
 *
 * When a remote path arrives and no bridge is configured, the answer is a
 * typed `Unavailable`, never a silent local read: resolving a remote URI
 * against the local filesystem is how an extension ends up reading the
 * wrong machine's files.
 */
import fs from 'fs';
import path from 'path';
import { ExtensionFileSystemError } from '../application/extension-file-system';
import type {
  ExtensionDirectoryEntry,
  ExtensionFileStat,
  ExtensionFileSystemPort,
} from '../application/extension-file-system';

/** `vscode.FileType` values. Kept local so this module does not depend on
 *  the host-side enum table. */
const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;

/** The subset of remote operations `workspace.fs` needs. Main implements it
 *  with the same SSH helpers the workbench already uses. */
export interface RemoteFileSystemBridge {
  isRemote(target: string): boolean;
  /** Canonical resource URI, resolved on the remote machine. */
  realpath?(target: string): Promise<string>;
  stat(target: string): Promise<ExtensionFileStat>;
  readFile(target: string): Promise<Uint8Array>;
  writeFile(target: string, data: Uint8Array): Promise<void>;
  readDirectory(target: string): Promise<ExtensionDirectoryEntry[]>;
  createDirectory(target: string): Promise<void>;
  delete(target: string, options: { recursive: boolean }): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
}

export interface NodeExtensionFileSystemOptions {
  remote?: RemoteFileSystemBridge | null;
}

export class NodeExtensionFileSystem implements ExtensionFileSystemPort {
  constructor(private readonly options: NodeExtensionFileSystemOptions = {}) {}

  private remoteFor(target: string): RemoteFileSystemBridge | null {
    const remote = this.options.remote;
    if (remote?.isRemote(target)) return remote;
    // A remote-looking URI with no bridge must not fall through to the
    // local filesystem.
    if (looksRemote(target)) {
      throw new ExtensionFileSystemError(
        'Unavailable',
        `El workspace remoto no está disponible para "${target}".`,
      );
    }
    return null;
  }

  async realpath(target: string): Promise<string> {
    const remote = this.remoteFor(target);
    if (remote) {
      if (remote.realpath) return remote.realpath(target);
      throw new ExtensionFileSystemError('Unavailable', 'El puente remoto no resuelve enlaces simbólicos.');
    }
    return this.resolveLocalPath(target, 0);
  }

  private async resolveLocalPath(target: string, depth: number): Promise<string> {
    if (depth > 64) throw new ExtensionFileSystemError('Unavailable', 'Demasiados enlaces o niveles de ruta.');
    try {
      return await fs.promises.realpath(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw translate(err, target);
      // Resolve the closest existing ancestor too. Otherwise writing a new
      // child through `workspace/link-out/new.txt` would bypass the policy.
      const absolute = path.resolve(target);
      let link;
      try { link = await fs.promises.lstat(absolute); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw translate(missing, target);
      }
      // realpath reports ENOENT for a dangling symlink too. Resolving only
      // its parent would authorise the link name and write to its target.
      if (link?.isSymbolicLink()) {
        const destination = await fs.promises.readlink(absolute);
        return this.resolveLocalPath(path.resolve(path.dirname(absolute), destination), depth + 1);
      }
      const parent = path.dirname(absolute);
      if (parent === absolute) return absolute;
      return path.join(await this.resolveLocalPath(parent, depth + 1), path.basename(absolute));
    }
  }

  async stat(target: string): Promise<ExtensionFileStat> {
    const remote = this.remoteFor(target);
    if (remote) return remote.stat(target);
    try {
      const stats = await fs.promises.lstat(target);
      let type = stats.isDirectory() ? DIRECTORY : FILE;
      if (stats.isSymbolicLink()) type |= SYMLINK;
      return {
        type,
        ctime: stats.ctimeMs,
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch (err) {
      throw translate(err, target);
    }
  }

  async readFile(target: string): Promise<Uint8Array> {
    const remote = this.remoteFor(target);
    if (remote) return remote.readFile(target);
    try {
      return new Uint8Array(await fs.promises.readFile(target));
    } catch (err) {
      throw translate(err, target);
    }
  }

  async writeFile(
    target: string,
    data: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const remote = this.remoteFor(target);
    if (remote) return remote.writeFile(target, data);
    try {
      const exists = await this.exists(target);
      if (exists && !options.overwrite) {
        throw new ExtensionFileSystemError('FileExists', `"${target}" ya existe.`);
      }
      if (!exists && !options.create) {
        throw new ExtensionFileSystemError('FileNotFound', `"${target}" no existe.`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, data);
    } catch (err) {
      throw translate(err, target);
    }
  }

  async readDirectory(target: string): Promise<ExtensionDirectoryEntry[]> {
    const remote = this.remoteFor(target);
    if (remote) return remote.readDirectory(target);
    try {
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      return entries.map((entry) => {
        let type = entry.isDirectory() ? DIRECTORY : FILE;
        if (entry.isSymbolicLink()) type |= SYMLINK;
        return { name: entry.name, type };
      });
    } catch (err) {
      throw translate(err, target);
    }
  }

  async createDirectory(target: string): Promise<void> {
    const remote = this.remoteFor(target);
    if (remote) return remote.createDirectory(target);
    try {
      await fs.promises.mkdir(target, { recursive: true });
    } catch (err) {
      throw translate(err, target);
    }
  }

  async delete(target: string, options: { recursive: boolean }): Promise<void> {
    const remote = this.remoteFor(target);
    if (remote) return remote.delete(target, options);
    try {
      const stats = await fs.promises.lstat(target);
      if (stats.isDirectory() && !options.recursive) {
        // Node would happily fail with ENOTEMPTY; saying it in the API's own
        // vocabulary is what lets the extension react.
        const entries = await fs.promises.readdir(target);
        if (entries.length > 0) {
          throw new ExtensionFileSystemError(
            'NoPermissions',
            `"${target}" no está vacío: usa recursive.`,
          );
        }
      }
      await fs.promises.rm(target, { recursive: options.recursive, force: false });
    } catch (err) {
      throw translate(err, target);
    }
  }

  async rename(
    source: string,
    destination: string,
    options: { overwrite: boolean },
  ): Promise<void> {
    const remote = this.remoteFor(source) ?? this.remoteFor(destination);
    if (remote) return remote.rename(source, destination);
    try {
      if (!options.overwrite && await this.exists(destination)) {
        throw new ExtensionFileSystemError('FileExists', `"${destination}" ya existe.`);
      }
      await fs.promises.rename(source, destination);
    } catch (err) {
      throw translate(err, source);
    }
  }

  async copy(
    source: string,
    destination: string,
    options: { overwrite: boolean },
  ): Promise<void> {
    const remote = this.remoteFor(source) ?? this.remoteFor(destination);
    if (remote) return remote.copy(source, destination);
    try {
      if (!options.overwrite && await this.exists(destination)) {
        throw new ExtensionFileSystemError('FileExists', `"${destination}" ya existe.`);
      }
      await fs.promises.cp(source, destination, {
        recursive: true,
        force: options.overwrite,
        errorOnExist: !options.overwrite,
      });
    } catch (err) {
      throw translate(err, source);
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.promises.lstat(target);
      return true;
    } catch {
      return false;
    }
  }
}

function looksRemote(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target) && !target.startsWith('file://');
}

/** Node errno → `FileSystemError` code, so extensions can branch on the
 *  same codes they would in VS Code. */
function translate(err: unknown, target: string): Error {
  if (err instanceof ExtensionFileSystemError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'ENOENT':
      return new ExtensionFileSystemError('FileNotFound', `"${target}" no existe.`);
    case 'EEXIST':
      return new ExtensionFileSystemError('FileExists', `"${target}" ya existe.`);
    case 'ENOTDIR':
      return new ExtensionFileSystemError('FileNotADirectory', `"${target}" no es un directorio.`);
    case 'EISDIR':
      return new ExtensionFileSystemError('FileIsADirectory', `"${target}" es un directorio.`);
    case 'EACCES':
    case 'EPERM':
      return new ExtensionFileSystemError('NoPermissions', `Sin permisos sobre "${target}".`);
    default:
      return new ExtensionFileSystemError(
        'Unavailable',
        `No se pudo operar sobre "${target}": ${(err as Error)?.message ?? String(err)}`,
      );
  }
}
