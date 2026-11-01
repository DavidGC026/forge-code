import { contextBridge, ipcRenderer } from 'electron';
import { BufferedStartupEvent } from './buffered-startup-event';
import type {
  ExtensionConfigurationValuePayload,
  ExtensionListPayload,
  ExtensionUpdatePayload,
  InstalledExtensionPayload,
  MarketplaceExtensionDetailPayload,
  MarketplaceSearchPayload,
  WorkspaceTrustStatusPayload,
} from './extensions/domain/extension-dto';
import type {
  ExtensionHostEvent,
  ExtensionHostState,
} from './extensions/application/ports/extension-host';

/** Trust of the open workspace, as pushed to and read by the renderer. */
export type WorkspaceTrustStatus = WorkspaceTrustStatusPayload;

/** Extension host state and traffic, as the renderer observes them. The
 *  types come from the application port so both sides stay in step. */
export type ExtensionHostStatePayload = ExtensionHostState;
export type ExtensionHostEventPayload = ExtensionHostEvent;

/** One command the running host can execute, and who owns it. */
export interface ExtensionCommandRegistration {
  command: string;
  extensionId: string;
}

/** Result of running an extension command. Failures arrive as data, with
 *  the RPC code, so the renderer can tell "not registered" from "the
 *  extension threw" without matching message text. */
export type ExtensionCommandResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Editor layout as the extension host sees it. */
export interface EditorSyncPayload {
  editors: {
    uri: string;
    viewColumn: number;
    selections: {
      anchorLine: number;
      anchorCharacter: number;
      activeLine: number;
      activeCharacter: number;
    }[];
    visibleRanges?: { startLine: number; endLine: number }[];
  }[];
  activeUri: string | null;
}

/** A request from an extension to edit an open buffer. */
export interface EditorApplyEditsRequest {
  id: number;
  uri: string;
  edits: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    newText: string;
  }[];
}

/** A request from an extension to reveal a document. */
export interface EditorShowRequest {
  id: number;
  uri: string;
  preserveFocus: boolean;
}

/** One buffer event for the extension host's document mirror. */
export type DocumentSyncPayload =
  | {
      kind: 'open';
      document: {
        uri: string;
        languageId: string;
        version: number;
        content: string;
        isDirty: boolean;
      };
    }
  | { kind: 'change'; uri: string; version: number; content: string; isDirty?: boolean }
  | { kind: 'save'; uri: string; version?: number; content?: string }
  | { kind: 'close'; uri: string };

/** Whether Forge is running with every extension inert, and why. */
export interface SafeModeStatus {
  active: boolean;
  source: 'off' | 'command-line' | 'user';
  /** False when `--disable-extensions` holds it on: only a relaunch helps. */
  canDisable: boolean;
  reason: string | null;
}

export type SafeModeResult =
  | { ok: true; status: SafeModeStatus }
  | { ok: false; error: string; status: SafeModeStatus };

/** A message an extension asked Forge to show. `items` are buttons; the
 *  renderer answers with the chosen one, or null when dismissed. */
export interface ExtensionHostMessage {
  id: number;
  severity: 'info' | 'warn' | 'error';
  message: string;
  items: string[];
  extensionId: string | null;
}

/** What activated, how long it took and what failed, for the host UI. */
export interface ExtensionActivationReport {
  metrics: { id: string; reason: string; durationMs: number; at: number }[];
  failures: { id: string; reason: string; code: string; message: string; at: number }[];
}

export interface FsChangeEvent {
  reason: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change' | string;
  path: string;
}

