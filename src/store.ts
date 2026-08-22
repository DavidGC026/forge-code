import { create } from 'zustand';
import {
  TreeNode,
  Tab,
  SidebarPanel,
  BottomTab,
  CursorPosition,
  FsChangeEvent,
  getLanguageFromPath,
  isImageFile,
  AIMessage,
  LiveWrite,
  PendingDiff,
  ProviderId,
  InstalledExtension,
  MarketplaceExtension,
  GitChange,
  GitBranchEntry,
  GitLogEntry,
  Problem,
  AgentTerminalId,
  TerminalSession,
} from './types';
import { lspClient } from './lsp/client';
import { LayoutSlice, createLayoutSlice } from './store/slices/layoutSlice';
import { TerminalSlice, createTerminalSlice } from './store/slices/terminalSlice';
import { GitSlice, createGitSlice } from './store/slices/gitSlice';
import { RemoteSlice, createRemoteSlice } from './store/slices/remoteSlice';
import { ExtensionSlice, createExtensionSlice } from './store/slices/extensionSlice';
import { documentSyncService } from './extensions/registry';

export type SelectedNodeKind = 'file' | 'directory';

export interface SelectedNode {
  path: string;
  kind: SelectedNodeKind;
}

export interface EditorRevealRequest {
  id: number;
  filePath: string;
  selection?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

export interface OpenFilePathOptions {
  startText?: string;
  endText?: string;
  selectToEndOfLine?: boolean;
  makeFrontmost?: boolean;
  /** 1-based line to reveal and select (search results, git jumps). Takes
   *  precedence over startText/endText. */
  line?: number;
}

interface EditorState extends LayoutSlice, TerminalSlice, GitSlice, RemoteSlice, ExtensionSlice {
  // Workspace
  workspacePath: string | null;
  workspaceName: string | null;
  fileTree: TreeNode[];
  expandedFolders: Set<string>;

  // Sidebar selection (independent of which tab is active in the editor)
  selectedPath: string | null;
  selectedKind: SelectedNodeKind | null;

  // Tabs & Editor
  openTabs: Tab[];
  activeTabId: string | null;
  pendingEditorReveal: EditorRevealRequest | null;

  // Editor state
  cursorPosition: CursorPosition;
  commandPaletteOpen: boolean;
  /** Monaco / terminal font size in CSS pixels. */
  editorFontSize: number;
  autoSave: boolean;
  formatOnSave: boolean;
  wordWrap: boolean;
  minimapEnabled: boolean;
  tabSize: number;
  /** Git diff view mode — inline or side-by-side. */
  gitDiffMode: 'inline' | 'side-by-side';

  // ── Live Server ─────────────────────────────────────────────────────
  /** True while the local HTTP server (port 5500) is up. */
  liveServerActive: boolean;
  /** Port the server is bound to (always 5500 today, kept here for future
   *  configurability and to drive the UI label). */
  liveServerPort: number | null;
  /** Absolute path of the directory the server is rooted at. */
  liveServerRoot: string | null;
  /** File name (relative to root) of the HTML page that started the server. */
  liveServerHtmlFile: string | null;
  /** Public URL the user can open in their browser. */
  liveServerUrl: string | null;

  // ── AI Panel ────────────────────────────────────────────────────────
  aiPanelVisible: boolean;
  /** Modal: API-key configuration. */
  aiApiKeyModalOpen: boolean;
  /** Providers that have an API key stored (read from main process). */
  aiConfiguredProviders: ProviderId[];
  /** Currently-selected provider/model. */
  aiActiveProvider: ProviderId | null;
  aiActiveModel: string | null;
  /** Model lists by provider, populated lazily after key entry. */
  aiAvailableModels: Partial<Record<ProviderId, string[]>>;
  /** Whether the model dropdown is open. */
  aiModelMenuOpen: boolean;
  /** Whether /init has produced a PROJECT.md for the current workspace. */
  aiInitDone: boolean;
  /** Conversation messages. */
  aiMessages: AIMessage[];
  /** Loop state: idle | streaming | running_tool | awaiting_diff. */
  aiStatus: 'idle' | 'streaming' | 'running_tool' | 'awaiting_diff' | 'initializing';
  /** Bottom-bar status text under the input ("Generando..."). */
  aiStatusText: string;
  /** Pending diff awaiting user decision. */
  aiPendingDiff: PendingDiff | null;
  /** Promise resolver waiting on the diff decision. */
  aiPendingDiffResolver: ((accepted: boolean) => void) | null;

  // ── AI Panel actions ────────────────────────────────────────────────
  toggleAIPanel: () => void;
  setAIApiKeyModalOpen: (open: boolean) => void;
  openExtensionDetail: (ext: InstalledExtension | MarketplaceExtension) => void;
  refreshAIConfig: () => Promise<void>;
  setAIAvailableModels: (provider: ProviderId, models: string[]) => void;
  setAIActive: (provider: ProviderId, model: string) => Promise<void>;
  /** Remove an API key for a provider. If it was the active one, clear it. */
  removeAIProvider: (provider: ProviderId) => Promise<void>;
  setAIModelMenuOpen: (open: boolean) => void;
  addAIMessage: (msg: AIMessage) => void;
  updateAIMessage: (id: string, patch: Partial<AIMessage>) => void;
  appendToAIMessage: (id: string, text: string) => void;
  clearAIConversation: () => void;
  setAIStatus: (status: EditorState['aiStatus'], text?: string) => void;
  setAIInitDone: (done: boolean) => void;
  setAIPendingDiff: (
    diff: PendingDiff | null,
    resolver?: ((accepted: boolean) => void) | null,
  ) => void;
  /** Load conversation history from `.forge/history.json` of the current
   *  workspace (or the provided one). Replaces `aiMessages` and updates
   *  `aiInitDone` based on whether the file exists. */
  loadProjectHistory: (workspacePath: string) => Promise<void>;
  /** Best-effort persist the in-memory `aiMessages` array to
   *  `.forge/history.json`. Only writes when `.forge/` already exists. */
  saveProjectHistory: () => Promise<void>;
  /** Replace `aiMessages` with the loaded array (no IPC). */
  setAIMessages: (messages: AIMessage[]) => void;

  // Agent → editor streaming (real-time code writes)
  /** Set of absolute file paths currently being streamed by the agent.
   *  The Monaco editor consults this set inside its `onChange` handler so
   *  external value updates (driven by `agentStreamAppendTab`) do NOT
   *  trigger a feedback loop that reverts the streamed content back to the
   *  previous in-editor value. Populated by `agentStreamOpenTab` and
   *  cleared by `agentStreamFinalizeTab`. */
  agentStreamingPaths: Set<string>;
  /** Open / activate a tab for the file the agent is about to write,
   *  clearing its content so streamed chunks can be appended live. */
  agentStreamOpenTab: (workspaceRelPath: string) => string | null;
  /** Append decoded content (raw JS string, already unescaped) to the tab
   *  whose path matches `fullPath`. */
  agentStreamAppendTab: (fullPath: string, chunk: string) => void;
  /** After streaming completes, persist the file content to disk. */
  agentStreamFinalizeTab: (fullPath: string) => Promise<void>;
  /** Add / update a live-write entry on the given assistant message. */
  agentLiveWriteUpdate: (
    messageId: string,
    ruta: string,
    patch: Partial<LiveWrite>,
  ) => void;

