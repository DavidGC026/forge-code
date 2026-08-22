/**
 * `workspace.fs`, main side.
 *
 * The filesystem itself is a port: Forge already reads and writes through an
 * abstraction that treats local paths and SSH workspaces alike, so plugging
 * that in is what makes the milestone's "local and SSH go through the same
 * URI abstraction" true rather than aspirational.
 *
 * Every operation goes through the same three steps — resolve, authorise,
 * act — and authorisation happens on the *real* path, after symlinks, for
 * the same reason the loader does it: `path.resolve` does not follow links
 * and the filesystem does.
 */
import { checkFileAccess } from '../domain/file-access';
import type {
  FileAccessScopes,
  FileSystemErrorCode,
} from '../domain/file-access';
import { RpcError } from '../domain/rpc-protocol';

export interface ExtensionFileStat {
  /** Bitmask, as `vscode.FileType`: 1 file, 2 directory, 64 symlink. */
  type: number;
  ctime: number;
  mtime: number;
  size: number;
}

export interface ExtensionDirectoryEntry {
  name: string;
  type: number;
}

/** What the service needs from the world. Implemented by the adapter that
 *  already handles local and remote paths. */
export interface ExtensionFileSystemPort {
  /** Resolves symlinks; returns the input when the path does not exist. */
  realpath(target: string): Promise<string>;
  stat(target: string): Promise<ExtensionFileStat>;
  readFile(target: string): Promise<Uint8Array>;
  writeFile(target: string, data: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void>;
  readDirectory(target: string): Promise<ExtensionDirectoryEntry[]>;
  createDirectory(target: string): Promise<void>;
  delete(target: string, options: { recursive: boolean }): Promise<void>;
  rename(source: string, destination: string, options: { overwrite: boolean }): Promise<void>;
  copy(source: string, destination: string, options: { overwrite: boolean }): Promise<void>;
}

/** Typed failure carrying a `vscode.FileSystemError` code, so the host can
 *  rebuild the error class the extension expects to catch. */
export class ExtensionFileSystemError extends Error {
  readonly code: FileSystemErrorCode;

  constructor(code: FileSystemErrorCode, message: string) {
    super(message);
    this.name = 'ExtensionFileSystemError';
    this.code = code;
  }
}

export interface ExtensionFileSystemOptions {
  fs: ExtensionFileSystemPort;
  /** Scopes for one extension, resolved per call: the workspace changes. */
  scopesFor: (extensionId: string) => FileAccessScopes;
  /** Feeds the compatibility report when an extension is refused. */
  onRefused?: (extensionId: string, target: string, message: string) => void;
}

/** Operations and the access they require. Kept as data so no handler can
 *  quietly ask for less than it needs. */
const WRITE_OPERATIONS = new Set([
  'writeFile',
  'createDirectory',
  'delete',
  'rename',
  'copy',
]);

export class ExtensionFileSystem {
  constructor(private readonly options: ExtensionFileSystemOptions) {}

  /** Dispatches one `workspace.fs.*` request. */
  async handle(extensionId: string, operation: string, payload: unknown): Promise<unknown> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const target = typeof body.uri === 'string' ? body.uri : '';

    switch (operation) {
      case 'stat':
        return this.options.fs.stat(await this.authorise(extensionId, target, 'read'));
      case 'readFile': {
        const path = await this.authorise(extensionId, target, 'read');
        return { data: await this.options.fs.readFile(path) };
      }
      case 'readDirectory': {
        const path = await this.authorise(extensionId, target, 'read');
        return { entries: await this.options.fs.readDirectory(path) };
      }
      case 'writeFile': {
        const path = await this.authorise(extensionId, target, 'write');
        await this.options.fs.writeFile(path, toBytes(body.content), {
          create: body.create !== false,
          overwrite: body.overwrite !== false,
        });
        return { ok: true };
      }
      case 'createDirectory': {
        const path = await this.authorise(extensionId, target, 'write');
        await this.options.fs.createDirectory(path);
        return { ok: true };
      }
      case 'delete': {
        const path = await this.authorise(extensionId, target, 'write');
        await this.options.fs.delete(path, { recursive: body.recursive === true });
        return { ok: true };
      }
      case 'rename':
      case 'copy': {
        // Both ends are authorised: reading from an allowed place and
        // writing to a forbidden one is exactly the exfiltration this
        // policy exists to stop.
        const source = await this.authorise(extensionId, target, 'read');
        const destination = await this.authorise(
          extensionId,
          typeof body.target === 'string' ? body.target : '',
          'write',
        );
        const options = { overwrite: body.overwrite === true };
        if (operation === 'rename') await this.options.fs.rename(source, destination, options);
        else await this.options.fs.copy(source, destination, options);
        return { ok: true };
      }
      default:
        throw new RpcError(
          'UNSUPPORTED_API',
          `"workspace.fs.${operation}" no está soportado por Forge.`,
        );
    }
  }

  /** Resolves symlinks, applies the policy and returns the real path. */
  private async authorise(
    extensionId: string,
    target: string,
    mode: 'read' | 'write',
  ): Promise<string> {
    if (!target) {
      throw new ExtensionFileSystemError('FileNotFound', 'La operación requiere una ruta.');
    }
    // Resolving first is what makes a symlink out of the workspace fail:
    // the string looks contained, the real path does not.
    const real = await this.options.fs.realpath(target).catch(() => target);
    const scopes = this.options.scopesFor(extensionId);
    const verdict = checkFileAccess(real, mode, scopes);

    if (!verdict.allowed) {
      this.options.onRefused?.(extensionId, target, verdict.message);
      throw new ExtensionFileSystemError(verdict.code, verdict.message);
    }
    return real;
  }

  /** True when the method belongs to this service. */
  static owns(method: string): boolean {
    return method.startsWith('workspace.fs.');
  }

  static operationOf(method: string): string {
    return method.slice('workspace.fs.'.length);
  }

  static isWrite(operation: string): boolean {
    return WRITE_OPERATIONS.has(operation);
  }
}

/** Accepts what survives the wire: a byte array, or a base64 string for the
 *  transports that flatten to JSON. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  if (typeof value === 'string') return Uint8Array.from(Buffer.from(value, 'base64'));
  return new Uint8Array(0);
}
