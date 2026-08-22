/**
 * Loading and activation of extension code, host side.
 *
 * This is the module that finally executes third-party code, so every
 * decision here is about containment:
 *
 * - Nothing loads until `initialize` handed over a descriptor for it. An
 *   `activate` for an unknown id is an error, not a lazy lookup on disk.
 * - `activate()` runs **once per generation**; concurrent requests share the
 *   in-flight promise (design §5), so a second `onCommand` while the first
 *   activation is still running waits instead of re-entering `activate`.
 * - A throwing `activate` fails *that* extension: it becomes `failed`, its
 *   subscriptions are disposed, and the host keeps serving everyone else
 *   (design §6, first row).
 * - Every collaborator that touches the world — `require`, the clock, the
 *   filesystem — is injected, which is what lets the whole lifecycle be
 *   tested with `node --test` and no Electron.
 */
import {
  RpcError,
} from '../extensions/domain/rpc-protocol';
import type { ExtensionHostDescriptor } from '../extensions/domain/rpc-protocol';
import {
  createOwnerIndex,
  describeEntryPointFailure,
  installVscodeModuleHook,
  resolveEntryPoint,
} from './module-loader';
import type { EntryPointResolverDeps, ModuleSystemLike } from './module-loader';
import { createExtensionContext, disposeSubscriptions } from './extension-context';
import type { ExtensionContext, MementoStore } from './extension-context';
import { createVscodeApi } from './vscode-api/facade';
import { createFileSystemApi } from './vscode-api/workspace-fs';
import { Uri } from './vscode-api/primitives';
import { DocumentRegistry } from './document-registry';
import { EditorRegistry } from './editor-registry';
import type { EditorState } from './editor-registry';
import type { TextDocumentState } from './vscode-api/text-document';
import { HostCommandRegistry } from './host-commands';
import type { CommandBridge } from './host-commands';

export type ExtensionActivationStatus = 'inactive' | 'activating' | 'active' | 'failed';

export interface ExtensionActivationResult {
  id: string;
  status: ExtensionActivationStatus;
  /** Wall-clock cost of `activate()`, the seed of the 3.4 metrics. */
  durationMs: number;
  /** Keys of the object `activate()` returned, never the object itself: the
   *  exports API belongs to another extension's process boundary. */
  exports: string[];
}

export interface ExtensionRuntimeOptions {
  apiVersion: string;
  workspacePath: string | null;
  moduleSystem: ModuleSystemLike;
  /** `require`, injected: tests load fixtures without touching the real one. */
  loadModule: (entryPoint: string) => unknown;
  entryPointDeps: EntryPointResolverDeps;
  mementoStore: MementoStore;
  joinPath: (...segments: string[]) => string;
  now: () => number;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, extensionId?: string) => void;
  /** Feeds `diagnostics.unsupportedApi`; see design §10. */
  reportUnsupportedApi: (api: string, extensionId: string) => void;
  /** Publishes command registrations to main. Without one the host still
   *  works standalone — useful in tests — but nothing outside knows. */
  commandBridge?: CommandBridge;
  /** Asks main something and waits for the answer (`window.showMessage`).
   *  Absent in unit tests, where those APIs report as unavailable. */
  request?: (method: string, payload: unknown, extensionId: string) => Promise<unknown>;
  /** Effective configuration snapshot, kept in step by main. Read
   *  synchronously because `workspace.getConfiguration(...).get()` is
   *  synchronous in VS Code and extensions rely on that. */
  configuration?: () => Record<string, unknown>;
  /** Documents open in the workbench when this generation started. */
  documents?: TextDocumentState[];
  /** Editors open then, and which one had focus. */
  editors?: { editors: EditorState[]; activeUri: string | null };
}

interface LoadedExtension {
  descriptor: ExtensionHostDescriptor;
  status: ExtensionActivationStatus;
  context: ExtensionContext | null;
  module: { activate?: unknown; deactivate?: unknown } | null;
  exports: unknown;
  /** Shared while an activation is in flight (design §5). */
  pending: Promise<ExtensionActivationResult> | null;
  error: string | null;
}

export class ExtensionRuntime {
  private readonly options: ExtensionRuntimeOptions;
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly apis = new Map<string, unknown>();
  private readonly commands: HostCommandRegistry;
  /** Shared: a document is the same object for every extension, exactly as
   *  it is the same file. */
  readonly documents: DocumentRegistry;
  readonly editors: EditorRegistry;
  private uninstallHook: (() => void) | null = null;

