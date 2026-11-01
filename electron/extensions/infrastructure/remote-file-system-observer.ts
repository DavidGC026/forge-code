import { ExtensionFileSystemError } from '../application/extension-file-system';
import type { RemoteFileSystemBridge } from './node-extension-file-system';

interface RemoteObserverOptions {
  parse: (uri: string) => { target: string; path: string };
  run: (target: string, command: string) => Promise<Buffer>;
}

/** SSH observations share one quoting and NUL-delimited decoding boundary.
 * GNU realpath/find/stat are required, just as in the workbench's SSH host. */
export function createRemoteFileSystemObserver(options: RemoteObserverOptions):
Pick<RemoteFileSystemBridge, 'realpath' | 'stat' | 'readDirectory'> {
  const run = async (target: string, command: string): Promise<string> => {
    try { return (await options.run(target, command)).toString('utf8'); }
    catch (err) { throw new ExtensionFileSystemError('Unavailable', `SSH: ${(err as Error).message}`); }
  };
  return {
    realpath: async (uri) => {
      const remote = options.parse(uri);
      const output = await run(remote.target, `realpath -m -z -- ${quote(remote.path)}`);
      if (!output.endsWith('\0') || !output.startsWith('/')) {
        throw new ExtensionFileSystemError('Unavailable', 'realpath remoto devolvió una ruta inválida.');
      }
      const canonical = output.slice(0, -1);
      // The interactive connection form trims paths; IO must preserve names.
      return `ssh://${encodeURIComponent(remote.target)}${encodeURI(canonical)}`;
    },
    stat: async (uri) => {
      const remote = options.parse(uri);
      const output = await run(remote.target, `stat -c '%F|%s|%y|%z' -- ${quote(remote.path)}`);
      const [kind, size, modified, changed] = output.trimEnd().split('|');
      const mtime = Date.parse(modified); const ctime = Date.parse(changed);
      if (!Number.isFinite(mtime) || !Number.isFinite(ctime) || !Number.isFinite(Number(size))) {
        throw new ExtensionFileSystemError('Unavailable', 'stat remoto devolvió metadatos inválidos.');
      }
      return { type: kind === 'symbolic link' ? 64 : kind === 'directory' ? 2 : 1,
        size: Number(size), mtime, ctime };
    },
    readDirectory: async (uri) => {
      const remote = options.parse(uri);
      const output = await run(remote.target,
        `find -P ${quote(remote.path)} -mindepth 1 -maxdepth 1 -printf '%y\\0%f\\0'`);
      const fields = output.split('\0');
      if (fields.pop() !== '' || fields.length % 2 !== 0) {
        throw new ExtensionFileSystemError('Unavailable', 'find remoto devolvió entradas inválidas.');
      }
      const entries: { name: string; type: number }[] = [];
      for (let index = 0; index < fields.length; index += 2) {
        entries.push({ name: fields[index + 1], type: fields[index] === 'l' ? 64 : fields[index] === 'd' ? 2 : 1 });
      }
      return entries;
    },
  };
}

function quote(value: string): string {
  if (value.includes('\0')) throw new ExtensionFileSystemError('NoPermissions', 'Ruta SSH con NUL.');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
