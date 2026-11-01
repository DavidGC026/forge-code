/**
 * Entry point of the Extension Host `utilityProcess`.
 *
 * Increment 3.1 taught it to speak the protocol, 3.2 put the loader behind
 * it, and 3.3 added commands: `lifecycle.initialize` carries the descriptors
 * this generation may load, `lifecycle.activate` runs their code through the
 * `ExtensionRuntime`, and `commands.execute` invokes what they registered.
 * Registrations travel the other way as notifications. Everything outside
 * `lifecycle` and `commands` still answers `UNSUPPORTED_API`.
 *
 * The responder stays a pure `envelope → envelope` function (now allowed to
 * be async, since activation is), and all I/O wiring lives in
 * `attachParentPort`, so the protocol behaviour is testable in-process
 * against the real broker.
 */
import Module from 'module';
import path from 'path';
import {
  RPC_PROTOCOL_VERSION,
  RpcError,
  isExtensionHostDescriptor,
  isRpcEnvelope,
} from '../extensions/domain/rpc-protocol';
import type {
  ExtensionHostDescriptor,
  RpcEnvelope,
  RpcLogLevel,
} from '../extensions/domain/rpc-protocol';
import { ExtensionRuntime } from './extension-runtime';
import type { ExtensionRuntimeOptions } from './extension-runtime';
import type { ModuleSystemLike } from './module-loader';
import type { CommandBridge } from './host-commands';
import { createFsMementoStore } from './fs-memento-store';

/** Message main sends to hand over the channel (mirrors the launcher). */
export const HOST_PORT_MESSAGE = 'forge:extension-host-port';

export interface BootstrapResponderOptions {
  /** Monotonic-ish clock used for uptime; injected for tests. */
  now: () => number;
  nodeVersion: string;
  /** Called after `lifecycle.shutdown` has been answered. */
  exit: (code: number) => void;
  warn?: (message: string) => void;
  /** Sends a host-originated notification (logs, unsupported API reports).
   *  Absent in the pure unit tests, where nothing listens. */
  notify?: (envelope: RpcEnvelope) => void;
  /** Builds the runtime for a generation. Overridden in tests to load
   *  fixtures without touching the real module system. */
  createRuntime?: (options: RuntimeFactoryInput) => ExtensionRuntime;
}

export interface RuntimeFactoryInput {
  apiVersion: string;
  workspacePath: string | null;
  documents: NonNullable<ExtensionRuntimeOptions['documents']>;
  editors: NonNullable<ExtensionRuntimeOptions['editors']>;
  log: ExtensionRuntimeOptions['log'];
  reportUnsupportedApi: ExtensionRuntimeOptions['reportUnsupportedApi'];
  commandBridge: CommandBridge;
  request: NonNullable<ExtensionRuntimeOptions['request']>;
  configuration: NonNullable<ExtensionRuntimeOptions['configuration']>;
  now: () => number;
}

/** Default runtime: the real module system, the real filesystem. */
function createDefaultRuntime(input: RuntimeFactoryInput): ExtensionRuntime {
  const fs = require('fs') as typeof import('fs');
  return new ExtensionRuntime({
    apiVersion: input.apiVersion,
    workspacePath: input.workspacePath,
    moduleSystem: Module as unknown as ModuleSystemLike,
    loadModule: (entryPoint) => require(entryPoint),
    entryPointDeps: {
      realpath: (target) => {
        try {
          return fs.realpathSync(target);
        } catch {
          // Missing paths realpath to themselves so "escaping" and "missing"
          // stay distinguishable in the resolver.
          return path.resolve(target);
        }
      },
      isFile: (target) => {
        try {
          return fs.statSync(target).isFile();
        } catch {
          return false;
        }
      },
    },
    documents: input.documents,
    editors: input.editors,
    // Storage paths travel in each descriptor, decided and sanitised by main.
    mementoStore: createFsMementoStore(),
    joinPath: (...segments) => path.join(...segments),
    now: input.now,
    log: input.log,
    reportUnsupportedApi: input.reportUnsupportedApi,
    commandBridge: input.commandBridge,
    request: input.request,
    configuration: input.configuration,
  });
}