  constructor(options: ExtensionRuntimeOptions) {
    this.options = options;
    // Command ids are global, so the registry is shared; ownership inside it
    // is per extension, which is what `deactivate` needs to unwind.
    this.commands = new HostCommandRegistry(options.commandBridge ?? {
      register: () => undefined,
      unregister: () => undefined,
    });
    this.documents = new DocumentRegistry(async (uri) => {
      if (!options.request) return false;
      const answer = await options.request('documents.save', { uri }, '') as
        { saved?: unknown } | null;
      return answer?.saved === true;
    });
    if (options.documents?.length) this.documents.reset(options.documents);
    this.editors = new EditorRegistry(this.documents);
    if (options.editors) {
      this.editors.sync(options.editors.editors, options.editors.activeUri);
    }
  }

  /** Runs a command registered by an extension. This is the main → host
   *  half of `commands.execute`; the host → main half is the bridge. */
  executeCommand(commandId: string, args: unknown[] = []): Promise<unknown> {
    return this.commands.execute(commandId, args);
  }

  /** Ids currently registered, for diagnostics and the handshake echo. */
  registeredCommands(): string[] {
    return this.commands.ids();
  }

  /** Publishes the descriptor set of this generation and arms the loader.
   *  Called once, from `lifecycle.initialize`. */
  setExtensions(descriptors: ExtensionHostDescriptor[]): void {
    this.uninstallHook?.();
    this.loaded.clear();
    this.apis.clear();

    for (const descriptor of descriptors) {
      this.loaded.set(descriptor.id, {
        descriptor,
        status: 'inactive',
        context: null,
        module: null,
        exports: undefined,
        pending: null,
        error: null,
      });
    }

    // Nothing to load means nothing to intercept: a generation with no
    // activatable extensions leaves the module system untouched.
    if (descriptors.length === 0) return;

    this.uninstallHook = installVscodeModuleHook({
      moduleSystem: this.options.moduleSystem,
      ownerIndex: createOwnerIndex(descriptors),
      apiFor: (extensionId) => this.apiFor(extensionId),
      onOrphanRequire: (filename) => {
        this.options.log(
          'warn',
          `require("vscode") desde código sin dueño: ${filename ?? 'origen desconocido'}`,
        );
      },
    });
  }

  statusOf(id: string): ExtensionActivationStatus | null {
    return this.loaded.get(id)?.status ?? null;
  }

  /** Idempotent per generation: an already active extension resolves with its
   *  current result and `activate()` is not called again. */
  activate(id: string): Promise<ExtensionActivationResult> {
    const entry = this.loaded.get(id);
    if (!entry) {
      return Promise.reject(new RpcError(
        'INVALID_PAYLOAD',
        `"${id}" no forma parte de esta generación del host.`,
      ));
    }
    if (entry.pending) return entry.pending;
    if (entry.status === 'active') {
      return Promise.resolve(this.resultFor(entry, 0));
    }
    if (entry.status === 'failed') {
      return Promise.reject(new RpcError(
        'ACTIVATION_FAILED',
        entry.error ?? `"${id}" falló al activarse en esta generación.`,
      ));
    }

    entry.status = 'activating';
    const started = this.options.now();
    const pending = this.runActivation(entry, started)
      .finally(() => {
        entry.pending = null;
      });
    entry.pending = pending;
    return pending;
  }

  private async runActivation(
    entry: LoadedExtension,
    started: number,
  ): Promise<ExtensionActivationResult> {
    const { descriptor } = entry;
    try {
      const resolution = resolveEntryPoint(descriptor, this.options.entryPointDeps);
      if (!resolution.ok) {
        throw new RpcError(
          'ACTIVATION_FAILED',
          describeEntryPointFailure(resolution.failure, descriptor),
        );
      }

      // The context exists before the module is loaded: an extension may call
      // `require('vscode')` at import time, and its facade must already be
      // attributable to it.
      const context = createExtensionContext({
        descriptor,
        store: this.options.mementoStore,
        joinPath: this.options.joinPath,
        onError: (err) => this.options.log(
          'warn',
          `almacenamiento de "${descriptor.id}": ${errorMessage(err)}`,
          descriptor.id,
        ),
      });
      entry.context = context;

      const module = this.options.loadModule(resolution.entryPoint) as LoadedExtension['module'];
      entry.module = module ?? null;

      if (module && typeof module.activate === 'function') {
        // `await` covers both shapes: VS Code allows a sync or async activate.
        entry.exports = await (module.activate as (ctx: ExtensionContext) => unknown)(context);
      } else {
        // Legal and common for declarative-only extensions with a `main`.
        this.options.log(
          'debug',
          `"${descriptor.id}" no exporta activate(); se considera activa sin trabajo.`,
          descriptor.id,
        );
        entry.exports = undefined;
      }

      entry.status = 'active';
      entry.error = null;
      return this.resultFor(entry, this.options.now() - started);
    } catch (err) {
      entry.status = 'failed';
      entry.error = errorMessage(err);
      // Anything the extension registered before throwing is released here:
      // a half-activated extension holding live disposables is worse than a
      // failed one.
      if (entry.context) {
        disposeSubscriptions(entry.context, (disposeErr) => this.options.log(
          'warn',
          `dispose tras activación fallida de "${descriptor.id}": ${errorMessage(disposeErr)}`,
          descriptor.id,
        ));
      }
      // Commands registered before the throw would otherwise stay visible in
      // the palette, pointing at an extension that never finished loading.
      this.commands.disposeOwner(descriptor.id);
      entry.context = null;
      entry.module = null;
      this.options.log('error', `activación fallida: ${entry.error}`, descriptor.id);
      throw err instanceof RpcError
        ? err
        : new RpcError('ACTIVATION_FAILED', entry.error, { extensionId: descriptor.id });
    }
  }

