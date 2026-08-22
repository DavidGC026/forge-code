/**
 * `vscode.workspace.fs` and `FileSystemError`, host side.
 *
 * Every call is a request to main, which owns the policy and the actual
 * filesystem (local or SSH). What lives here is the shape extensions
 * expect: `Uri` in, `Uint8Array` out, and errors that are instances of
 * `FileSystemError` with the code they match on — an extension doing
 * `catch (e) { if (e.code === 'FileNotFound') … }` is idiomatic, and giving
 * it a plain `Error` breaks that quietly.
 */
import { Uri } from './primitives';

export type FileSystemErrorCode =
  | 'FileNotFound'
  | 'FileExists'
  | 'FileNotADirectory'
  | 'FileIsADirectory'
  | 'NoPermissions'
  | 'Unavailable'
  | 'Unknown';

export class FileSystemError extends Error {
  readonly code: FileSystemErrorCode;

  constructor(message: string, code: FileSystemErrorCode = 'Unknown') {
    super(message);
    this.name = 'FileSystemError';
    this.code = code;
  }

  static FileNotFound(uri?: Uri | string): FileSystemError {
    return new FileSystemError(describe('no existe', uri), 'FileNotFound');
  }

  static FileExists(uri?: Uri | string): FileSystemError {
    return new FileSystemError(describe('ya existe', uri), 'FileExists');
  }

  static FileNotADirectory(uri?: Uri | string): FileSystemError {
    return new FileSystemError(describe('no es un directorio', uri), 'FileNotADirectory');
  }

  static FileIsADirectory(uri?: Uri | string): FileSystemError {
    return new FileSystemError(describe('es un directorio', uri), 'FileIsADirectory');
  }

  static NoPermissions(uri?: Uri | string): FileSystemError {
    return new FileSystemError(describe('no es accesible', uri), 'NoPermissions');
  }

  static Unavailable(uri?: Uri | string): FileSystemError {
    return new FileSystemError(describe('no está disponible', uri), 'Unavailable');
  }
}

function describe(what: string, uri?: Uri | string): string {
  const target = uri === undefined ? '' : ` "${typeof uri === 'string' ? uri : uri.fsPath}"`;
  return `El recurso${target} ${what}.`;
}

const FILE_SYSTEM_CODES: readonly string[] = [
  'FileNotFound',
  'FileExists',
  'FileNotADirectory',
  'FileIsADirectory',
  'NoPermissions',
  'Unavailable',
];

/** Rebuilds the class from what crossed the wire. An unknown code degrades
 *  to `Unknown` rather than being invented. */
export function toFileSystemError(err: unknown): FileSystemError {
  const body = err as { code?: unknown; message?: unknown; data?: { code?: unknown } } | null;
  const raw = body?.data?.code ?? body?.code;
  const code = typeof raw === 'string' && FILE_SYSTEM_CODES.includes(raw)
    ? raw as FileSystemErrorCode
    : 'Unknown';
  const message = typeof body?.message === 'string' && body.message
    ? body.message
    : 'Operación de archivo fallida.';
  return new FileSystemError(message, code);
}

export interface FileSystemRequest {
  (operation: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** The `workspace.fs` object handed to one extension. */
export function createFileSystemApi(request: FileSystemRequest): Record<string, unknown> {
  const call = async (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
    try {
      return await request(operation, payload);
    } catch (err) {
      throw toFileSystemError(err);
    }
  };

  // Only `fsPath` travels: main resolves against the same abstraction the
  // workbench uses, where a remote workspace is a URI string too.
  const pathOf = (uri: Uri | string): string => (typeof uri === 'string' ? uri : uri.fsPath);

  return {
    async stat(uri: Uri | string) {
      return call('stat', { uri: pathOf(uri) });
    },
    async readFile(uri: Uri | string): Promise<Uint8Array> {
      const answer = await call('readFile', { uri: pathOf(uri) }) as { data?: unknown };
      return asBytes(answer?.data);
    },
    async writeFile(uri: Uri | string, content: Uint8Array) {
      await call('writeFile', {
        uri: pathOf(uri),
        // Base64 survives every transport, including the JSON-flattening
        // ones; a raw typed array does not.
        content: Buffer.from(content ?? new Uint8Array(0)).toString('base64'),
      });
    },
    async readDirectory(uri: Uri | string): Promise<[string, number][]> {
      const answer = await call('readDirectory', { uri: pathOf(uri) }) as {
        entries?: { name: string; type: number }[];
      };
      // VS Code returns tuples, and extensions destructure them positionally.
      return (answer?.entries ?? []).map((entry) => [entry.name, entry.type]);
    },
    async createDirectory(uri: Uri | string) {
      await call('createDirectory', { uri: pathOf(uri) });
    },
    async delete(uri: Uri | string, options?: { recursive?: boolean; useTrash?: boolean }) {
      await call('delete', { uri: pathOf(uri), recursive: options?.recursive === true });
    },
    async rename(source: Uri | string, target: Uri | string, options?: { overwrite?: boolean }) {
      await call('rename', {
        uri: pathOf(source),
        target: pathOf(target),
        overwrite: options?.overwrite === true,
      });
    },
    async copy(source: Uri | string, target: Uri | string, options?: { overwrite?: boolean }) {
      await call('copy', {
        uri: pathOf(source),
        target: pathOf(target),
        overwrite: options?.overwrite === true,
      });
    },
    async isWritableFileSystem() {
      return true;
    },
  };
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') return new Uint8Array(Buffer.from(value, 'base64'));
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return new Uint8Array(0);
}