type Responder = (message: unknown) => RpcEnvelope | null | Promise<RpcEnvelope | null>;

/**
 * Pure message handler: envelope in, envelope out (or null when there is
 * nothing to answer). May answer asynchronously — `lifecycle.activate` runs
 * extension code — which the transport side awaits before posting.
 */
export function createBootstrapResponder(options: BootstrapResponderOptions): Responder {
  const startedAt = options.now();
  const warn = options.warn ?? ((message: string) => console.warn('[forge:host]', message));
  const createRuntime = options.createRuntime ?? createDefaultRuntime;
  let initialized = false;
  let runtime: ExtensionRuntime | null = null;
  let generation = 0;
  // Effective configuration, as main resolved it. Kept here (not fetched per
  // read) because `workspace.getConfiguration(...).get()` is synchronous.
  let configuration: Record<string, unknown> = {};

  // The host's own outbound requests (`window.showMessage`, …). Ids are
  // per sender, so they may collide with main's; there is no ambiguity
  // because only *responses* are matched here and only *requests* are
  // switched on below.
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: RpcError) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  let nextRequestId = 1;

  const reply = (
    request: RpcEnvelope,
    kind: 'response' | 'error',
    payload: unknown,
  ): RpcEnvelope => ({
    v: RPC_PROTOCOL_VERSION,
    // The generation is echoed, never invented: main is its only source and
    // discards anything that comes back with a stale one.
    gen: request.gen,
    id: request.id,
    kind,
    method: request.method,
    payload,
    ...(request.extensionId ? { extensionId: request.extensionId } : {}),
  });

  const fail = (request: RpcEnvelope, error: RpcError): RpcEnvelope =>
    reply(request, 'error', error.toPayload());

  const notify = (method: string, payload: unknown, extensionId?: string): void => {
    options.notify?.({
      v: RPC_PROTOCOL_VERSION,
      gen: generation,
      id: 0,
      kind: 'event',
      method,
      payload,
      ...(extensionId ? { extensionId } : {}),
    });
  };

  /**
   * Asks main something and waits. Rejects on timeout rather than hanging:
   * an extension awaiting a message box that main never answers would
   * otherwise keep its activation promise alive for the whole session.
   */
  const hostRequest = (
    method: string,
    payload: unknown,
    extensionId?: string,
    timeoutMs = 60_000,
  ): Promise<unknown> => new Promise((resolve, reject) => {
    if (!options.notify) {
      reject(new RpcError('HOST_UNAVAILABLE', 'El host no tiene canal hacia main.'));
      return;
    }
    const id = nextRequestId++;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        pending.delete(id);
        reject(new RpcError('TIMEOUT', `"${method}" no obtuvo respuesta de Forge.`));
      }, timeoutMs)
      : null;
    // `unref` where available: a pending message box must not keep the
    // process alive when everything else is done.
    timer?.unref?.();
    pending.set(id, { resolve, reject, timer });

    options.notify({
      v: RPC_PROTOCOL_VERSION,
      gen: generation,
      id,
      kind: 'request',
      method,
      payload,
      ...(extensionId ? { extensionId } : {}),
    });
  });

  const settle = (message: RpcEnvelope): void => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.kind === 'error') entry.reject(RpcError.fromPayload(message.payload));
    else entry.resolve(message.payload);
  };

  const log = (level: RpcLogLevel, message: string, extensionId?: string): void => {
    notify('diagnostics.log', { level, message, extensionId: extensionId ?? null }, extensionId);
  };

  /** Requests carrying `{ id }`; anything else is refused at the edge. */
  const extensionIdOf = (request: RpcEnvelope): string => {
    const payload = request.payload as { id?: unknown } | null;
    const id = payload && typeof payload === 'object' ? payload.id : undefined;
    if (typeof id !== 'string' || !id) {
      throw new RpcError('INVALID_PAYLOAD', `"${request.method}" requiere { id: string }.`);
    }
    return id;
  };

  const requireRuntime = (): ExtensionRuntime => {
    if (!runtime) {
      throw new RpcError('HOST_UNAVAILABLE', 'El host todavía no completó el handshake.');
    }
    return runtime;
  };

  return async (message: unknown): Promise<RpcEnvelope | null> => {
    if (!isRpcEnvelope(message)) {
      warn('mensaje descartado: no es un envelope válido');
      return null;
    }
    // Answers to the host's own requests settle their promise; everything
    // else that is not a request needs no reply.
    if (message.kind === 'response' || message.kind === 'error') {
      settle(message);
      return null;
    }
    if (message.kind !== 'request') return null;

    try {
      switch (message.method) {
        case 'lifecycle.initialize': {
          const payload = message.payload as
            | { protocol?: unknown; apiVersion?: unknown; extensions?: unknown;
                workspace?: unknown; configuration?: unknown; documents?: unknown;
                editors?: unknown }
            | null;
          if (!payload || typeof payload !== 'object'
            || payload.protocol !== RPC_PROTOCOL_VERSION) {
            return fail(message, new RpcError(
              'HOST_UNAVAILABLE',
              `Protocolo no soportado por el host: ${String(payload?.protocol)}.`,
            ));
          }

          generation = message.gen;
          const workspacePath = typeof payload.workspace === 'string' ? payload.workspace : null;
          configuration = plainRecord(payload.configuration);
          const descriptors = descriptorsFrom(payload.extensions, warn);
          const documents = Array.isArray(payload.documents)
            ? payload.documents
              .filter((entry): entry is Record<string, unknown> => (
                entry !== null && typeof entry === 'object' && typeof (entry as { uri?: unknown }).uri === 'string'
              ))
              .map((entry) => toDocumentState(entry.uri as string, entry))
            : [];

          runtime = createRuntime({
            apiVersion: typeof payload.apiVersion === 'string' ? payload.apiVersion : '0.0.0',
            workspacePath,
            log,
            reportUnsupportedApi: (api, extensionId) => {
              notify('diagnostics.unsupportedApi', { api, extensionId }, extensionId);
            },
            // Registrations are notifications, not requests: the host has
            // already decided (a duplicate id throws locally), and main
            // vetoes by not loading the extension at all, never per command.
            // A request here would also nest inside `activate`, competing
            // with its own timeout.
            commandBridge: {
              register: (commandId, extensionId) => {
                notify('commands.register', { command: commandId, extensionId }, extensionId);
              },
              unregister: (commandId, extensionId) => {
                notify('commands.unregister', { command: commandId, extensionId }, extensionId);
              },
            },
            request: (method, payload, extensionId) => hostRequest(method, payload, extensionId),
            configuration: () => configuration,
            documents,
            editors: {
              editors: Array.isArray((payload as { editors?: { editors?: unknown } }).editors?.editors)
                ? ((payload as { editors: { editors: unknown[] } }).editors.editors).filter(isEditorState)
                : [],
              activeUri: typeof (payload as { editors?: { activeUri?: unknown } }).editors?.activeUri === 'string'
                ? (payload as { editors: { activeUri: string } }).editors.activeUri
                : null,
            },
            now: options.now,
          });
          runtime.setExtensions(descriptors);
          initialized = true;

          return reply(message, 'response', {
            protocol: RPC_PROTOCOL_VERSION,
            nodeVersion: options.nodeVersion,
            ready: true,
            /** Echoed so main can tell a rejected descriptor from a dropped one. */
            loadable: descriptors.map((descriptor) => descriptor.id),
          });
        }
        case 'lifecycle.heartbeat': {
          if (!initialized) {
            return fail(message, new RpcError(
              'HOST_UNAVAILABLE',
              'El host todavía no completó el handshake.',
            ));
          }
          return reply(message, 'response', { ok: true, uptimeMs: options.now() - startedAt });
        }
        case 'lifecycle.activate': {
          const result = await requireRuntime().activate(extensionIdOf(message));
          return reply(message, 'response', result);
        }
        case 'documents.sync': {
          // The renderer's view of the buffers, relayed by main. Each kind is
          // applied by the registry, which is what fires the extension-facing
          // events; the host never infers a lifecycle it was not told about.
          const payload = message.payload as
            | { kind?: unknown; document?: unknown; uri?: unknown }
            | null;
          const kind = payload && typeof payload === 'object' ? payload.kind : undefined;
          const runtime = requireRuntime();
          const state = plainRecord(payload?.document) as Record<string, unknown>;
          const uri = typeof payload?.uri === 'string'
            ? payload.uri
            : typeof state.uri === 'string' ? state.uri : '';

          if (!uri) {
            throw new RpcError('INVALID_PAYLOAD', '"documents.sync" requiere una uri.');
          }

          switch (kind) {
            case 'open':
              runtime.documents.open(toDocumentState(uri, state));
              break;
            case 'change':
              runtime.documents.change(uri, toDocumentPatch(state));
              break;
            case 'save':
              runtime.documents.save(uri, toDocumentPatch(state));
              break;
            case 'close':
              runtime.documents.close(uri);
              break;
            default:
              throw new RpcError(
                'INVALID_PAYLOAD',
                `"documents.sync" no reconoce el tipo "${String(kind)}".`,
              );
          }
          return reply(message, 'response', { ok: true });
        }
        case 'workspace.files.changed': {
          const body = message.payload as { id?: unknown; kind?: unknown; uri?: unknown } | null;
          if (!message.extensionId || typeof body?.id !== 'string' || typeof body.uri !== 'string'
            || (body.kind !== 'create' && body.kind !== 'change' && body.kind !== 'delete')) {
            throw new RpcError('INVALID_PAYLOAD', 'Evento de watcher inválido.');
          }
          requireRuntime().acceptWorkspaceFileEvent(message.extensionId, {
            id: body.id, kind: body.kind, uri: body.uri,
          });
          return reply(message, 'response', { ok: true });
        }
        case 'editors.sync': {
          // The renderer sends the whole layout: there are a handful of
          // editors, and reconciling a list is easier to get right than a
          // stream of moves.
          const payload = message.payload as { editors?: unknown; activeUri?: unknown } | null;
          const editors = Array.isArray(payload?.editors)
            ? payload.editors.filter(isEditorState)
            : [];
          requireRuntime().editors.sync(
            editors,
            typeof payload?.activeUri === 'string' ? payload.activeUri : null,
          );
          return reply(message, 'response', { ok: true, editors: editors.length });
        }
        case 'configuration.update': {
          // Main owns precedence (default < override < user < workspace) and
          // ships the resolved values; the host never merges scopes itself.
          const payload = message.payload as { values?: unknown } | null;
          configuration = plainRecord(payload?.values);
          return reply(message, 'response', { ok: true, keys: Object.keys(configuration).length });
        }
        case 'commands.execute': {
          const payload = message.payload as { command?: unknown; args?: unknown } | null;
          const command = payload && typeof payload === 'object' ? payload.command : undefined;
          if (typeof command !== 'string' || !command) {
            throw new RpcError('INVALID_PAYLOAD', '"commands.execute" requiere { command: string }.');
          }
          const args = Array.isArray(payload?.args) ? payload.args : [];
          const result = await requireRuntime().executeCommand(command, args);
          // Only serializable results cross the wire; anything else is
          // dropped with a note rather than crashing the message pump on
          // the way out.
          return reply(message, 'response', { command, result: serializable(result, warn, command) });
        }
        case 'lifecycle.deactivate': {
          const id = extensionIdOf(message);
          await requireRuntime().deactivate(id);
          return reply(message, 'response', { id, status: 'inactive' });
        }
        case 'lifecycle.shutdown': {
          // Extensions get their `deactivate()` before the process goes away;
          // failures there must not stop the shutdown from being answered.
          try {
            await runtime?.deactivateAll();
          } catch (err) {
            warn(`deactivateAll falló: ${err instanceof Error ? err.message : String(err)}`);
          }
          const answer = reply(message, 'response', { ok: true });
          options.exit(0);
          return answer;
        }
        default:
          return fail(message, new RpcError(
            'UNSUPPORTED_API',
            `"${message.method}" todavía no está implementado en el Extension Host.`,
          ));
      }
    } catch (err) {
      // Every failure leaves as a typed error envelope: the host never lets an
      // exception escape into the message pump, where it would look like a
      // hang to main and burn a heartbeat budget.
      return fail(message, err instanceof RpcError
        ? err
        : new RpcError('ACTIVATION_FAILED', err instanceof Error ? err.message : String(err)));
    }
  };
}