  /**
   * Runs the module's `deactivate()` and disposes its subscriptions. Both
   * halves run even if the first throws: the extension gets its chance to
   * clean up, but its failure cannot leak the disposables it registered.
   */
  async deactivate(id: string): Promise<void> {
    const entry = this.loaded.get(id);
    if (!entry || entry.status !== 'active') return;

    const { module, context } = entry;
    entry.status = 'inactive';
    entry.module = null;
    entry.context = null;
    entry.exports = undefined;

    try {
      if (module && typeof module.deactivate === 'function') {
        await (module.deactivate as () => unknown)();
      }
    } catch (err) {
      this.options.log('warn', `deactivate() lanzó: ${errorMessage(err)}`, id);
    } finally {
      if (context) {
        disposeSubscriptions(context, (err) => this.options.log(
          'warn',
          `dispose de subscriptions: ${errorMessage(err)}`,
          id,
        ));
      }
      // Whatever the extension forgot to dispose goes now: an unregistered
      // command is recoverable, a command whose handler is gone is not.
      this.commands.disposeOwner(id);
    }
  }

  /** Shutdown path: deactivates everything active, then unhooks `require`. */
  async deactivateAll(): Promise<void> {
    for (const id of [...this.loaded.keys()]) {
      await this.deactivate(id);
    }
    this.uninstallHook?.();
    this.uninstallHook = null;
    this.editors.dispose();
    this.documents.dispose();
  }

  /** One facade per extension, memoised: the identity behind `Disposable`s
   *  and storage must not change between two `require('vscode')` calls. */
  private apiFor(extensionId: string): unknown {
    const cached = this.apis.get(extensionId);
    if (cached) return cached;
    const api = createVscodeApi({
      extensionId,
      apiVersion: this.options.apiVersion,
      workspacePath: this.options.workspacePath,
      reportUnsupported: (apiName, owner) => this.options.reportUnsupportedApi(apiName, owner),
      implemented: {
        commands: this.commandsApiFor(extensionId),
        window: this.windowApiFor(extensionId),
        workspace: this.workspaceApiFor(extensionId),
      },
    });
    this.apis.set(extensionId, api);
    return api;
  }

  /**
   * The `vscode.commands` members implemented in this increment, bound to
   * one extension so registrations are attributable without the caller
   * having to say who it is. Everything else in the namespace keeps
   * answering `UNSUPPORTED_API`.
   */
  private commandsApiFor(extensionId: string): Record<string, unknown> {
    return {
      registerCommand: (
        commandId: string,
        handler: (...args: unknown[]) => unknown,
        thisArg?: unknown,
      ) => this.commands.register(extensionId, commandId, handler, thisArg),

      executeCommand: async (commandId: string, ...args: unknown[]) => {
        if (this.commands.has(commandId)) return this.commands.execute(commandId, args);
        // Workbench commands (`workbench.action.*`, `editor.action.*`) live
        // in the renderer and reaching them from here needs the reverse
        // route, which is a later increment. Saying so beats resolving to
        // `undefined` and letting the extension act on a command that
        // never ran.
        this.options.reportUnsupportedApi('commands.executeCommand', extensionId);
        throw new RpcError(
          'COMMAND_NOT_FOUND',
          `"${commandId}" no está registrado por ninguna extensión. Los comandos `
          + 'propios del workbench todavía no son invocables desde una extensión.',
        );
      },

      // VS Code returns every command it knows; Forge can only speak for the
      // host's own, and saying which ones those are is more useful than
      // refusing the call outright.
      getCommands: async () => this.commands.ids(),
    };
  }