  // ── Quick Open (Ctrl+P) ─────────────────────────────────────────────
  quickOpenOpen: boolean;
  setQuickOpenOpen: (open: boolean) => void;

  openGitDiff: (relPath: string, staged?: boolean) => Promise<void>;
  /** Open a historical diff for one commit (parent vs commit). */
  openGitCommitDiff: (relPath: string, entry: GitLogEntry) => Promise<void>;
  setGitDiffMode: (mode: 'inline' | 'side-by-side') => void;
  /** Toggle diff mode on the active git-diff tab, if any. */
  toggleActiveGitDiffMode: () => void;
  /** Registered by MonacoWrapper — formats the active editor document. */
  formatActiveDocument: (() => Promise<void>) | null;
  registerFormatActiveDocument: (fn: (() => Promise<void>) | null) => void;
  /** Registered by MonacoWrapper — runs a Monaco editor action by id
   *  (e.g. 'editor.action.gotoLine') on the active editor and focuses it. */
  runEditorAction: ((actionId: string) => Promise<void>) | null;
  registerRunEditorAction: (fn: ((actionId: string) => Promise<void>) | null) => void;
  /** Debounced auto-save scheduler (no-op when autoSave is off). */
  scheduleAutoSave: (tabId: string) => void;

  // ── Problems (LSP diagnostics) ──────────────────────────────────────
  problems: Problem[];
  updateProblemsForFile: (filePath: string, problems: Problem[]) => void;
  clearProblems: () => void;

  // Actions
  openFolder: (folderPath?: string) => Promise<void>;
  refreshFileTree: () => Promise<void>;
  /** Subscribe to file system change events from the workspace watcher.
   *  Re-fetches the file tree on every notification (debounced upstream
   *  in the main process). Returns an unsubscribe function. */
  subscribeToFsChanges: () => () => void;
  toggleFolder: (folderId: string) => void;
  expandFolder: (folderId: string) => void;
  openFile: (node: TreeNode) => Promise<void>;
  openFilePath: (
    filePath: string,
    options?: OpenFilePathOptions,
  ) => Promise<{
    success: boolean;
    filePath: string;
    languageId?: string;
    lineCount?: number;
    message?: string;
  }>;
  closeTab: (tabId: string) => void;
  /** Close every tab except the given one. */
  closeOtherTabs: (tabId: string) => void;
  closeAllTabs: () => void;
  /** Close every tab without unsaved changes. */
  closeSavedTabs: () => void;
  /** Activate the tab next to / before the active one (wraps around). */
  cycleTab: (direction: 1 | -1) => void;
  /** Pin/unpin a tab. Pinned tabs move to the front of the tab bar. */
  togglePinTab: (tabId: string) => void;
  /** Reorder tabs: move `sourceId` to `targetId`'s position (drag & drop).
   *  Pinned and unpinned tabs each stay within their own region. */
  moveTab: (sourceId: string, targetId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  clearPendingEditorReveal: (id: number) => void;
  saveFile: (tabId?: string) => Promise<void>;
  closeWorkspace: () => void;

  // ── Terminal Session ────────────────────────────────────────────────
  ensureTerminalSession: () => string;
  createTerminalSession: (label?: string) => string;
  closeTerminalSession: (sessionId: string) => void;
  setActiveTerminalSession: (sessionId: string) => void;
  registerTerminalPty: (sessionId: string, ptyId: string | null) => void;
  runCommandInTerminalSession: (sessionId: string, command: string) => void;
  runCommandInTerminal: (command: string) => void;
  /** Opens or focuses a dedicated terminal for an agent CLI. */
  runAgentInTerminal: (agentId: AgentTerminalId) => void;
  /** Send `cd "<path>"` (newline-appended) to the currently-active pty. */
  sendCdToActiveTerminal: (workspacePath: string) => void;
  setCursorPosition: (pos: CursorPosition) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  setAutoSave: (enabled: boolean) => void;
  setFormatOnSave: (enabled: boolean) => void;
  setWordWrap: (enabled: boolean) => void;
  setMinimapEnabled: (enabled: boolean) => void;
  setTabSize: (size: number) => void;
  setEditorFontSize: (size: number) => void;
  setSelectedPath: (selection: SelectedNode | null) => void;

  // ── Live Server actions ─────────────────────────────────────────────
  /** Boot the live server with the given HTML file (or its parent folder).
   *  If a server is already running it is restarted on the new file. */
  startLiveServer: (htmlPath: string) => Promise<void>;
  /** Stop the running live server, no-op if not active. */
  stopLiveServer: () => Promise<void>;
  /** Toggle the server using the currently-active HTML file as fallback. */
  toggleLiveServer: (htmlPath?: string) => Promise<void>;
  /** Refresh live-server state from the main process (called on startup). */
  refreshLiveServerStatus: () => Promise<void>;
  /** Internal: applied by the main-process status push channel. */
  _setLiveServerStatus: (payload: {
    active: boolean;
    port: number | null;
    root: string | null;
    htmlFile: string | null;
    url: string | null;
  }) => void;

  /** Resolve the directory in which a new item should be created based on the
   *  current sidebar selection. */
  resolveCreateParent: () => string | null;
  createNewFile: (parentPath: string, fileName: string) => Promise<void>;
  createNewDirectory: (parentPath: string, dirName: string) => Promise<void>;
  deleteItem: (itemPath: string) => Promise<void>;
  renameItem: (oldPath: string, newName: string) => Promise<void>;
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

function dirname(p: string): string {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  return idx === -1 ? p : p.substring(0, idx);
}

function isAbsolutePath(p: string): boolean {
  // Workspace providers use absolute URI-like identifiers (for example
  // ssh://host/path). Joining one of these to the workspace root corrupts it.
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(p);
}

function resolveWorkspacePath(workspacePath: string, filePath: string): string {
  if (isAbsolutePath(filePath)) return filePath;
  return joinPath(workspacePath, filePath);
}

function countLines(content: string): number {
  if (!content) return 1;
  return content.split(/\r\n|\r|\n/).length;
}

function indexToEditorPosition(content: string, index: number) {
  const safeIndex = Math.max(0, Math.min(index, content.length));
  let lineNumber = 1;
  let column = 1;
  for (let i = 0; i < safeIndex; i++) {
    const ch = content[i];
    if (ch === '\n') {
      lineNumber++;
      column = 1;
    } else {
      column++;
    }
  }
  return { lineNumber, column };
}

function findTextReveal(
  content: string,
  options?: OpenFilePathOptions,
): EditorRevealRequest['selection'] | undefined {
  if (options?.line && options.line > 0) {
    const lines = content.split('\n');
    const lineNumber = Math.min(options.line, lines.length);
    const lineText = lines[lineNumber - 1] ?? '';
    return {
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: lineText.length + 1,
    };
  }

  const startText = options?.startText;
  const endText = options?.endText;
  if (!startText && !endText) return undefined;

  const startIndex = startText ? content.indexOf(startText) : 0;
  if (startIndex < 0) return undefined;

  let endIndex = startText ? startIndex + startText.length : startIndex;
  if (endText) {
    const foundEnd = content.indexOf(endText, endIndex);
    if (foundEnd >= 0) {
      endIndex = foundEnd + endText.length;
    }
  }
  if (options?.selectToEndOfLine) {
    const newlineIndex = content.indexOf('\n', endIndex);
    endIndex = newlineIndex >= 0 ? newlineIndex : content.length;
  }

  const start = indexToEditorPosition(content, startIndex);
  const end = indexToEditorPosition(content, endIndex);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

const DEFAULT_EDITOR_FONT_SIZE = 14;
const MIN_EDITOR_FONT_SIZE = 8;
const MAX_EDITOR_FONT_SIZE = 32;
const EDITOR_FONT_SIZE_STEP = 1;
const SETTINGS_STORAGE_KEY = 'forge.editorSettings.v1';
interface PersistedEditorSettings {
  autoSave: boolean;
  formatOnSave: boolean;
  wordWrap: boolean;
  minimapEnabled: boolean;
  tabSize: number;
  gitDiffMode: 'inline' | 'side-by-side';
  editorFontSize: number;
}

const DEFAULT_EDITOR_SETTINGS: PersistedEditorSettings = {
  autoSave: false,
  formatOnSave: false,
  wordWrap: false,
  minimapEnabled: true,
  tabSize: 2,
  gitDiffMode: 'side-by-side',
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
};

function clampTabSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_EDITOR_SETTINGS.tabSize;
  return Math.max(1, Math.min(8, Math.round(size)));
}

function clampEditorFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, Math.round(size)));
}