/** Validates one editor at the edge: an editor without a uri, or with
 *  selections that are not numbers, would produce a caret nobody can trust. */
function isEditorState(value: unknown): value is {
  uri: string;
  viewColumn: number;
  selections: {
    anchorLine: number;
    anchorCharacter: number;
    activeLine: number;
    activeCharacter: number;
  }[];
} {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (typeof state.uri !== 'string' || !state.uri) return false;
  if (!Array.isArray(state.selections)) return false;
  return state.selections.every((selection) => (
    selection !== null
    && typeof selection === 'object'
    && ['anchorLine', 'anchorCharacter', 'activeLine', 'activeCharacter'].every(
      (key) => typeof (selection as Record<string, unknown>)[key] === 'number',
    )
  ));
}

/** Full state for an opened document; missing fields take the neutral value
 *  rather than being guessed from the previous revision. */
function toDocumentState(uri: string, raw: Record<string, unknown>): {
  uri: string;
  languageId: string;
  version: number;
  content: string;
  isDirty: boolean;
} {
  return {
    uri,
    languageId: typeof raw.languageId === 'string' ? raw.languageId : 'plaintext',
    version: typeof raw.version === 'number' ? raw.version : 1,
    content: typeof raw.content === 'string' ? raw.content : '',
    isDirty: raw.isDirty === true,
  };
}