  /** `window.show*Message`: the only `window` members implemented so far.
   *  Everything else in the namespace keeps throwing, which is what tells
   *  the compatibility report what real extensions actually need next. */
  private windowApiFor(extensionId: string): Record<string, unknown> {
    const show = (severity: 'info' | 'warn' | 'error') =>
      async (message: string, ...rest: unknown[]): Promise<string | undefined> => {
        // VS Code's overload: `(message, options?, ...items)`. Detecting the
        // options object by shape is what keeps both call styles working.
        const [first] = rest;
        const hasOptions = first !== null && typeof first === 'object' && !Array.isArray(first);
        const options = hasOptions ? first as { modal?: boolean } : undefined;
        const items = (hasOptions ? rest.slice(1) : rest).filter(
          (item): item is string => typeof item === 'string',
        );

        if (!this.options.request) {
          this.options.reportUnsupportedApi(`window.show${severity}Message`, extensionId);
          throw new RpcError(
            'UNSUPPORTED_API',
            'El host no puede mostrar mensajes sin conexión con Forge.',
          );
        }
        const answer = await this.options.request('window.showMessage', {
          severity,
          message: String(message),
          items,
          modal: Boolean(options?.modal),
        }, extensionId);
        const selected = (answer as { selected?: unknown } | null)?.selected;
        return typeof selected === 'string' ? selected : undefined;
      };

    const editors = this.editors;
    return {
      showInformationMessage: show('info'),
      showWarningMessage: show('warn'),
      showErrorMessage: show('error'),

      // Editors are workbench state: shared objects, per-extension
      // subscriptions.
      get activeTextEditor() {
        return editors.activeTextEditor;
      },
      get visibleTextEditors() {
        return editors.visibleTextEditors;
      },
      onDidChangeActiveTextEditor: editors.onDidChangeActiveTextEditor,
      onDidChangeTextEditorSelection: editors.onDidChangeTextEditorSelection,
      onDidChangeVisibleTextEditors: editors.onDidChangeVisibleTextEditors,

      showTextDocument: async (
        target: { fsPath?: string; uri?: { fsPath?: string } } | string,
        options?: { preserveFocus?: boolean; viewColumn?: number; selection?: unknown },
      ) => {
        const uri = typeof target === 'string'
          ? target
          : target?.uri?.fsPath ?? target?.fsPath ?? '';
        if (!uri) {
          throw new RpcError('INVALID_PAYLOAD', 'showTextDocument requiere un documento.');
        }
        if (!this.options.request) {
          this.options.reportUnsupportedApi('window.showTextDocument', extensionId);
          throw new RpcError(
            'UNSUPPORTED_API',
            'El host no puede mostrar documentos sin conexión con Forge.',
          );
        }
        await this.options.request('editors.show', {
          uri,
          // Honoured by the renderer: an extension showing a document in the
          // background must not steal the user's caret.
          preserveFocus: options?.preserveFocus === true,
        }, extensionId);

        // The editor exists once the renderer answered and its sync arrived;
        // returning the known one keeps `showTextDocument` usable as the
        // `TextEditor` factory extensions treat it as.
        return editors.visibleTextEditors.find((editor) => editor.document.fileName === uri)
          ?? editors.activeTextEditor;
      },
    };
  }