function snapshotEditorSettings(state: Pick<
  EditorState,
  'autoSave' | 'formatOnSave' | 'wordWrap' | 'minimapEnabled' | 'tabSize' | 'gitDiffMode' | 'editorFontSize'
>): PersistedEditorSettings {
  return {
    autoSave: state.autoSave,
    formatOnSave: state.formatOnSave,
    wordWrap: state.wordWrap,
    minimapEnabled: state.minimapEnabled,
    tabSize: state.tabSize,
    gitDiffMode: state.gitDiffMode,
    editorFontSize: state.editorFontSize,
  };
}

function loadEditorSettings(): PersistedEditorSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_EDITOR_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      autoSave: Boolean(parsed?.autoSave),
      formatOnSave: Boolean(parsed?.formatOnSave),
      wordWrap: Boolean(parsed?.wordWrap),
      minimapEnabled:
        typeof parsed?.minimapEnabled === 'boolean'
          ? parsed.minimapEnabled
          : DEFAULT_EDITOR_SETTINGS.minimapEnabled,
      tabSize: clampTabSize(Number(parsed?.tabSize ?? DEFAULT_EDITOR_SETTINGS.tabSize)),
      gitDiffMode:
        parsed?.gitDiffMode === 'inline' || parsed?.gitDiffMode === 'side-by-side'
          ? parsed.gitDiffMode
          : DEFAULT_EDITOR_SETTINGS.gitDiffMode,
      editorFontSize: clampEditorFontSize(
        Number(parsed?.editorFontSize ?? DEFAULT_EDITOR_SETTINGS.editorFontSize),
      ),
    };
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

function persistEditorSettings(settings: PersistedEditorSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* best-effort */
  }
}

const initialEditorSettings = loadEditorSettings();


let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let autoSaveTabId: string | null = null;

/**
 * Tells main which language the user is looking at, so extensions declaring
 * `onLanguage:<id>` activate. Sent on open and on tab switch — VS Code
 * activates on both, and an extension that only woke on open would stay
 * dormant for a file the user already had open when it was installed.
 */
function notifyActiveLanguage(language: string | undefined | null): void {
  if (!language) return;
  try {
    window.electronAPI?.ext?.notifyLanguage?.(language);
  } catch {
    /* outside Electron there is no host to wake */
  }
}

