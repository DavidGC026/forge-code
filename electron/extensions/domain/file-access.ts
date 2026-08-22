/**
 * What a `workspace.fs` call is allowed to touch.
 *
 * Pure policy: it takes paths and answers yes/no with a reason, so the rule
 * is verifiable without a filesystem. The rule itself (design §3) is
 * deliberately stricter than VS Code's, where `workspace.fs` reaches
 * anything the user can read:
 *
 * - the open workspace: read and write,
 * - the extension's own install directory: read only (an extension that
 *   rewrites its own code defeats the transactional installer),
 * - its storage directory: read and write.
 *
 * Everything else is refused with `NoPermissions`, and the refusal is
 * reported, so a real extension that needs more shows up in the
 * compatibility report instead of being guessed at.
 */

/** Error codes of `vscode.FileSystemError`, as extensions match on them. */
export type FileSystemErrorCode =
  | 'FileNotFound'
  | 'FileExists'
  | 'FileNotADirectory'
  | 'FileIsADirectory'
  | 'NoPermissions'
  | 'Unavailable';

export type FileAccessMode = 'read' | 'write';

export interface FileAccessScopes {
  /** Open workspace: a local path or a remote URI. Null when none. */
  workspace: string | null;
  /** Install directory of the calling extension. */
  extensionDir: string;
  /** Its storage directories, both scopes. */
  storagePaths: readonly (string | null)[];
}

export type FileAccessVerdict =
  | { allowed: true; scope: 'workspace' | 'extension' | 'storage' }
  | { allowed: false; code: FileSystemErrorCode; message: string };

/**
 * Path containment on strings, not on the filesystem: symlinks are resolved
 * by the caller before asking (the same rule the loader applies in
 * `module-loader.ts`), because whether a path escapes is a question about
 * the *real* path and this module must stay pure.
 */
export function isInside(parent: string, target: string): boolean {
  if (!parent) return false;
  const base = normalize(parent);
  const candidate = normalize(target);
  if (candidate === base) return true;
  // The separator matters: `/home/dev/project-2` is not inside
  // `/home/dev/project`, however similar the strings look.
  return candidate.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/** Collapses separators and drops a trailing one. Case is preserved: two
 *  spellings that differ in case are different files on Linux. */
function normalize(value: string): string {
  const unified = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  return unified.length > 1 && unified.endsWith('/') ? unified.slice(0, -1) : unified;
}

export function checkFileAccess(
  target: string,
  mode: FileAccessMode,
  scopes: FileAccessScopes,
): FileAccessVerdict {
  if (!target) {
    return { allowed: false, code: 'FileNotFound', message: 'Ruta vacía.' };
  }

  if (scopes.workspace && isInside(scopes.workspace, target)) {
    return { allowed: true, scope: 'workspace' };
  }

  for (const storage of scopes.storagePaths) {
    if (storage && isInside(storage, target)) return { allowed: true, scope: 'storage' };
  }

  if (isInside(scopes.extensionDir, target)) {
    if (mode === 'read') return { allowed: true, scope: 'extension' };
    return {
      allowed: false,
      code: 'NoPermissions',
      message: 'Una extensión no puede escribir en su propio directorio de instalación: '
        + 'lo reemplaza cada actualización.',
    };
  }

  return {
    allowed: false,
    code: 'NoPermissions',
    message: scopes.workspace
      ? `"${target}" está fuera del workspace, del directorio de la extensión y de su `
        + 'almacenamiento. Forge no permite a una extensión salir de ahí.'
      : `"${target}" está fuera de lo que la extensión puede tocar, y no hay ningún `
        + 'workspace abierto.',
  };
}