  /**
   * `workspace.getConfiguration`. Served from a snapshot main keeps in step,
   * not from a round-trip: VS Code's `get()` is synchronous and extensions
   * call it inside `activate()` and inside event handlers, where returning a
   * promise would break them.
   */
  private workspaceApiFor(extensionId: string): Record<string, unknown> {
    const snapshot = () => this.options.configuration?.() ?? {};
    const registry = this.documents;
    const workspacePath = this.options.workspacePath;
    const folderUri = workspacePath ? Uri.file(workspacePath) : null;
    const folders = folderUri
      ? [{ uri: folderUri, name: basenameOf(workspacePath as string), index: 0 }]
      : undefined;

    return {
      // Documents are workbench state, shared by every extension; what is
      // per-extension is only the subscription, which its `deactivate`
      // disposes along with the rest of `context.subscriptions`.
      get textDocuments() {
        return registry.textDocuments;
      },
      onDidOpenTextDocument: registry.onDidOpenTextDocument,
      onDidChangeTextDocument: registry.onDidChangeTextDocument,
      onDidSaveTextDocument: registry.onDidSaveTextDocument,
      onDidCloseTextDocument: registry.onDidCloseTextDocument,

      openTextDocument: async (target: { fsPath?: string } | string) => {
        const uri = typeof target === 'string' ? target : target?.fsPath ?? '';
        if (!uri) {
          throw new RpcError('INVALID_PAYLOAD', 'openTextDocument requiere una ruta.');
        }
        const known = registry.get(uri);
        if (known) return known;
        if (!this.options.request) {
          this.options.reportUnsupportedApi('workspace.openTextDocument', extensionId);
          throw new RpcError(
            'UNSUPPORTED_API',
            'El host no puede abrir documentos sin conexión con Forge.',
          );
        }
        // Not open in the workbench: main reads it from disk. No tab is
        // opened — an extension must not reorder the user's editor.
        const answer = await this.options.request(
          'documents.open',
          { uri },
          extensionId,
        ) as TextDocumentState | null;
        if (!answer) {
          throw new RpcError('INVALID_PAYLOAD', `No se pudo abrir "${uri}".`);
        }
        return registry.adopt(answer);
      },

      fs: createFileSystemApi((operation, payload) => {
        if (!this.options.request) {
          this.options.reportUnsupportedApi(`workspace.fs.${operation}`, extensionId);
          throw new RpcError(
            'UNSUPPORTED_API',
            'El host no puede acceder al sistema de archivos sin conexión con Forge.',
          );
        }
        return this.options.request(`workspace.fs.${operation}`, payload, extensionId);
      }),

      // A single folder: Forge opens one at a time. Reporting an array of
      // one (instead of pretending multi-root works) is what keeps an
      // extension iterating over folders correct today and correct later.
      workspaceFolders: folders,
      name: workspacePath ? basenameOf(workspacePath) : undefined,
      workspaceFile: undefined,

      getWorkspaceFolder: (uri: { fsPath?: string } | string) => {
        if (!folders || !folderUri) return undefined;
        const target = typeof uri === 'string' ? uri : uri?.fsPath ?? '';
        return target && isInsidePath(workspacePath as string, target) ? folders[0] : undefined;
      },

      asRelativePath: (
        pathOrUri: { fsPath?: string } | string,
        includeWorkspaceFolder?: boolean,
      ) => {
        const target = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri?.fsPath ?? '';
        if (!workspacePath || !isInsidePath(workspacePath, target)) return target;
        const relative = target.slice(workspacePath.length).replace(/^[\\/]+/, '');
        return includeWorkspaceFolder
          ? `${basenameOf(workspacePath)}/${relative}`
          : relative;
      },
      getConfiguration: (section?: string) => {
        const prefix = section ? `${section}.` : '';
        const resolve = (key: string): unknown => snapshot()[`${prefix}${key}`];
        return {
          get: (key: string, defaultValue?: unknown) => {
            const value = resolve(key);
            return value === undefined ? defaultValue : value;
          },
          has: (key: string) => resolve(key) !== undefined,
          inspect: (key: string) => {
            const value = resolve(key);
            // Forge resolves precedence in main and ships the effective
            // value; claiming to know which scope it came from would be a
            // guess, so only the resolved one is reported.
            return value === undefined ? undefined : { key: `${prefix}${key}`, globalValue: value };
          },
          update: async () => {
            this.options.reportUnsupportedApi('workspace.getConfiguration().update', extensionId);
            throw new RpcError(
              'UNSUPPORTED_API',
              'Escribir configuración desde una extensión todavía no está soportado.',
            );
          },
        };
      },
    };
  }

  private resultFor(entry: LoadedExtension, durationMs: number): ExtensionActivationResult {
    return {
      id: entry.descriptor.id,
      status: entry.status,
      durationMs,
      exports: entry.exports && typeof entry.exports === 'object'
        ? Object.keys(entry.exports as object)
        : [],
    };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Last segment of a path, without pulling `path` into this module: the
 *  host may be reasoning about a remote URI, where the platform separator
 *  is not the right question. */
function basenameOf(target: string): string {
  const cleaned = target.replace(/[\\/]+$/, '');
  const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return index === -1 ? cleaned : cleaned.slice(index + 1);
}

/** String containment with a separator boundary, mirroring the policy main
 *  applies (`domain/file-access.ts`). */
function isInsidePath(parent: string, target: string): boolean {
  const base = parent.replace(/\\/g, '/').replace(/\/+$/, '');
  const candidate = target.replace(/\\/g, '/');
  return candidate === base || candidate.startsWith(`${base}/`);
}