/** Partial patch: only what actually arrived is applied, so a `save` that
 *  carries no content does not blank the document. */
function toDocumentPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof raw.languageId === 'string') patch.languageId = raw.languageId;
  if (typeof raw.version === 'number') patch.version = raw.version;
  if (typeof raw.content === 'string') patch.content = raw.content;
  if (typeof raw.isDirty === 'boolean') patch.isDirty = raw.isDirty;
  return patch;
}

/** Accepts only a plain object of values; anything else reads as empty
 *  rather than letting a malformed payload shadow the real settings. */
function plainRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * A command may return anything — a Disposable, a class instance, a live
 * editor object. Only what survives structured clone can travel, so the
 * value is probed here: unclonable results become `undefined` with a log,
 * which is far better than an exception thrown by `postMessage` after the
 * responder already promised an answer.
 */
function serializable(value: unknown, warn: (message: string) => void, command: string): unknown {
  if (value === undefined || value === null) return value;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    warn(`el resultado de "${command}" no es serializable; se descarta`);
    return undefined;
  }
}

/** Validates the descriptor list at the edge; invalid entries are dropped and
 *  reported, never guessed at. */
function descriptorsFrom(value: unknown, warn: (message: string) => void): ExtensionHostDescriptor[] {
  if (!Array.isArray(value)) return [];
  const descriptors: ExtensionHostDescriptor[] = [];
  for (const entry of value) {
    if (isExtensionHostDescriptor(entry)) descriptors.push(entry);
    else warn(`descriptor de extensión inválido descartado: ${JSON.stringify(entry)}`);
  }
  return descriptors;
}

interface HostMessagePort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
}

interface HostParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports: HostMessagePort[] }) => void): void;
  postMessage(message: unknown): void;
}

/** Wires the responder to the `MessagePortMain` main sends after the fork. */
export function attachParentPort(parentPort: HostParentPort): void {
  parentPort.on('message', (event) => {
    const data = event.data as { type?: unknown } | null;
    if (!data || typeof data !== 'object' || data.type !== HOST_PORT_MESSAGE) return;
    const port = event.ports[0];
    if (!port) return;

    const respond = createBootstrapResponder({
      now: () => Date.now(),
      nodeVersion: process.versions.node,
      // Give the answer a chance to leave before the process goes away.
      exit: (code) => setTimeout(() => process.exit(code), 0),
      notify: (envelope) => port.postMessage(envelope),
    });
    port.on('message', (incoming) => {
      void Promise.resolve(respond(incoming.data)).then((answer) => {
        if (answer) port.postMessage(answer);
      });
    });
    port.start();
  });
}

// `parentPort` only exists inside a utilityProcess; requiring this module from
// the test runner must not blow up.
if (typeof process !== 'undefined' && process.parentPort) {
  attachParentPort(process.parentPort as unknown as HostParentPort);
}
