import path from 'path';
import { RpcError } from './rpc-protocol';

export interface WorkspaceGlob { base?: string; pattern: string }
export interface WorkspaceFileEvent { id: string; kind: 'create' | 'change' | 'delete'; uri: string }

/** Remote resources retain their authority; path.join would corrupt `ssh://`. */
export function normalizeResource(value: string): string {
  const remote = /^([a-zA-Z][\w+.-]*:\/\/[^/]+)(\/.*)?$/.exec(value);
  if (remote) return remote[1] + path.posix.normalize(remote[2] || '/');
  return path.resolve(value);
}

export function joinResource(base: string, name: string): string {
  const segment = /^[a-zA-Z][\w+.-]*:\/\//.test(base) ? encodeURI(name) : name;
  return normalizeResource(`${base.replace(/\/$/, '')}/${segment}`);
}

export function parseWorkspaceGlob(value: unknown): WorkspaceGlob {
  if (typeof value === 'string') return { pattern: value };
  if (value && typeof value === 'object') {
    const body = value as Partial<WorkspaceGlob>;
    if (typeof body.pattern === 'string' && typeof body.base === 'string') {
      return { pattern: body.pattern, base: normalizeResource(body.base) };
    }
  }
  throw new RpcError('INVALID_PAYLOAD', 'Se requiere un glob o un RelativePattern.');
}

/** Dynamic matching bounds work by tokens × path length, without regex
 * backtracking on extension-controlled patterns such as `*a*a*a...b`. */
export function compileWorkspaceGlob(pattern: string): { test(value: string): boolean } {
  if (!pattern || pattern.length > 1024 || pattern.split('*').length > 65
    || pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..')) {
    throw new RpcError('INVALID_PAYLOAD', 'El glob debe ser relativo y tener longitud acotada.');
  }
  const alternatives = expandBraces(pattern).map(tokenize);
  return { test: (value) => alternatives.some((tokens) => matches(tokens, value)) };
}

type Token = { kind: 'star' | 'globstar' | 'globslash' }
  | { kind: 'char'; accepts: (char: string) => boolean };

function expandBraces(pattern: string): string[] {
  let alternatives = [''];
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char !== '{') {
      alternatives = alternatives.map((prefix) => prefix + char);
      continue;
    }
    const end = pattern.indexOf('}', index);
    const contents = pattern.slice(index + 1, end);
    if (end < 0 || contents.includes('{')) throw new RpcError('INVALID_PAYLOAD', 'Llaves inválidas en el glob.');
    const choices = contents.split(',');
    if (alternatives.length * choices.length > 64) throw new RpcError('INVALID_PAYLOAD', 'Demasiadas alternativas en el glob.');
    alternatives = alternatives.flatMap((prefix) => choices.map((choice) => prefix + choice));
    index = end;
  }
  return alternatives;
}

function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] !== '*') tokens.push({ kind: 'star' });
      else {
        while (pattern[index + 1] === '*') index++;
        if (pattern[index + 1] === '/') { index++; tokens.push({ kind: 'globslash' }); }
        else tokens.push({ kind: 'globstar' });
      }
    } else if (char === '?') tokens.push({ kind: 'char', accepts: (value) => value !== '/' });
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      const group = pattern.slice(index + 1, end);
      if (end < 0 || !/^[!^]?[a-zA-Z0-9_-]+$/.test(group)) throw new RpcError('INVALID_PAYLOAD', 'Clase de caracteres no soportada.');
      let expression: RegExp;
      try { expression = new RegExp(`^[${group.replace(/^!/, '^')}]$`); }
      catch { throw new RpcError('INVALID_PAYLOAD', 'Clase de caracteres inválida.'); }
      tokens.push({ kind: 'char', accepts: (value) => value !== '/' && expression.test(value) });
      index = end;
    } else tokens.push({ kind: 'char', accepts: (value) => value === char });
  }
  return tokens;
}

function matches(tokens: Token[], value: string): boolean {
  let positions = new Uint8Array(value.length + 1);
  positions[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(value.length + 1);
    if (token.kind === 'char') {
      for (let offset = 0; offset < value.length; offset++) {
        if (positions[offset] && token.accepts(value[offset])) next[offset + 1] = 1;
      }
    } else {
      let reached = false;
      for (let offset = 0; offset <= value.length; offset++) {
        reached = reached || Boolean(positions[offset]);
        if (token.kind === 'star') {
          next[offset] = positions[offset] || (offset > 0 && value[offset - 1] !== '/' ? next[offset - 1] : 0);
        } else if (token.kind === 'globstar') next[offset] = Number(reached);
        else next[offset] = positions[offset] || Number(reached && offset > 0 && value[offset - 1] === '/');
      }
    }
    positions = next;
  }
  return Boolean(positions[value.length]);
}