export interface ClaudeIdeSelection {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

export interface ClaudeIdeEditorState {
  workspacePath: string | null;
  workspaceName: string | null;
  openEditors: {
    uri: string;
    filePath: string;
    isActive: boolean;
    label: string;
    languageId: string;
    isDirty: boolean;
    lineCount: number;
  }[];
}

export interface ElectronAPI {
  // Dialog
  openFolder: () => Promise<string | null>;
  // Remote SSH workspace
  remote: {
    connect: (args: { target: string; path: string }) => Promise<string>;
    browse: (args: { target: string; path: string }) => Promise<{
      path: string;
      parent: string | null;
      directories: { name: string; path: string }[];
    }>;
  };
  // File System
  readDirectory: (dirPath: string) => Promise<any[]>;
  readFile: (filePath: string) => Promise<string>;
  readImageDataUrl: (filePath: string) => Promise<{ dataUrl: string; size: number }>;
  writeFile: (filePath: string, content: string) => Promise<boolean>;
  createFile: (filePath: string) => Promise<boolean>;
  createDirectory: (dirPath: string) => Promise<boolean>;
  deleteItem: (itemPath: string) => Promise<boolean>;
  renameItem: (oldPath: string, newPath: string) => Promise<boolean>;
  // Workspace watcher
  watchWorkspace: (dirPath: string) => Promise<boolean>;
  unwatchWorkspace: () => Promise<boolean>;
  onFsChanged: (callback: (event: FsChangeEvent) => void) => void;
  offFsChanged: (callback?: (event: FsChangeEvent) => void) => void;
  onWorkspaceRestore: (callback: (workspacePath: string) => void) => { dispose: () => void };
  // Window Controls
  newWindow: () => void;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  // Native edit commands
  edit: {
    undo: () => void;
    redo: () => void;
    cut: () => void;
    copy: () => void;
    paste: () => void;
    selectAll: () => void;
  };
  // Terminal
  terminalCreate: (opts: { cwd?: string; cols?: number; rows?: number }) => Promise<{ id: string }>;
  terminalWrite: (id: string, data: string) => void;
  terminalResize: (id: string, cols: number, rows: number) => void;
  terminalKill: (id: string) => void;
  terminalSendCommand: (id: string, command: string) => void;
  terminalOnData: (id: string, callback: (data: string) => void) => { dispose: () => void };
  terminalOnExit: (id: string, callback: (code: number) => void) => { dispose: () => void };
  // Clipboard
  readClipboard: () => Promise<string>;
  revealInFolder: (targetPath: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;
  // GitHub OAuth (device flow)
  github: {
    getAuth: () => Promise<{ authenticated: boolean; login: string | null; clientId: string | null }>;
    setClientId: (clientId: string) => Promise<boolean>;
    startDeviceFlow: () => Promise<{ userCode: string; verificationUri: string; expiresIn: number }>;
    waitForToken: () => Promise<{ login: string }>;
    cancelDeviceFlow: () => Promise<boolean>;
    logout: () => Promise<boolean>;
  };
  // Live Server (built-in HTTP server on port 5500)
  liveServer: {
    start: (htmlPath: string) => Promise<{
      active: boolean;
      port: number | null;
      root: string | null;
      htmlFile: string | null;
      url: string | null;
    }>;
    stop: () => Promise<boolean>;
    status: () => Promise<{
      active: boolean;
      port: number | null;
      root: string | null;
      htmlFile: string | null;
      url: string | null;
    }>;
    onStatusChange: (
      callback: (payload: {
        active: boolean;
        port: number | null;
        root: string | null;
        htmlFile: string | null;
        url: string | null;
      }) => void,
    ) => { dispose: () => void };
  };
  // LSP (typescript-language-server)
  lsp: {
    start: (workspacePath: string) => Promise<boolean>;
    stop: () => Promise<boolean>;
    request: (method: string, params: any) => Promise<any>;
    notification: (method: string, params: any) => void;
    /** Subscribe to `textDocument/publishDiagnostics` notifications. */
    onDiagnostics: (callback: (params: any) => void) => { dispose: () => void };
    /** Subscribe to all other LSP notifications (raw method + params). */
    onNotification: (callback: (method: string, params: any) => void) => { dispose: () => void };
  };
  // AI / Agent
  ai: {
    listProviders: () => Promise<any[]>;
    getConfig: () => Promise<{
      configuredProviders: string[];
      activeProvider: string | null;
      activeModel: string | null;
    }>;
    setApiKey: (provider: string, apiKey: string) => Promise<boolean>;
    removeApiKey: (provider: string) => Promise<boolean>;
    setActive: (provider: string, model: string) => Promise<boolean>;
    listModels: (provider: string) => Promise<string[]>;
    chatStream: (args: {
      streamId: string;
      provider: string;
      model: string;
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    }) => Promise<boolean>;
    abortStream: (streamId: string) => Promise<boolean>;
    onStream: (
      streamId: string,
      callback: (event: 'delta' | 'done' | 'error', data: any) => void,
    ) => { dispose: () => void };
  };
  // Git (Source Control)
  git: {
    status: (workspacePath: string) => Promise<{
      isRepo: boolean;
      branch: string | null;
      changes: { relPath: string; x: string; y: string }[];
      ahead: number;
      behind: number;
      hasUpstream: boolean;
      hasRemote: boolean;
    }>;
    stage: (workspacePath: string, relPaths: string[]) => Promise<boolean>;
    unstage: (workspacePath: string, relPaths: string[]) => Promise<boolean>;
    commit: (workspacePath: string, message: string) => Promise<string>;
    push: (workspacePath: string) => Promise<string>;
    pull: (workspacePath: string) => Promise<string>;
    diffSummary: (workspacePath: string) => Promise<{ staged: boolean; text: string }>;
    discard: (workspacePath: string, relPaths: string[]) => Promise<boolean>;
    diff: (workspacePath: string, relPath: string, staged?: boolean) => Promise<string>;
    fileVersions: (
      workspacePath: string,
      relPath: string,
      staged?: boolean,
    ) => Promise<{ original: string; modified: string }>;
    commitFileVersions: (
      workspacePath: string,
      relPath: string,
      commitHash: string,
    ) => Promise<{ original: string; modified: string }>;
    log: (workspacePath: string, relPath?: string, limit?: number) => Promise<any[]>;
  };
  // Extensions (VSIX / Open VSX)
  ext: {
    installVsix: () => Promise<InstalledExtensionPayload | null>;
    installFromOpenVsx: (extensionId: string) => Promise<InstalledExtensionPayload>;
    searchOpenVsx: (query: string, size?: number) => Promise<MarketplaceSearchPayload>;
    detail: (extensionId: string) => Promise<MarketplaceExtensionDetailPayload>;
    list: () => Promise<ExtensionListPayload>;
    uninstall: (id: string) => Promise<boolean>;
    setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
    checkUpdates: () => Promise<ExtensionUpdatePayload[]>;
    rollback: (id: string) => Promise<InstalledExtensionPayload>;
    listConfiguration: () => Promise<ExtensionConfigurationValuePayload[]>;
    /** `undefined` clears the value in the given scope (default: user). */
    setConfigurationValue: (
      key: string,
      value: unknown,
      scope?: 'user' | 'workspace',
    ) => Promise<boolean>;
    /** Fires after every configuration write ('*' = workspace switched). */
    onConfigurationChanged: (
      callback: (key: string) => void,
    ) => { dispose: () => void };
    /** Trust of the open workspace; Restricted Mode is the default. */
    trustStatus: () => Promise<WorkspaceTrustStatus>;
    /** Records that the user trusts the open workspace. Rejects when there
     *  is none open or it is remote. */
    grantWorkspaceTrust: () => Promise<WorkspaceTrustStatus>;
    /** Returns the open workspace to Restricted Mode. */
    revokeWorkspaceTrust: () => Promise<WorkspaceTrustStatus>;
    /** Fires after every trust decision and on workspace switch. */
    onTrustChanged: (
      callback: (status: WorkspaceTrustStatus) => void,
    ) => { dispose: () => void };
    /** Extension host: observable state only — the renderer never speaks
     *  to the host directly, main brokers every exchange. */
    hostState: () => Promise<ExtensionHostStatePayload>;
    restartHost: () => Promise<ExtensionHostStatePayload>;
    /** State transitions, aggregated logs and dropped-message notices. */
    onHostEvent: (
      callback: (event: ExtensionHostEventPayload) => void,
    ) => { dispose: () => void };
    /** Commands the live generation has registered. */
    hostCommands: () => Promise<ExtensionCommandRegistration[]>;
    /** Pushed whenever that set changes (activation, deactivation, restart). */
    onHostCommandsChanged: (
      callback: (commands: ExtensionCommandRegistration[]) => void,
    ) => { dispose: () => void };
    /** Runs an extension command, activating its owner on demand. */
    executeCommand: (command: string, args?: unknown[]) => Promise<ExtensionCommandResult>;
    /** Activation timings and failures of the live generation. */
    activationReport: () => Promise<ExtensionActivationReport>;
    onActivationChanged: (
      callback: (report: ExtensionActivationReport) => void,
    ) => { dispose: () => void };
    /** Reports the language the user is looking at, for `onLanguage:`. */
    notifyLanguage: (language: string) => void;
    /** Mirrors an open buffer for `workspace.textDocuments`. */
    syncDocument: (event: DocumentSyncPayload) => void;
    /** Publishes the editor layout for `window.activeTextEditor`. */
    syncEditors: (payload: EditorSyncPayload) => void;
    /** Extensions asking to reveal a document (`showTextDocument`). */
    onShowDocument: (
      callback: (request: EditorShowRequest) => void,
    ) => { dispose: () => void };
    /** Answers one, with whether the document ended up visible. */
    respondShowDocument: (id: number, shown: boolean) => void;
    /** Extensions editing an open buffer (`applyEdit`). */
    onApplyEdits: (
      callback: (request: EditorApplyEditsRequest) => void,
    ) => { dispose: () => void };
    /** Answers one, with whether the edits were applied. */
    respondApplyEdits: (id: number, applied: boolean) => void;
    /** Messages extensions ask Forge to show (`window.show*Message`). */
    onHostMessage: (
      callback: (message: ExtensionHostMessage) => void,
    ) => { dispose: () => void };
    /** Answers one, with the picked item or null when dismissed. */
    respondHostMessage: (id: number, selection: string | null) => void;
    /** Safe Mode: Forge running with every extension inert. */
    safeModeStatus: () => Promise<SafeModeStatus>;
    setSafeMode: (enabled: boolean, reason?: string) => Promise<SafeModeResult>;
    onSafeModeChanged: (
      callback: (status: SafeModeStatus) => void,
    ) => { dispose: () => void };
    setActiveTheme: (themeId: string | null) => Promise<boolean>;
    setActiveIconTheme: (iconThemeId: string | null) => Promise<boolean>;
  };
  // Claude Code IDE bridge
  claudeIde: {
    updateEditorState: (state: ClaudeIdeEditorState) => void;
    updateSelection: (selection: ClaudeIdeSelection | null) => void;
    status: () => Promise<Record<string, string>>;
    onCommand: (
      callback: (command: string, args: any) => Promise<any> | any,
    ) => { dispose: () => void };
  };
  // Forge per-project metadata (.forge/)
  forge: {
    readHistory: (workspacePath: string) => Promise<any[] | null>;
    writeHistory: (workspacePath: string, messages: any[]) => Promise<boolean>;
    ensureForgeDir: (workspacePath: string) => Promise<boolean>;
    hasHistory: (workspacePath: string) => Promise<boolean>;
  };
  agent: {
    leerArchivo: (workspacePath: string, ruta: string) => Promise<{
      path: string;
      content: string;
      bytes: number;
    }>;
    escribirArchivo: (
      workspacePath: string,
      ruta: string,
      contenido: string,
    ) => Promise<{ path: string; existed: boolean; bytes: number }>;
    listarCarpeta: (workspacePath: string, ruta: string) => Promise<{
      path: string;
      entries: { name: string; type: 'file' | 'directory' }[];
    }>;
    buscarEnProyecto: (workspacePath: string, texto: string) => Promise<{
      query: string;
      matches: { path: string; line: number; preview: string }[];
      truncated: boolean;
    }>;
    reemplazarEnProyecto: (
      workspacePath: string,
      search: string,
      replace: string,
      options?: { previewOnly?: boolean },
    ) => Promise<any>;
    initContext: (workspacePath: string) => Promise<{
      tree: string;
      manifestFiles: { path: string; relPath: string; content: string }[];
    }>;
    snapshotFolder: (
      workspacePath: string,
      folderPath: string,
    ) => Promise<{ path: string; relPath: string; content: string }[]>;
    fileExists: (workspacePath: string, ruta: string) => Promise<boolean>;
    readFileSafe: (workspacePath: string, ruta: string) => Promise<string | null>;
  };
}

// We track the wrapped IPC handlers per user-supplied callback so that
// offFsChanged() can remove the right listener.
const fsChangedHandlers = new WeakMap<
  (event: FsChangeEvent) => void,
  (_event: unknown, payload: FsChangeEvent) => void
>();
const allFsChangedHandlers = new Set<(_event: unknown, payload: FsChangeEvent) => void>();

// Main can finish loading before React registers its restore effect. Keep
// this listener alive from preload startup, independently of UI lifetimes.
const workspaceRestore = new BufferedStartupEvent<string>((error) => {
  console.error('[forge] onWorkspaceRestore callback error:', error);
});
ipcRenderer.on('workspace:restore', (_event, workspacePath: unknown) => {
  if (typeof workspacePath === 'string' && workspacePath) workspaceRestore.publish(workspacePath);
});

contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  remote: {
    connect: (args: { target: string; path: string }) =>
      ipcRenderer.invoke('remote:connect', args),
    browse: (args: { target: string; path: string }) =>
      ipcRenderer.invoke('remote:browse', args),
  },
  // File System
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  readImageDataUrl: (filePath: string) =>
    ipcRenderer.invoke('fs:readImageDataUrl', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  createFile: (filePath: string) => ipcRenderer.invoke('fs:createFile', filePath),
  createDirectory: (dirPath: string) => ipcRenderer.invoke('fs:createDirectory', dirPath),
  deleteItem: (itemPath: string) => ipcRenderer.invoke('fs:deleteItem', itemPath),
  renameItem: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:renameItem', oldPath, newPath),
  // Workspace watcher
  watchWorkspace: (dirPath: string) => ipcRenderer.invoke('fs:watch', dirPath),
  unwatchWorkspace: () => ipcRenderer.invoke('fs:unwatch'),
  onFsChanged: (callback: (event: FsChangeEvent) => void) => {
    const handler = (_event: unknown, payload: FsChangeEvent) => {
      try {
        callback(payload);
      } catch (err) {
        console.error('[forge] onFsChanged callback error:', err);
      }
    };
    fsChangedHandlers.set(callback, handler);
    allFsChangedHandlers.add(handler);
    ipcRenderer.on('fs:changed', handler);
  },
  offFsChanged: (callback?: (event: FsChangeEvent) => void) => {
    if (callback) {
      const handler = fsChangedHandlers.get(callback);
      if (handler) {
        ipcRenderer.removeListener('fs:changed', handler);
        fsChangedHandlers.delete(callback);
        allFsChangedHandlers.delete(handler);
      }
    } else {
      // Remove every handler we know about.
      for (const handler of allFsChangedHandlers) {
        ipcRenderer.removeListener('fs:changed', handler);
      }
      allFsChangedHandlers.clear();
    }
  },
  onWorkspaceRestore: (callback: (workspacePath: string) => void) => workspaceRestore.subscribe(callback),
  // Window Controls
  newWindow: () => ipcRenderer.send('window:new'),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  // Native edit commands
  edit: {
    undo: () => ipcRenderer.send('edit:undo'),
    redo: () => ipcRenderer.send('edit:redo'),
    cut: () => ipcRenderer.send('edit:cut'),
    copy: () => ipcRenderer.send('edit:copy'),
    paste: () => ipcRenderer.send('edit:paste'),
    selectAll: () => ipcRenderer.send('edit:selectAll'),
  },
  // Terminal
  terminalCreate: (opts: { cwd?: string; cols?: number; rows?: number }) =>
    ipcRenderer.invoke('terminal:create', opts),
  terminalWrite: (id: string, data: string) =>
    ipcRenderer.send('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  terminalKill: (id: string) =>
    ipcRenderer.send('terminal:kill', id),
  terminalSendCommand: (id: string, command: string) =>
    ipcRenderer.send('terminal:sendCommand', id, command),
  // Clipboard
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  revealInFolder: (targetPath: string) => ipcRenderer.invoke('shell:revealInFolder', targetPath),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  github: {
    getAuth: () => ipcRenderer.invoke('github:getAuth'),
    setClientId: (clientId: string) => ipcRenderer.invoke('github:setClientId', clientId),
    startDeviceFlow: () => ipcRenderer.invoke('github:startDeviceFlow'),
    waitForToken: () => ipcRenderer.invoke('github:waitForToken'),
    cancelDeviceFlow: () => ipcRenderer.invoke('github:cancelDeviceFlow'),
    logout: () => ipcRenderer.invoke('github:logout'),
  },
  // ── Live Server ───────────────────────────────────────────────────
  liveServer: {
    start: (htmlPath: string) => ipcRenderer.invoke('liveServer:start', htmlPath),
    stop: () => ipcRenderer.invoke('liveServer:stop'),
    status: () => ipcRenderer.invoke('liveServer:status'),
    onStatusChange: (
      callback: (payload: {
        active: boolean;
        port: number | null;
        root: string | null;
        htmlFile: string | null;
        url: string | null;
      }) => void,
    ) => {
      const channel = 'liveServer:status';
      const handler = (
        _event: unknown,
        payload: {
          active: boolean;
          port: number | null;
          root: string | null;
          htmlFile: string | null;
          url: string | null;
        },
      ) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] liveServer.onStatusChange callback error:', err);
        }
      };
      ipcRenderer.on(channel, handler);
      return { dispose: () => ipcRenderer.removeListener(channel, handler) };
    },
  },
  terminalOnData: (id: string, callback: (data: string) => void) => {
    const channel = `terminal:data:${id}`;
    const handler = (_event: unknown, data: string) => callback(data);
    ipcRenderer.on(channel, handler);
    return { dispose: () => ipcRenderer.removeListener(channel, handler) };
  },
  terminalOnExit: (id: string, callback: (code: number) => void) => {
    const channel = `terminal:exit:${id}`;
    const handler = (_event: unknown, code: number) => callback(code);
    ipcRenderer.on(channel, handler);
    return { dispose: () => ipcRenderer.removeListener(channel, handler) };
  },
  // LSP — the main process owns the language server process; we just shuttle
  // messages back and forth.
  lsp: {
    start: (workspacePath: string) => ipcRenderer.invoke('lsp:start', workspacePath),
    stop: () => ipcRenderer.invoke('lsp:stop'),
    request: (method: string, params: any) =>
      ipcRenderer.invoke('lsp:request', method, params),
    notification: (method: string, params: any) =>
      ipcRenderer.send('lsp:notification', method, params),
    onDiagnostics: (callback: (params: any) => void) => {
      const channel = 'lsp:notification';
      const handler = (
        _event: unknown,
        payload: { method: string; params: any }
      ) => {
        if (payload && payload.method === 'textDocument/publishDiagnostics') {
          try {
            callback(payload.params);
          } catch (err) {
            console.error('[forge] lsp.onDiagnostics callback error:', err);
          }
        }
      };
      ipcRenderer.on(channel, handler);
      return { dispose: () => ipcRenderer.removeListener(channel, handler) };
    },
    onNotification: (callback: (method: string, params: any) => void) => {
      const channel = 'lsp:notification';
      const handler = (
        _event: unknown,
        payload: { method: string; params: any }
      ) => {
        if (!payload) return;
        try {
          callback(payload.method, payload.params);
        } catch (err) {
          console.error('[forge] lsp.onNotification callback error:', err);
        }
      };
      ipcRenderer.on(channel, handler);
      return { dispose: () => ipcRenderer.removeListener(channel, handler) };
    },
  },
  // ── AI / Agent ────────────────────────────────────────────────────
  ai: {
    listProviders: () => ipcRenderer.invoke('ai:listProviders'),
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    setApiKey: (provider: string, apiKey: string) =>
      ipcRenderer.invoke('ai:setApiKey', provider, apiKey),
    removeApiKey: (provider: string) =>
      ipcRenderer.invoke('ai:removeApiKey', provider),
    setActive: (provider: string, model: string) =>
      ipcRenderer.invoke('ai:setActive', provider, model),
    listModels: (provider: string) =>
      ipcRenderer.invoke('ai:listModels', provider),
    chatStream: (args: {
      streamId: string;
      provider: string;
      model: string;
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
    }) => ipcRenderer.invoke('ai:chatStream', args),
    abortStream: (streamId: string) =>
      ipcRenderer.invoke('ai:abortStream', streamId),
    onStream: (
      streamId: string,
      callback: (event: 'delta' | 'done' | 'error', data: any) => void,
    ) => {
      const channel = `ai:stream:${streamId}`;
      const handler = (
        _event: unknown,
        payload: { event: 'delta' | 'done' | 'error'; data: any },
      ) => {
        try {
          callback(payload.event, payload.data);
        } catch (err) {
          console.error('[forge] ai.onStream callback error:', err);
        }
      };
      ipcRenderer.on(channel, handler);
      return { dispose: () => ipcRenderer.removeListener(channel, handler) };
    },
  },
  // ── Git (Source Control) ──────────────────────────────────────────
  git: {
    status: (workspacePath: string) => ipcRenderer.invoke('git:status', workspacePath),
    stage: (workspacePath: string, relPaths: string[]) =>
      ipcRenderer.invoke('git:stage', workspacePath, relPaths),
    unstage: (workspacePath: string, relPaths: string[]) =>
      ipcRenderer.invoke('git:unstage', workspacePath, relPaths),
    commit: (workspacePath: string, message: string) =>
      ipcRenderer.invoke('git:commit', workspacePath, message),
    push: (workspacePath: string) => ipcRenderer.invoke('git:push', workspacePath),
    pull: (workspacePath: string) => ipcRenderer.invoke('git:pull', workspacePath),
    branches: (workspacePath: string) => ipcRenderer.invoke('git:branches', workspacePath),
    checkoutBranch: (workspacePath: string, branchName: string) =>
      ipcRenderer.invoke('git:checkoutBranch', workspacePath, branchName),
    createBranch: (workspacePath: string, branchName: string) =>
      ipcRenderer.invoke('git:createBranch', workspacePath, branchName),
    diffSummary: (workspacePath: string) => ipcRenderer.invoke('git:diffSummary', workspacePath),
    discard: (workspacePath: string, relPaths: string[]) =>
      ipcRenderer.invoke('git:discard', workspacePath, relPaths),
    diff: (workspacePath: string, relPath: string, staged?: boolean) =>
      ipcRenderer.invoke('git:diff', workspacePath, relPath, staged),
    fileVersions: (workspacePath: string, relPath: string, staged?: boolean) =>
      ipcRenderer.invoke('git:fileVersions', workspacePath, relPath, staged),
    commitFileVersions: (workspacePath: string, relPath: string, commitHash: string) =>
      ipcRenderer.invoke('git:commitFileVersions', workspacePath, relPath, commitHash),
    log: (workspacePath: string, relPath?: string, limit?: number) =>
      ipcRenderer.invoke('git:log', workspacePath, relPath, limit),
  },
  // ── Extensions (VSIX) ─────────────────────────────────────────────
  ext: {
    installVsix: () => ipcRenderer.invoke('ext:installVsix'),
    installFromOpenVsx: (extensionId: string) =>
      ipcRenderer.invoke('ext:installFromOpenVsx', extensionId),
    searchOpenVsx: (query: string, size?: number) =>
      ipcRenderer.invoke('ext:searchOpenVsx', query, size),
    detail: (extensionId: string) => ipcRenderer.invoke('ext:detail', extensionId),
    list: () => ipcRenderer.invoke('ext:list'),
    uninstall: (id: string) => ipcRenderer.invoke('ext:uninstall', id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('ext:setEnabled', id, enabled),
    checkUpdates: () => ipcRenderer.invoke('ext:checkUpdates'),
    rollback: (id: string) => ipcRenderer.invoke('ext:rollback', id),
    listConfiguration: () => ipcRenderer.invoke('ext:config:list'),
    setConfigurationValue: (key: string, value: unknown, scope?: 'user' | 'workspace') =>
      ipcRenderer.invoke('ext:config:set', key, value, scope),
    onConfigurationChanged: (callback: (key: string) => void) => {
      const handler = (_event: unknown, payload: { key?: string }) => {
        try {
          callback(typeof payload?.key === 'string' ? payload.key : '*');
        } catch (err) {
          console.error('[forge] onConfigurationChanged callback error:', err);
        }
      };
      ipcRenderer.on('ext:config:changed', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:config:changed', handler),
      };
    },
    hostState: () => ipcRenderer.invoke('ext:host:state'),
    restartHost: () => ipcRenderer.invoke('ext:host:restart'),
    onHostEvent: (callback: (event: ExtensionHostEventPayload) => void) => {
      const handler = (_event: unknown, payload: ExtensionHostEventPayload) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onHostEvent callback error:', err);
        }
      };
      ipcRenderer.on('ext:host:event', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:host:event', handler),
      };
    },
    hostCommands: () => ipcRenderer.invoke('ext:host:commands'),
    onHostCommandsChanged: (callback: (commands: ExtensionCommandRegistration[]) => void) => {
      const handler = (_event: unknown, payload: ExtensionCommandRegistration[]) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onHostCommandsChanged callback error:', err);
        }
      };
      ipcRenderer.on('ext:host:commands', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:host:commands', handler),
      };
    },
    executeCommand: (command: string, args: unknown[] = []) =>
      ipcRenderer.invoke('ext:command:execute', command, args),
    activationReport: () => ipcRenderer.invoke('ext:host:activation'),
    onActivationChanged: (callback: (report: ExtensionActivationReport) => void) => {
      const handler = (_event: unknown, payload: ExtensionActivationReport) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onActivationChanged callback error:', err);
        }
      };
      ipcRenderer.on('ext:host:activation', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:host:activation', handler),
      };
    },
    // Fire-and-forget: `send`, not `invoke`. Opening a file must not wait
    // on an extension activating, nor fail when one does.
    notifyLanguage: (language: string) => ipcRenderer.send('ext:activate:language', language),
    syncDocument: (event: DocumentSyncPayload) => ipcRenderer.send('ext:documents:sync', event),
    syncEditors: (payload: EditorSyncPayload) => ipcRenderer.send('ext:editors:sync', payload),
    onShowDocument: (callback: (request: EditorShowRequest) => void) => {
      const handler = (_event: unknown, payload: EditorShowRequest) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onShowDocument callback error:', err);
        }
      };
      ipcRenderer.on('ext:editor:show', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:editor:show', handler),
      };
    },
    respondShowDocument: (id: number, shown: boolean) =>
      ipcRenderer.send('ext:editor:shown', id, shown),
    onApplyEdits: (callback: (request: EditorApplyEditsRequest) => void) => {
      const handler = (_event: unknown, payload: EditorApplyEditsRequest) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onApplyEdits callback error:', err);
        }
      };
      ipcRenderer.on('ext:editor:applyEdits', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:editor:applyEdits', handler),
      };
    },
    respondApplyEdits: (id: number, applied: boolean) =>
      ipcRenderer.send('ext:editor:editsApplied', id, applied),
    onHostMessage: (callback: (message: ExtensionHostMessage) => void) => {
      const handler = (_event: unknown, payload: ExtensionHostMessage) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onHostMessage callback error:', err);
        }
      };
      ipcRenderer.on('ext:host:message', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:host:message', handler),
      };
    },
    respondHostMessage: (id: number, selection: string | null) =>
      ipcRenderer.send('ext:host:message:respond', id, selection),
    safeModeStatus: () => ipcRenderer.invoke('ext:safe-mode:status'),
    setSafeMode: (enabled: boolean, reason?: string) =>
      ipcRenderer.invoke('ext:safe-mode:set', enabled, reason),
    onSafeModeChanged: (callback: (status: SafeModeStatus) => void) => {
      const handler = (_event: unknown, payload: SafeModeStatus) => {
        try {
          callback(payload);
        } catch (err) {
          console.error('[forge] onSafeModeChanged callback error:', err);
        }
      };
      ipcRenderer.on('ext:safe-mode:changed', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:safe-mode:changed', handler),
      };
    },
    trustStatus: () => ipcRenderer.invoke('ext:trust:status'),
    grantWorkspaceTrust: () => ipcRenderer.invoke('ext:trust:grant'),
    revokeWorkspaceTrust: () => ipcRenderer.invoke('ext:trust:revoke'),
    onTrustChanged: (callback: (status: WorkspaceTrustStatus) => void) => {
      const handler = (_event: unknown, status: WorkspaceTrustStatus) => {
        try {
          callback(status);
        } catch (err) {
          console.error('[forge] onTrustChanged callback error:', err);
        }
      };
      ipcRenderer.on('ext:trust:changed', handler);
      return {
        dispose: () => ipcRenderer.removeListener('ext:trust:changed', handler),
      };
    },
    setActiveTheme: (themeId: string | null) =>
      ipcRenderer.invoke('ext:setActiveTheme', themeId),
    setActiveIconTheme: (iconThemeId: string | null) =>
      ipcRenderer.invoke('ext:setActiveIconTheme', iconThemeId),
  },
  // ── Claude Code IDE bridge ────────────────────────────────────────
  claudeIde: {
    updateEditorState: (state: ClaudeIdeEditorState) =>
      ipcRenderer.send('claude:editorStateChanged', state),
    updateSelection: (selection: ClaudeIdeSelection | null) =>
      ipcRenderer.send('claude:selectionChanged', selection),
    status: () => ipcRenderer.invoke('claude:status'),
    onCommand: (
      callback: (command: string, args: any) => Promise<any> | any,
    ) => {
      const channel = 'claude:renderer-request';
      const handler = async (
        _event: unknown,
        payload: { id: number; command: string; args: any },
      ) => {
        if (!payload || typeof payload.id !== 'number') return;
        try {
          const result = await callback(payload.command, payload.args);
          ipcRenderer.send('claude:renderer-response', {
            id: payload.id,
            ok: true,
            result,
          });
        } catch (err) {
          ipcRenderer.send('claude:renderer-response', {
            id: payload.id,
            ok: false,
            error: (err as Error)?.message || String(err),
          });
        }
      };
      ipcRenderer.on(channel, handler);
      return { dispose: () => ipcRenderer.removeListener(channel, handler) };
    },
  },
  // ── Forge per-project metadata (.forge/) ──────────────────────────
  forge: {
    readHistory: (workspacePath: string) =>
      ipcRenderer.invoke('forge:readHistory', workspacePath),
    writeHistory: (workspacePath: string, messages: any[]) =>
      ipcRenderer.invoke('forge:writeHistory', workspacePath, messages),
    ensureForgeDir: (workspacePath: string) =>
      ipcRenderer.invoke('forge:ensureForgeDir', workspacePath),
    hasHistory: (workspacePath: string) =>
      ipcRenderer.invoke('forge:hasHistory', workspacePath),
  },
  agent: {
    leerArchivo: (workspacePath: string, ruta: string) =>
      ipcRenderer.invoke('agent:leerArchivo', workspacePath, ruta),
    escribirArchivo: (workspacePath: string, ruta: string, contenido: string) =>
      ipcRenderer.invoke('agent:escribirArchivo', workspacePath, ruta, contenido),
    listarCarpeta: (workspacePath: string, ruta: string) =>
      ipcRenderer.invoke('agent:listarCarpeta', workspacePath, ruta),
    buscarEnProyecto: (workspacePath: string, texto: string) =>
      ipcRenderer.invoke('agent:buscarEnProyecto', workspacePath, texto),
    reemplazarEnProyecto: (
      workspacePath: string,
      search: string,
      replace: string,
      options?: { previewOnly?: boolean },
    ) => ipcRenderer.invoke('agent:reemplazarEnProyecto', workspacePath, search, replace, options),
    initContext: (workspacePath: string) =>
      ipcRenderer.invoke('agent:initContext', workspacePath),
    snapshotFolder: (workspacePath: string, folderPath: string) =>
      ipcRenderer.invoke('agent:snapshotFolder', workspacePath, folderPath),
    fileExists: (workspacePath: string, ruta: string) =>
      ipcRenderer.invoke('agent:fileExists', workspacePath, ruta),
    readFileSafe: (workspacePath: string, ruta: string) =>
      ipcRenderer.invoke('agent:readFileSafe', workspacePath, ruta),
  },
} as ElectronAPI);
