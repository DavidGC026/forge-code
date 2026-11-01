import { Uri } from './primitives';

/** Keep the SSH authority: Uri.fsPath alone intentionally drops it. */
export function resourcePath(uri: Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : `${uri.scheme}://${encodeURIComponent(uri.authority)}${encodeURI(uri.path)}`;
}

export function resourceUri(target: string): Uri {
  const ssh = /^ssh:\/\/([^/]+)(\/.*)$/.exec(target);
  if (ssh) return Uri.from({ scheme: 'ssh', authority: decodeURIComponent(ssh[1]), path: decodeURI(ssh[2]) });
  return /^[a-zA-Z][\w+.-]*:\/\//.test(target) ? Uri.parse(target) : Uri.file(target);
}