export const useStore = create<EditorState>((set, get, api) => ({
  ...createLayoutSlice(set, get, api as any),
  ...createTerminalSlice(set, get, api as any),
  ...createGitSlice(set, get, api as any),
  ...createRemoteSlice(set, get, api as any),
  ...createExtensionSlice(set, get, api as any),
  // Initial state
  workspacePath: null,
  workspaceName: null,
  fileTree: [],
  expandedFolders: new Set<string>(),
  selectedPath: null,
  selectedKind: null,
  openTabs: [],
  activeTabId: null,
  pendingEditorReveal: null,

  cursorPosition: { line: 1, column: 1 },
  commandPaletteOpen: false,
  editorFontSize: initialEditorSettings.editorFontSize,
  autoSave: initialEditorSettings.autoSave,
  formatOnSave: initialEditorSettings.formatOnSave,
  wordWrap: initialEditorSettings.wordWrap,
  minimapEnabled: initialEditorSettings.minimapEnabled,
  tabSize: initialEditorSettings.tabSize,
  gitDiffMode: initialEditorSettings.gitDiffMode,

  // Live server initial state
  liveServerActive: false,
  liveServerPort: null,
  liveServerRoot: null,
  liveServerHtmlFile: null,
  liveServerUrl: null,

  // AI panel initial state
  aiPanelVisible: false,
  aiApiKeyModalOpen: false,
  aiConfiguredProviders: [],
  aiActiveProvider: null,
  aiActiveModel: null,
  aiAvailableModels: {},
  aiModelMenuOpen: false,
  aiInitDone: false,
  aiMessages: [],
  aiStatus: 'idle',
  aiStatusText: '',
  aiPendingDiff: null,
  aiPendingDiffResolver: null,

  // Agent streaming initial state
  agentStreamingPaths: new Set<string>(),

  // Quick Open initial state
  quickOpenOpen: false,

  // Git initial state
  gitIsRepo: false,
  gitBranch: null,
  gitBranches: [],
  gitChanges: [],
  gitAhead: 0,
  gitBehind: 0,
  gitHasUpstream: false,
  gitHasRemote: false,
  gitBusy: false,
  gitSyncBusy: false,
  gitError: null,
  problems: [],
  formatActiveDocument: null,
  runEditorAction: null,

  // ── Quick Open actions ──────────────────────────────────────────────
  setQuickOpenOpen: (open: boolean) => {
    set({ quickOpenOpen: open });
  },

  setGitDiffMode: (mode: 'inline' | 'side-by-side') => {
    set((state) => {
      persistEditorSettings({ ...snapshotEditorSettings(state), gitDiffMode: mode });
      return {
        gitDiffMode: mode,
        openTabs: state.openTabs.map((tab) =>
          tab.gitDiff ? { ...tab, gitDiff: { ...tab.gitDiff, mode } } : tab,
        ),
      };
    });
  },

  registerRunEditorAction: (fn) => {
    set({ runEditorAction: fn });
  },

  registerFormatActiveDocument: (fn) => {
    set({ formatActiveDocument: fn });
  },

  scheduleAutoSave: (tabId: string) => {
    if (!get().autoSave) return;
    autoSaveTabId = tabId;
    if (autoSaveTimer) window.clearTimeout(autoSaveTimer);
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = null;
      const id = autoSaveTabId;
      autoSaveTabId = null;
      if (!id) return;
      const tab = get().openTabs.find((t) => t.id === id);
      if (tab?.isUnsaved && !tab.gitDiff && !tab.imageDataUrl) {
        void get().saveFile(id);
      }
    }, 1000);
  },

  updateProblemsForFile: (filePath: string, problems: Problem[]) => {
    set((state) => ({
      problems: [
        ...state.problems.filter((p) => p.filePath !== filePath),
        ...problems,
      ].sort((a, b) => (
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine ||
        a.startColumn - b.startColumn
      )),
    }));
  },

  clearProblems: () => {
    set({ problems: [] });
  },

  // ── Extension actions (rest live in extensionSlice) ─────────────────
  openExtensionDetail: (ext: InstalledExtension | MarketplaceExtension) => {
    const tabId = `extension:${ext.id}`;
    const { openTabs } = get();
    const existing = openTabs.find((t) => t.id === tabId);
    if (existing) {
      set({ activeTabId: tabId });
      return;
    }
    const newTab: Tab = {
      id: tabId,
      name: ext.displayName || ('name' in ext ? ext.name : ext.id),
      path: `openvsx:${ext.id}`,
      content: '',
      savedContent: '',
      language: 'plaintext',
      isUnsaved: false,
      extension: ext as MarketplaceExtension,
    };
    set((state) => ({
      openTabs: [...state.openTabs, newTab],
      activeTabId: tabId,
    }));
  },

  // ── AI Panel actions ────────────────────────────────────────────────
  toggleAIPanel: () => {
    set((state) => ({ aiPanelVisible: !state.aiPanelVisible }));
  },

  setAIApiKeyModalOpen: (open: boolean) => set({ aiApiKeyModalOpen: open }),
  refreshAIConfig: async () => {
    try {
      const cfg = await window.electronAPI.ai.getConfig();
      set({
        aiConfiguredProviders: cfg.configuredProviders,
        aiActiveProvider: cfg.activeProvider,
        aiActiveModel: cfg.activeModel,
      });
    } catch (err) {
      console.warn('[forge] refreshAIConfig failed:', (err as Error)?.message);
    }
  },
  setAIAvailableModels: (provider, models) => {
    set((state) => ({
      aiAvailableModels: { ...state.aiAvailableModels, [provider]: models },
    }));
  },
  setAIActive: async (provider, model) => {
    // Optimistic update: write to the in-memory store IMMEDIATELY so the rest
    // of the renderer (TopBar label, runUserPrompt readers, etc.) reflects
    // the new selection on the very next tick. Persistence to disk is
    // best-effort and happens afterwards — even if it fails the current
    // session uses the new model.
    set({ aiActiveProvider: provider, aiActiveModel: model });
    try {
      await window.electronAPI.ai.setActive(provider, model);
      console.debug('[forge] setAIActive persisted:', provider, model);
    } catch (err) {
      console.warn('[forge] setAIActive persist failed:', (err as Error)?.message);
    }
  },
  /** Removes a provider's API key. If that provider was active, clears the
   *  active provider/model selection. Refreshes the configured-providers list. */
  removeAIProvider: async (provider) => {
    try {
      await window.electronAPI.ai.removeApiKey(provider);
    } catch (err) {
      console.warn('[forge] removeAIProvider failed:', (err as Error)?.message);
    }
    set((state) => {
      const wasActive = state.aiActiveProvider === provider;
      const nextAvailable = { ...state.aiAvailableModels };
      delete nextAvailable[provider];
      return {
        aiConfiguredProviders: state.aiConfiguredProviders.filter((p) => p !== provider),
        aiActiveProvider: wasActive ? null : state.aiActiveProvider,
        aiActiveModel: wasActive ? null : state.aiActiveModel,
        aiAvailableModels: nextAvailable,
      };
    });
    // Persist the cleared active selection if needed.
    const s = get();
    if (s.aiActiveProvider === null) {
      try {
        await window.electronAPI.ai.setActive('' as ProviderId, '');
      } catch {
        /* best-effort */
      }
    }
  },
  setAIModelMenuOpen: (open: boolean) => set({ aiModelMenuOpen: open }),
  addAIMessage: (msg) => {
    set((state) => ({ aiMessages: [...state.aiMessages, msg] }));
  },
  updateAIMessage: (id, patch) => {
    set((state) => ({
      aiMessages: state.aiMessages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  },
  appendToAIMessage: (id, text) => {
    set((state) => ({
      aiMessages: state.aiMessages.map((m) =>
        m.id === id ? { ...m, content: m.content + text } : m,
      ),
    }));
  },
  clearAIConversation: () => {
    set({
      aiMessages: [],
      aiStatus: 'idle',
      aiStatusText: '',
      aiPendingDiff: null,
      aiPendingDiffResolver: null,
    });
  },
  setAIStatus: (status, text) => {
    set({ aiStatus: status, aiStatusText: text ?? '' });
  },
  setAIInitDone: (done) => set({ aiInitDone: done }),
  setAIPendingDiff: (diff, resolver) => {
    set({ aiPendingDiff: diff, aiPendingDiffResolver: resolver ?? null });
  },
  setAIMessages: (messages) => set({ aiMessages: messages }),

  /** Load `.forge/history.json` from disk for the given workspace.
   *  Replaces aiMessages and toggles `aiInitDone` based on file existence. */
  loadProjectHistory: async (workspacePath) => {
    if (!workspacePath || !window.electronAPI?.forge) {
      set({ aiMessages: [], aiInitDone: false });
      return;
    }
    try {
      const history = await window.electronAPI.forge.readHistory(workspacePath);
      if (history === null) {
        // history.json does not exist → /init has not been run yet.
        set({
          aiMessages: [],
          aiInitDone: false,
          aiStatus: 'idle',
          aiStatusText: '',
          aiPendingDiff: null,
          aiPendingDiffResolver: null,
        });
        return;
      }
      // Sanitise: never restore a stale "streaming" flag on assistant
      // messages and drop any in-flight `liveWrites`. They cannot resume
      // across runs and would otherwise leak a stuck UI state.
      const safe = (Array.isArray(history) ? history : []).map((m: AIMessage) => ({
        ...m,
        streaming: false,
        liveWrites: m.liveWrites?.map((w) => ({ ...w, done: true })) ?? undefined,
      }));
      set({
        aiMessages: safe,
        aiInitDone: true,
        aiStatus: 'idle',
        aiStatusText: '',
        aiPendingDiff: null,
        aiPendingDiffResolver: null,
      });
    } catch (err) {
      console.warn('[forge] loadProjectHistory failed:', (err as Error)?.message);
      set({ aiMessages: [], aiInitDone: false });
    }
  },

  saveProjectHistory: async () => {
    const { workspacePath, aiMessages, aiInitDone } = get();
    if (!workspacePath || !window.electronAPI?.forge) return;
    // Don't write history for projects that haven't been /init-ed yet, to
    // avoid creating `.forge/` implicitly when the user is just exploring.
    if (!aiInitDone) return;
    try {
      await window.electronAPI.forge.writeHistory(workspacePath, aiMessages);
    } catch (err) {
      console.debug('[forge] saveProjectHistory failed:', (err as Error)?.message);
    }
  },

  // ── Agent → editor streaming ─────────────────────────────────────────
  agentStreamOpenTab: (workspaceRelPath: string) => {
    const { workspacePath, openTabs } = get();
    if (!workspacePath || !workspaceRelPath) return null;

    // Resolve the absolute path. The agent may pass either a relative path
    // or an absolute one inside the workspace.
    const sep = workspacePath.includes('\\') && !workspacePath.includes('/') ? '\\' : '/';
    const isAbs =
      workspaceRelPath.startsWith('/') ||
      /^[a-zA-Z]:[\\/]/.test(workspaceRelPath);
    const fullPath = isAbs
      ? workspaceRelPath
      : (workspacePath.endsWith(sep)
          ? workspacePath + workspaceRelPath
          : workspacePath + sep + workspaceRelPath
        ).replace(/[\\/]+/g, sep);

    const name = fullPath.split(/[\\/]/).pop() || fullPath;
    const language = getLanguageFromPath(fullPath);
    const existing = openTabs.find((t) => t.path === fullPath);

    if (existing) {
      // Reset content to '' so the streaming write feels like "typing into"
      // an empty buffer rather than appending after the old contents.
      //
      // ALSO mark `fullPath` as "currently streaming" so that the Monaco
      // editor's `onChange` callback ignores the change events that fire
      // while the agent rewrites the buffer programmatically. Without this
      // guard, Monaco's onChange races the next `agentStreamAppendTab`
      // `set()` and reverts `tab.content` back to a stale snapshot,
      // ultimately causing `agentStreamFinalizeTab` to persist OLD content.
      set((state) => {
        const nextStreaming = new Set(state.agentStreamingPaths);
        nextStreaming.add(fullPath);
        return {
          openTabs: state.openTabs.map((t) =>
            t.id === existing.id
              ? { ...t, content: '', isUnsaved: true, language }
              : t,
          ),
          activeTabId: existing.id,
          selectedPath: fullPath,
          selectedKind: 'file',
          agentStreamingPaths: nextStreaming,
        };
      });
      return fullPath;
    }

    const newTab: Tab = {
      id: fullPath,
      name,
      path: fullPath,
      content: '',
      savedContent: '',
      language,
      isUnsaved: true,
    };
    set((state) => {
      const nextStreaming = new Set(state.agentStreamingPaths);
      nextStreaming.add(fullPath);
      return {
        openTabs: [...state.openTabs, newTab],
        activeTabId: newTab.id,
        selectedPath: fullPath,
        selectedKind: 'file',
        agentStreamingPaths: nextStreaming,
      };
    });
    return fullPath;
  },

  agentStreamAppendTab: (fullPath, chunk) => {
    if (!chunk) return;
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.id === fullPath || t.path === fullPath
          ? { ...t, content: t.content + chunk, isUnsaved: true }
          : t,
      ),
    }));
  },

  agentStreamFinalizeTab: async (fullPath) => {
    const tab = get().openTabs.find((t) => t.id === fullPath || t.path === fullPath);
    if (!tab) {
      console.warn('[forge] agentStreamFinalizeTab: no tab matches', fullPath);
      // Still clear the streaming flag for this path so a future open of
      // the file isn't blocked by stale state.
      set((state) => {
        if (!state.agentStreamingPaths.has(fullPath)) return state;
        const nextStreaming = new Set(state.agentStreamingPaths);
        nextStreaming.delete(fullPath);
        return { agentStreamingPaths: nextStreaming };
      });
      return;
    }
    try {
      // Snapshot the streamed content BEFORE awaiting the disk write. If
      // Monaco somehow fires a reverting `onChange` between now and the
      // post-await `set()` (despite the `agentStreamingPaths` guard), we
      // still persist the right value to `savedContent` so the tab does
      // not show as "dirty" with stale content.
      const streamedContent = tab.content;
      await window.electronAPI.writeFile(tab.path, streamedContent);
      set((state) => {
        const nextStreaming = new Set(state.agentStreamingPaths);
        nextStreaming.delete(fullPath);
        nextStreaming.delete(tab.path);
        nextStreaming.delete(tab.id);
        return {
          openTabs: state.openTabs.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  // Force the tab content back to the streamed snapshot to
                  // overwrite any stale onChange that may have slipped in.
                  content: streamedContent,
                  savedContent: streamedContent,
                  isUnsaved: false,
                }
              : t,
          ),
          agentStreamingPaths: nextStreaming,
        };
      });
    } catch (err) {
      // Surface the failure loudly — silent failures here are the reason
      // streamed files used to appear in tabs but never land on disk.
      const msg = (err as Error)?.message || String(err);
      console.error('[forge] agentStreamFinalizeTab failed:', tab.path, msg);
      // Always clear the streaming flag, even on failure, so the editor
      // returns to normal interactive editing.
      set((state) => {
        const nextStreaming = new Set(state.agentStreamingPaths);
        nextStreaming.delete(fullPath);
        nextStreaming.delete(tab.path);
        nextStreaming.delete(tab.id);
        return { agentStreamingPaths: nextStreaming };
      });
      try {
        get().setAIStatus('idle', `Error al guardar ${tab.name}: ${msg}`);
      } catch {
        /* setAIStatus might not exist in some test paths; ignore */
      }
    }
  },

  agentLiveWriteUpdate: (messageId, ruta, patch) => {
    set((state) => ({
      aiMessages: state.aiMessages.map((m) => {
        if (m.id !== messageId) return m;
        const prev = m.liveWrites ?? [];
        const idx = prev.findIndex((w) => w.ruta === ruta);
        if (idx === -1) {
          return {
            ...m,
            liveWrites: [...prev, { ruta, done: false, ...patch }],
          };
        }
        const next = prev.slice();
        next[idx] = { ...next[idx], ...patch };
        return { ...m, liveWrites: next };
      }),
    }));
  },

  // ── Actions ──────────────────────────────────────────────────────────

  openFolder: async (folderPath?: string) => {
    try {
      // Defensive: this action is sometimes wired directly into onClick
      // handlers (e.g. <button onClick={openFolder} />), which would pass a
      // React SyntheticEvent as `folderPath`. That non-serializable object
      // cannot be cloned through Electron IPC and triggers the
      // "An object could not be cloned" error in the renderer. Coerce
      // non-string values to undefined so we fall back to the file dialog.
      const safeFolderPath = typeof folderPath === 'string' ? folderPath : undefined;

      const resolvedFolderPath =
        safeFolderPath ?? (await window.electronAPI.openFolder());
      if (!resolvedFolderPath || typeof resolvedFolderPath !== 'string') return;

      // Before switching, persist the outgoing project's conversation so
      // we don't lose any unsaved AI messages.
      try {
        await get().saveProjectHistory();
      } catch (err) {
        console.debug(
          '[forge] saveProjectHistory before switch failed:',
          (err as Error)?.message,
        );
      }

      const tree = await window.electronAPI.readDirectory(resolvedFolderPath);
      // Use a regex that handles both forward and back slashes (Windows paths
      // with only backslashes were previously returning the whole path here).
      const segments = resolvedFolderPath.split(/[\\/]/).filter(Boolean);
      const name = segments.length > 0 ? segments[segments.length - 1] : resolvedFolderPath;

      set({
        workspacePath: resolvedFolderPath,
        workspaceName: name,
        fileTree: Array.isArray(tree) ? tree : [],
        expandedFolders: new Set<string>(),
        selectedPath: null,
        selectedKind: null,
        openTabs: [],
        activeTabId: null,
        pendingEditorReveal: null,
        // Reset AI panel state — the loader below will rehydrate it.
        aiMessages: [],
        aiInitDone: false,
        aiStatus: 'idle',
        aiStatusText: '',
        aiPendingDiff: null,
        aiPendingDiffResolver: null,
      });

      // Start (or restart) the workspace file system watcher so external
      // changes (made from the OS file explorer, terminal, etc.) refresh
      // the sidebar tree automatically. The main process tears down any
      // previous watcher when a new path is supplied.
      try {
        await window.electronAPI.watchWorkspace(resolvedFolderPath);
      } catch (err) {
        console.error('Failed to start workspace watcher:', err);
      }

      // Populate the Source Control panel / status-bar branch label.
      void get().refreshGitStatus();

      // Spawn typescript-language-server for the new workspace. The LSP
      // client handles restarts (stops the previous server first) and
      // gracefully degrades if the binary isn't installed.
      try {
        await lspClient.startWorkspace(resolvedFolderPath);
      } catch (err) {
        console.debug(
          '[forge] LSP start skipped:',
          (err as Error)?.message
        );
      }

      // Load per-project conversation history from `.forge/history.json`.
      // If the file is missing, `aiInitDone` stays false (the panel will
      // prompt the user to run `/init`).
      try {
        await get().loadProjectHistory(resolvedFolderPath);
      } catch (err) {
        console.debug(
          '[forge] loadProjectHistory in openFolder failed:',
          (err as Error)?.message,
        );
      }

      // If there's already a live terminal, cd into the new workspace so
      // the user doesn't have to do it manually. We schedule it on a small
      // timeout to give any newly-attached terminal a chance to register
      // its id with the store first.
      try {
        get().sendCdToActiveTerminal(resolvedFolderPath);
      } catch (err) {
        console.debug('[forge] cd-to-workspace skipped:', (err as Error)?.message);
      }
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  },

  refreshFileTree: async () => {
    const { workspacePath } = get();
    if (!workspacePath) return;

    try {
      const tree = await window.electronAPI.readDirectory(workspacePath);
      set({ fileTree: tree });
    } catch (err) {
      console.error('Failed to refresh file tree:', err);
    }
  },

  subscribeToFsChanges: () => {
    // Coalesce many incoming events into a single re-fetch. The main process
    // already debounces, but a second guard on the renderer side is cheap and
    // protects us from rapid-fire bursts caused by editors that write files
    // in multiple steps (truncate → write → fsync).
    let pending: number | null = null;
    let stopped = false;

    const handler = (_event: FsChangeEvent) => {
      if (stopped) return;
      if (pending !== null) return;
      pending = window.setTimeout(() => {
        pending = null;
        // Use the latest workspace path at fire time.
        get().refreshFileTree();
        // Keep the Source Control panel / status bar branch in sync with
        // external edits (git status is cheap and already double-debounced).
        void get().refreshGitStatus();
      }, 60);
    };

    if (window.electronAPI?.onFsChanged) {
      window.electronAPI.onFsChanged(handler);
    }

    return () => {
      stopped = true;
      if (pending !== null) {
        window.clearTimeout(pending);
        pending = null;
      }
      if (window.electronAPI?.offFsChanged) {
        window.electronAPI.offFsChanged(handler);
      }
    };
  },

  toggleFolder: (folderId: string) => {
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return { expandedFolders: next };
    });
  },

  expandFolder: (folderId: string) => {
    set((state) => {
      if (state.expandedFolders.has(folderId)) return {};
      const next = new Set(state.expandedFolders);
      next.add(folderId);
      return { expandedFolders: next };
    });
  },

  openFile: async (node: TreeNode) => {
    if (node.type !== 'file') return;
    await get().openFilePath(node.path);
  },

  openFilePath: async (filePath: string, options?: OpenFilePathOptions) => {
    const { workspacePath, openTabs } = get();
    if (!filePath) {
      return { success: false, filePath, message: 'Missing file path.' };
    }

    const resolvedPath = workspacePath
      ? resolveWorkspacePath(workspacePath, filePath)
      : filePath;
    const existingTab = openTabs.find((t) => t.path === resolvedPath);
    const makeFrontmost = options?.makeFrontmost !== false;

    if (existingTab) {
      const reveal = findTextReveal(existingTab.content, options);
      set((state) => ({
        ...(makeFrontmost ? { activeTabId: existingTab.id } : {}),
        selectedPath: resolvedPath,
        selectedKind: 'file',
        pendingEditorReveal: reveal
          ? {
              id: Date.now(),
              filePath: resolvedPath,
              selection: reveal,
            }
          : state.pendingEditorReveal,
      }));
      return {
        success: true,
        filePath: resolvedPath,
        languageId: existingTab.language,
        lineCount: countLines(existingTab.content),
      };
    }

    try {
      // Image files (png/jpg/jpeg/gif/webp/bmp/ico/svg) are opened as
      // image-preview tabs rather than text editors. Reading the bytes as a
      // utf-8 string would produce garbage for binary formats and break
      // SVGs that contain non-utf-8 binary attachments. We ship a base64
      // data URL to the renderer instead so <img> can decode it natively.
      if (isImageFile(resolvedPath)) {
        const { dataUrl, size } = await window.electronAPI.readImageDataUrl(resolvedPath);
        const name = resolvedPath.split(/[\\/]/).pop() || resolvedPath;
        const newTab: Tab = {
          id: resolvedPath,
          name,
          path: resolvedPath,
          // Empty content — the image is rendered from `imageDataUrl`.
          content: '',
          savedContent: '',
          // Use 'image' as a sentinel value so the UI can opt-out of LSP /
          // Monaco wiring for these tabs.
          language: 'image',
          isUnsaved: false,
          imageDataUrl: dataUrl,
          fileSize: size,
        };

        set((state) => ({
          openTabs: [...state.openTabs, newTab],
          activeTabId: makeFrontmost ? newTab.id : state.activeTabId,
          selectedPath: resolvedPath,
          selectedKind: 'file',
        }));
        return {
          success: true,
          filePath: resolvedPath,
          languageId: 'image',
          lineCount: 1,
        };
      }

      const content = await window.electronAPI.readFile(resolvedPath);
      const language = getLanguageFromPath(resolvedPath);
      notifyActiveLanguage(language);
      const name = resolvedPath.split(/[\\/]/).pop() || resolvedPath;
      const reveal = findTextReveal(content, options);

      const newTab: Tab = {
        id: resolvedPath,
        name,
        path: resolvedPath,
        content,
        savedContent: content,
        language,
        isUnsaved: false,
      };

      set((state) => ({
        openTabs: [...state.openTabs, newTab],
        activeTabId: makeFrontmost ? newTab.id : state.activeTabId,
        selectedPath: resolvedPath,
        selectedKind: 'file',
        pendingEditorReveal: reveal
          ? {
              id: Date.now(),
              filePath: resolvedPath,
              selection: reveal,
            }
          : state.pendingEditorReveal,
      }));
      return {
        success: true,
        filePath: resolvedPath,
        languageId: language,
        lineCount: countLines(content),
      };
    } catch (err) {
      console.error('Failed to open file:', err);
      return {
        success: false,
        filePath: resolvedPath,
        message: (err as Error)?.message || 'Failed to open file.',
      };
    }
  },

  closeTab: (tabId: string) => {
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.id === tabId);
      const newTabs = state.openTabs.filter((t) => t.id !== tabId);
      let newActiveId = state.activeTabId;

      if (state.activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else if (idx >= newTabs.length) {
          newActiveId = newTabs[newTabs.length - 1].id;
        } else {
          newActiveId = newTabs[idx].id;
        }
      }

      return { openTabs: newTabs, activeTabId: newActiveId };
    });
  },

  closeOtherTabs: (tabId: string) => {
    set((state) => {
      const keep = state.openTabs.filter((t) => t.id === tabId || t.pinned);
      return {
        openTabs: keep,
        activeTabId: keep.some((t) => t.id === tabId) ? tabId : state.activeTabId,
      };
    });
  },

  closeAllTabs: () => {
    set((state) => {
      const keep = state.openTabs.filter((t) => t.pinned);
      const stillActive = keep.some((t) => t.id === state.activeTabId);
      return {
        openTabs: keep,
        activeTabId: stillActive
          ? state.activeTabId
          : keep.length > 0
            ? keep[0].id
            : null,
      };
    });
  },

  closeSavedTabs: () => {
    set((state) => {
      const keep = state.openTabs.filter((t) => t.isUnsaved || t.pinned);
      const stillActive = keep.some((t) => t.id === state.activeTabId);
      return {
        openTabs: keep,
        activeTabId: stillActive
          ? state.activeTabId
          : keep.length > 0
            ? keep[keep.length - 1].id
            : null,
      };
    });
  },

  togglePinTab: (tabId: string) => {
    set((state) => {
      const tabs = [...state.openTabs];
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return {};
      const tab = { ...tabs[idx], pinned: !tabs[idx].pinned };
      tabs.splice(idx, 1);
      const pinnedCount = tabs.filter((t) => t.pinned).length;
      // Pinning appends at the end of the pinned region; unpinning drops the
      // tab right after it (start of the unpinned region).
      tabs.splice(pinnedCount, 0, tab);
      return { openTabs: tabs };
    });
  },

  moveTab: (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    set((state) => {
      const tabs = [...state.openTabs];
      const from = tabs.findIndex((t) => t.id === sourceId);
      if (from === -1) return {};
      const [tab] = tabs.splice(from, 1);
      let to = tabs.findIndex((t) => t.id === targetId);
      if (to === -1) return {};
      // Dragging rightwards drops after the target; leftwards, before it.
      if (from <= to) to += 1;
      // Keep each tab inside its own region (pinned first, then unpinned).
      const pinnedCount = tabs.filter((t) => t.pinned).length;
      to = tab.pinned ? Math.min(to, pinnedCount) : Math.max(to, pinnedCount);
      tabs.splice(to, 0, tab);
      return { openTabs: tabs };
    });
  },

  cycleTab: (direction: 1 | -1) => {
    const { openTabs, activeTabId } = get();
    if (openTabs.length < 2) return;
    const idx = openTabs.findIndex((t) => t.id === activeTabId);
    const next = openTabs[(idx + direction + openTabs.length) % openTabs.length];
    get().setActiveTab(next.id);
  },

  setActiveTab: (tabId: string) => {
    // Switching tabs also moves the sidebar selection to the active file so
    // the folder-highlight chain follows the active editor.
    const tab = get().openTabs.find((t) => t.id === tabId);
    set({
      activeTabId: tabId,
      ...(tab ? { selectedPath: tab.path, selectedKind: 'file' as SelectedNodeKind } : {}),
    });
    notifyActiveLanguage(tab?.language);
  },

  updateTabContent: (tabId: string, content: string) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.id === tabId
          ? { ...t, content, isUnsaved: content !== t.savedContent }
          : t
      ),
    }));
    get().scheduleAutoSave(tabId);
  },

  clearPendingEditorReveal: (id: number) => {
    set((state) => (
      state.pendingEditorReveal?.id === id
        ? { pendingEditorReveal: null }
        : {}
    ));
  },

  saveFile: async (tabId?: string) => {
    const state = get();
    const id = tabId || state.activeTabId;
    if (!id) return;

    const tab = state.openTabs.find((t) => t.id === id);
    if (!tab || tab.gitDiff || tab.imageDataUrl) return;

    if (state.formatOnSave && state.formatActiveDocument && id === state.activeTabId) {
      try {
        await state.formatActiveDocument();
      } catch {
        /* best-effort */
      }
    }

    const latest = get().openTabs.find((t) => t.id === id);
    if (!latest) return;

    try {
      await window.electronAPI.writeFile(latest.path, latest.content);
      set((state) => ({
        openTabs: state.openTabs.map((t) =>
          t.id === id
            ? { ...t, savedContent: t.content, isUnsaved: false }
            : t
        ),
      }));
      // `onDidSaveTextDocument` must see the text that was written, so the
      // save carries it instead of racing the pending change event.
      documentSyncService.save(latest.path, latest.content);
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  },

  closeWorkspace: () => {
    // Best-effort: persist the outgoing project's history before clearing
    // it from memory. Fire-and-forget so closing remains synchronous.
    try {
      void get().saveProjectHistory();
    } catch {
      /* best-effort; ignore */
    }

    // Tear down the workspace: clear the path, file tree, expanded folders,
    // sidebar selection and all open editor tabs. Also stop any active file
    // system watcher in the main process if the API is available.
    try {
      const stopWatcher = (window as unknown as {
        electronAPI?: { stopWatcher?: () => Promise<void> | void };
      }).electronAPI?.stopWatcher;
      if (typeof stopWatcher === 'function') {
        Promise.resolve(stopWatcher()).catch(() => {
          /* best-effort; ignore */
        });
      }
    } catch {
      /* best-effort; ignore */
    }

    // Stop the language server tied to this workspace. Fire-and-forget;
    // the LSP client clears markers and document tracking eagerly.
    try {
      void lspClient.stopWorkspace().catch(() => undefined);
    } catch {
      /* best-effort; ignore */
    }

    set({
      workspacePath: null,
      workspaceName: null,
      fileTree: [],
      expandedFolders: new Set<string>(),
      selectedPath: null,
      selectedKind: null,
      openTabs: [],
      activeTabId: null,
      pendingEditorReveal: null,
      // Reset Source Control state.
      gitIsRepo: false,
      gitBranch: null,
      gitBranches: [],
      gitChanges: [],
      gitError: null,
      problems: [],
      // Reset AI conversation when a workspace closes.
      aiInitDone: false,
      aiMessages: [],
      aiStatus: 'idle',
      aiStatusText: '',
      aiPendingDiff: null,
      aiPendingDiffResolver: null,
    });
  },

  setCursorPosition: (pos: CursorPosition) => {
    set({ cursorPosition: pos });
  },

  setCommandPaletteOpen: (open: boolean) => {
    set({ commandPaletteOpen: open });
  },

  zoomIn: () => {
    set((state) => {
      const editorFontSize = clampEditorFontSize(state.editorFontSize + EDITOR_FONT_SIZE_STEP);
      persistEditorSettings({ ...snapshotEditorSettings(state), editorFontSize });
      return { editorFontSize };
    });
  },

  zoomOut: () => {
    set((state) => {
      const editorFontSize = clampEditorFontSize(state.editorFontSize - EDITOR_FONT_SIZE_STEP);
      persistEditorSettings({ ...snapshotEditorSettings(state), editorFontSize });
      return { editorFontSize };
    });
  },

  resetZoom: () => {
    set((state) => {
      persistEditorSettings({
        ...snapshotEditorSettings(state),
        editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
      });
      return { editorFontSize: DEFAULT_EDITOR_FONT_SIZE };
    });
  },

  setEditorFontSize: (size: number) => {
    set((state) => {
      const editorFontSize = clampEditorFontSize(size);
      persistEditorSettings({ ...snapshotEditorSettings(state), editorFontSize });
      return { editorFontSize };
    });
  },

  setAutoSave: (enabled: boolean) => {
    set((state) => {
      persistEditorSettings({ ...snapshotEditorSettings(state), autoSave: enabled });
      return { autoSave: enabled };
    });
  },

  setFormatOnSave: (enabled: boolean) => {
    set((state) => {
      persistEditorSettings({ ...snapshotEditorSettings(state), formatOnSave: enabled });
      return { formatOnSave: enabled };
    });
  },

  setWordWrap: (enabled: boolean) => {
    set((state) => {
      persistEditorSettings({ ...snapshotEditorSettings(state), wordWrap: enabled });
      return { wordWrap: enabled };
    });
  },

  setMinimapEnabled: (enabled: boolean) => {
    set((state) => {
      persistEditorSettings({ ...snapshotEditorSettings(state), minimapEnabled: enabled });
      return { minimapEnabled: enabled };
    });
  },

  setTabSize: (size: number) => {
    set((state) => {
      const tabSize = clampTabSize(size);
      persistEditorSettings({ ...snapshotEditorSettings(state), tabSize });
      return { tabSize };
    });
  },

  setSelectedPath: (selection: SelectedNode | null) => {
    if (selection === null) {
      set({ selectedPath: null, selectedKind: null });
    } else {
      set({ selectedPath: selection.path, selectedKind: selection.kind });
    }
  },

  // ── Live Server actions ─────────────────────────────────────────────
  startLiveServer: async (htmlPath: string) => {
    try {
      const status = await window.electronAPI.liveServer.start(htmlPath);
      set({
        liveServerActive: status.active,
        liveServerPort: status.port,
        liveServerRoot: status.root,
        liveServerHtmlFile: status.htmlFile,
        liveServerUrl: status.url,
      });
    } catch (err) {
      console.error('Failed to start live server:', err);
      // Surface to the user — the underlying port may be busy, etc.
      try {
        alert(`Live Server: ${(err as Error)?.message ?? 'error desconocido'}`);
      } catch {
        /* noop in non-DOM environments */
      }
    }
  },

  stopLiveServer: async () => {
    try {
      await window.electronAPI.liveServer.stop();
    } catch (err) {
      console.error('Failed to stop live server:', err);
    }
    set({
      liveServerActive: false,
      liveServerPort: null,
      liveServerRoot: null,
      liveServerHtmlFile: null,
      liveServerUrl: null,
    });
  },

  toggleLiveServer: async (htmlPath?: string) => {
    const { liveServerActive } = get();
    if (liveServerActive) {
      await get().stopLiveServer();
      return;
    }
    // Need a path to start. Fall back to the active tab if it's an HTML file.
    let target = htmlPath;
    if (!target) {
      const state = get();
      const activeTab = state.openTabs.find((t) => t.id === state.activeTabId);
      if (
        activeTab &&
        /\.html?$/i.test(activeTab.path)
      ) {
        target = activeTab.path;
      }
    }
    if (!target) {
      console.warn('[forge] toggleLiveServer called without an HTML file.');
      return;
    }
    await get().startLiveServer(target);
  },

  refreshLiveServerStatus: async () => {
    try {
      const status = await window.electronAPI.liveServer.status();
      set({
        liveServerActive: status.active,
        liveServerPort: status.port,
        liveServerRoot: status.root,
        liveServerHtmlFile: status.htmlFile,
        liveServerUrl: status.url,
      });
    } catch (err) {
      console.debug(
        '[forge] refreshLiveServerStatus failed:',
        (err as Error)?.message,
      );
    }
  },

  _setLiveServerStatus: (payload) => {
    set({
      liveServerActive: payload.active,
      liveServerPort: payload.port,
      liveServerRoot: payload.root,
      liveServerHtmlFile: payload.htmlFile,
      liveServerUrl: payload.url,
    });
  },

  /** Smart "+" target resolution.
   *
   *  - Nothing selected → workspace root.
   *  - Folder selected → that folder.
   *  - File selected → the file's parent folder.
   *
   *  Returns null when there is no workspace open. */
  resolveCreateParent: () => {
    const { workspacePath, selectedPath, selectedKind } = get();
    if (!workspacePath) return null;
    if (!selectedPath || !selectedKind) return workspacePath;
    if (selectedKind === 'directory') return selectedPath;
    // file selected → use its parent directory
    return dirname(selectedPath) || workspacePath;
  },

  createNewFile: async (parentPath: string, fileName: string) => {
    const fullPath = joinPath(parentPath, fileName);
    try {
      await window.electronAPI.createFile(fullPath);
      await get().refreshFileTree();
    } catch (err) {
      console.error('Failed to create file:', err);
    }
  },

  createNewDirectory: async (parentPath: string, dirName: string) => {
    const fullPath = joinPath(parentPath, dirName);
    try {
      await window.electronAPI.createDirectory(fullPath);
      await get().refreshFileTree();
    } catch (err) {
      console.error('Failed to create directory:', err);
    }
  },

  deleteItem: async (itemPath: string) => {
    try {
      await window.electronAPI.deleteItem(itemPath);
      set((state) => {
        const newTabs = state.openTabs.filter((t) => !t.path.startsWith(itemPath));
        let newActiveId = state.activeTabId;
        if (state.activeTabId && !newTabs.find((t) => t.id === state.activeTabId)) {
          newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
        }
        const clearedSelection =
          state.selectedPath &&
          (state.selectedPath === itemPath ||
            state.selectedPath.startsWith(itemPath + '/') ||
            state.selectedPath.startsWith(itemPath + '\\'));
        return {
          openTabs: newTabs,
          activeTabId: newActiveId,
          ...(clearedSelection
            ? { selectedPath: null, selectedKind: null }
            : {}),
        };
      });
      await get().refreshFileTree();
    } catch (err) {
      console.error('Failed to delete item:', err);
    }
  },

  renameItem: async (oldPath: string, newName: string) => {
    const newPath = joinPath(dirname(oldPath), newName);
    try {
      await window.electronAPI.renameItem(oldPath, newPath);
      set((state) => {
        let newSelectedPath = state.selectedPath;
        if (state.selectedPath === oldPath) {
          newSelectedPath = newPath;
        } else if (
          state.selectedPath &&
          (state.selectedPath.startsWith(oldPath + '/') ||
            state.selectedPath.startsWith(oldPath + '\\'))
        ) {
          newSelectedPath = newPath + state.selectedPath.substring(oldPath.length);
        }
        return {
          openTabs: state.openTabs.map((t) => {
            if (t.path === oldPath) {
              return { ...t, id: newPath, path: newPath, name: newName };
            }
            if (t.path.startsWith(oldPath + '/') || t.path.startsWith(oldPath + '\\')) {
              const rest = t.path.substring(oldPath.length);
              const np = newPath + rest;
              return { ...t, id: np, path: np };
            }
            return t;
          }),
          activeTabId: state.activeTabId === oldPath ? newPath : state.activeTabId,
          selectedPath: newSelectedPath,
        };
      });
      await get().refreshFileTree();
    } catch (err) {
      console.error('Failed to rename:', err);
    }
  },
}));
