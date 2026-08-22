// ── Tree Node (file explorer) ──────────────────────────────────────────
export interface TreeNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

// ── Editor Tab ─────────────────────────────────────────────────────────
export interface Tab {
  id: string;
  name: string;
  path: string;
  content: string;
  savedContent: string;
  language: string;
  isUnsaved: boolean;
  /** Pinned tabs stay at the front of the tab bar and survive
   *  "Close All" / "Close Others" / "Close Saved". */
  pinned?: boolean;
  /** When set, the tab is an image preview (rendered in ImageViewer) rather
   *  than a Monaco text editor. Contains a data: URL for the image bytes. */
  imageDataUrl?: string;
  /** File size in bytes — displayed in the image-viewer info bar. */
  fileSize?: number;
  /** When set, the tab renders a read-only Git diff instead of the editor. */
  gitDiff?: {
    relPath: string;
    staged: boolean;
    original: string;
    modified: string;
    /** inline = unified diff editor; side-by-side = split view. */
    mode: 'inline' | 'side-by-side';
    /** Historical diff from Timeline (commit vs parent). */
    commitHash?: string;
    commitLabel?: string;
  };
  /** When set, the tab renders a marketplace extension-detail page (icon,
   *  stats, README, contributions) instead of a Monaco text editor. */
  extension?: MarketplaceExtension;
}

// ── Image file detection ───────────────────────────────────────────────
export const imageExtensions = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
] as const;

export function isImageFile(filePath: string): boolean {
  const name = filePath.split('/').pop() || filePath.split('\\').pop() || '';
  if (!name.includes('.')) return false;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return (imageExtensions as readonly string[]).includes(ext);
}

/** Returns true for .html / .htm files (case-insensitive). */
export function isHtmlFile(filePath: string): boolean {
  const name = filePath.split('/').pop() || filePath.split('\\').pop() || '';
  if (!name.includes('.')) return false;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return ext === 'html' || ext === 'htm';
}

// ── Sidebar Panel Types ────────────────────────────────────────────────
export type SidebarPanel = 'explorer' | 'search' | 'git' | 'debug' | 'extensions' | 'settings' | 'agents';

// ── Bottom Panel Tab Types ─────────────────────────────────────────────
export type BottomTab = 'terminal' | 'problems' | 'output' | 'debug';

/** Dedicated agent CLI terminals (Codex, Claude Code, Cursor Agent, Antigravity). */
export type AgentTerminalId = 'codex' | 'claude' | 'cursor-agent' | 'agy';

export interface TerminalSession {
  /** Client-side session id (stable across pty restarts). */
  id: string;
  label: string;
  ptyId: string | null;
  agentId: AgentTerminalId | null;
  /** Queued until the pty for this session mounts. */
  pendingCommand: string | null;
}

// ── Cursor Position ────────────────────────────────────────────────────
export interface CursorPosition {
  line: number;
  column: number;
}

// ── Command ────────────────────────────────────────────────────────────
export interface Command {
  id: string;
  label: string;
  /** Category shown as group header (File, View, Git, …). */
  category?: string;
  /** Extra terms for fuzzy search. */
  keywords?: string[];
  shortcut?: string;
  action: () => void;
}

// ── File Extension → Language Mapping ──────────────────────────────────
export const extensionToLanguage: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  vue: 'html',
  toml: 'toml',
  ini: 'ini',
  env: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
  gitignore: 'plaintext',
};

export function getLanguageFromPath(filePath: string): string {
  const name = filePath.split('/').pop() || filePath.split('\\').pop() || '';
  // Handle dotfiles like .gitignore, Dockerfile, etc.
  const lowerName = name.toLowerCase();
  if (lowerName === 'dockerfile') return 'dockerfile';
  if (lowerName === 'makefile') return 'plaintext';

  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : '';
  return extensionToLanguage[ext] || 'plaintext';
}

// ── Terminal Disposable ────────────────────────────────────────────────
export interface TerminalDisposable {
  dispose: () => void;
}

// ── File system change event (workspace watcher) ───────────────────────
export interface FsChangeEvent {
  /** chokidar event name: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change' */
  reason: 'add' | 'unlink' | 'addDir' | 'unlinkDir' | 'change' | string;
  /** Absolute path that triggered the event. */
  path: string;
}

// ── AI / Agent ─────────────────────────────────────────────────────────
export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'kimi';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  hint?: string;
  staticModels?: string[];
}

export interface ChatRole {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A single AI conversation entry as displayed in the right-panel UI.
 *
 * - 'user': prompt typed by the user.
 * - 'assistant': agent's plain-text reply (may stream).
 * - 'tool': UI marker for an in-progress or completed tool execution.
 * - 'system': internal notes (not normally displayed).
 */
export type AIRole = 'user' | 'assistant' | 'tool' | 'system';

export interface AIToolCall {
  /** Name of the tool the agent invoked. */
  name: 'leer_archivo' | 'escribir_archivo' | 'listar_carpeta' | 'buscar_en_proyecto' | string;
  /** Arguments passed to the tool. */
  args: Record<string, any>;
  /** Pretty status text shown in the UI ("Editando archivo...", "Leyendo …"). */
  statusLabel: string;
  /** Has the tool finished? */
  done: boolean;
  /** Affected file paths, populated once the tool resolves. */
  paths?: string[];
  /** Did the tool error out? */
  error?: string;
  /** Was the action rejected by the user via the diff modal? */
  rejected?: boolean;
}

/**
 * Real-time "writing into editor" indicator displayed inside an assistant
 * message bubble while the agent streams code into a file. The actual code
 * content lives in the editor tab — only the status icon + path is shown in
 * the chat panel.
 */
export interface LiveWrite {
  /** Workspace-relative file path the agent is writing. */
  ruta: string;
  /** True once the write tool block has fully closed. */
  done: boolean;
}

export interface AIMessage {
  /** Local id (uuid-ish). */
  id: string;
  role: AIRole;
  content: string;
  /** Tool calls attached to this assistant message (in execution order). */
  toolCalls?: AIToolCall[];
  /** While true, the message is still being streamed. */
  streaming?: boolean;
  /** Error text, if the streaming step failed. */
  error?: string;
  /** Live "Escribiendo en archivo.ts…" indicators rendered in the chat panel
   *  while the agent streams `escribir_archivo` content directly into the
   *  editor. Mirrors `toolCalls` for writes but updates in real-time. */
  liveWrites?: LiveWrite[];
}

export interface PendingDiff {
  /** Original file content (read from disk before applying). */
  before: string;
  /** Proposed new content (from the agent's escribir_archivo call). */
  after: string;
  /** Absolute path the agent wants to modify. */
  filePath: string;
  /** Display path (relative when possible). */
  relPath: string;
}

export interface GitFileVersions {
  original: string;
  modified: string;
}

export interface ReplaceLinePreview {
  line: number;
  before: string;
  after: string;
}

export interface ReplaceFilePreview {
  path: string;
  count: number;
  previews: ReplaceLinePreview[];
}

export interface ReplacePreviewResult {
  search: string;
  replace: string;
  changes: ReplaceFilePreview[];
  filesChanged: number;
  totalReplacements: number;
  applied: boolean;
}

// ── Git (Source Control) ────────────────────────────────────────────────

export interface GitChange {
  /** Path relative to the repo root, forward slashes. */
  relPath: string;
  /** Staged (index) status letter: M/A/D/R/C/U/? or space. */
  x: string;
  /** Working-tree status letter. */
  y: string;
}

export interface GitStatusPayload {
  isRepo: boolean;
  branch: string | null;
  changes: GitChange[];
  /** Commits ahead of the upstream (pending push). 0 when no upstream. */
  ahead: number;
  /** Commits behind the upstream (pending pull). 0 when no upstream. */
  behind: number;
  /** The current branch tracks a remote branch. */
  hasUpstream: boolean;
  /** The repo has at least one remote configured. */
  hasRemote: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitBranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
}

// ── Extensions (VSIX / Open VSX) ───────────────────────────────────────

export interface ExtensionTheme {
  /** Monaco-safe theme id (unique across extensions). */
  id: string;
  /** Human label shown in pickers. */
  label: string;
  /** VSCode uiTheme hint: "vs" | "vs-dark" | "hc-black" | "hc-light". */
  uiTheme: string;
  /** Raw VSCode color-theme JSON (includes already merged). */
  data: {
    type?: string;
    colors?: Record<string, string>;
    tokenColors?: {
      scope?: string | string[];
      settings?: { foreground?: string; background?: string; fontStyle?: string };
    }[];
  };
}

export interface ExtensionSnippets {
  language: string;
  snippets: Record<
    string,
    { prefix?: string | string[]; body?: string | string[]; description?: string }
  >;
}

export interface ExtensionLanguageConfiguration {
  comments?: {
    lineComment?: string;
    blockComment?: [string, string];
  };
  brackets?: [string, string][];
  autoClosingPairs?: ({ open: string; close: string; notIn?: string[] } | [string, string])[];
  surroundingPairs?: ({ open: string; close: string } | [string, string])[];
  folding?: {
    markers?: { start?: string; end?: string };
  };
  wordPattern?: string;
  indentationRules?: {
    increaseIndentPattern?: string;
    decreaseIndentPattern?: string;
  };
}

export interface ExtensionLanguageContribution {
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  firstLine: string | null;
  configuration: ExtensionLanguageConfiguration | null;
}

export interface ExtensionIconTheme {
  id: string;
  label: string;
  definitions: Record<string, string>;
  file: string | null;
  folder: string | null;
  folderExpanded: string | null;
  rootFolder: string | null;
  rootFolderExpanded: string | null;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
}

/** Mirror of the main-process compatibility report (extension-dto.ts). */
export type ExtensionCompatibilityLevel = 'full' | 'partial' | 'none';

export type ExtensionCompatibilityBlocker =
  | { kind: 'requires-extension-host'; entryPoints: string[] }
  | { kind: 'unsupported-contribution'; contribution: string }
  | { kind: 'contribution-load-failed'; contribution: string; declared: number; loaded: number }
  | { kind: 'integration-pending'; contribution: string };

export interface ExtensionCompatibilityReport {
  level: ExtensionCompatibilityLevel;
  supportedContributions: string[];
  pendingContributions: string[];
  blockers: ExtensionCompatibilityBlocker[];
}

/** Mirror of `capabilities.*` normalized in the main process. */
export type ExtensionCapabilitySupport = 'supported' | 'limited' | 'unsupported';

export interface ExtensionCapabilities {
  untrustedWorkspaces: {
    supported: ExtensionCapabilitySupport;
    description: string | null;
    restrictedConfigurations: string[];
  };
  virtualWorkspaces: {
    supported: ExtensionCapabilitySupport;
    description: string | null;
  };
}

/** What Restricted Mode allows for one extension right now. */
export type ExtensionTrustActivation = 'allowed' | 'limited' | 'blocked';

/** Trust of the open workspace (Workspace Trust, Milestone 3.0). */
export interface WorkspaceTrustStatus {
  workspace: string | null;
  state: 'trusted' | 'restricted';
  /** False while the user has never decided for this workspace. */
  decided: boolean;
  /** Remote workspaces stay restricted and cannot be granted trust yet. */
  remote: boolean;
  canGrant: boolean;
}

/** Lifecycle of the extension host process (Milestone 3.1). */
export type ExtensionHostStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'restarting'
  /** Crash-loop breaker tripped: nothing restarts without explicit intent. */
  | 'disabled';

/** Observable snapshot of the host, mirrored from the main-process port. */
export interface ExtensionHostState {
  status: ExtensionHostStatus;
  /** Increments on every spawn; identifies the generation. */
  generation: number;
  restartsInWindow: number;
  lastError: { code: string; message: string } | null;
}

/** Host traffic the renderer is allowed to observe. Requests never travel
 *  this way: main is the only broker (design §1.2). */
export type ExtensionHostEvent =
  | { type: 'state'; state: ExtensionHostState }
  | {
      type: 'logs';
      generation: number;
      entries: { extensionId: string | null; level: string; message: string }[];
    }
  | { type: 'notification'; generation: number; envelope: unknown }
  | {
      type: 'request-timeout';
      generation: number;
      method: string;
      extensionId: string | null;
    }
  | { type: 'dropped'; generation: number; reason: string; method: string };

/** One command the running host generation can execute, and its owner. */
export interface ExtensionCommandRegistration {
  command: string;
  extensionId: string;
}

/** Outcome of running an extension command. Failures travel as data with
 *  their RPC code, so the UI can tell "nobody registers it" from "the
 *  extension threw" without reading messages. */
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

/** A message an extension asked Forge to show. `items` are buttons. */
export interface ExtensionHostMessage {
  id: number;
  severity: 'info' | 'warn' | 'error';
  message: string;
  items: string[];
  extensionId: string | null;
}

/** Activation timings and failures of the live host generation. */
export interface ExtensionActivationReport {
  metrics: { id: string; reason: string; durationMs: number; at: number }[];
  failures: { id: string; reason: string; code: string; message: string; at: number }[];
}

export interface InstalledExtension {
  id: string;
  displayName: string;
  publisher: string;
  version: string;
  description: string;
  categories: string[];
  activationEvents: string[];
  extensionKind: string[];
  main: string | null;
  browser: string | null;
  contributes: string[];
  /** Legacy contract kept while the UI finishes migrating to `compatibility`. */
  supported: {
    declarative: string[];
    requiresExtensionHost: boolean;
  };
  compatibility: ExtensionCompatibilityReport;
  /** Disabled extensions stay installed but contribute nothing. */
  enabled: boolean;
  /** Retained version an explicit rollback would return to, if any. */
  previousVersion: string | null;
  themes: ExtensionTheme[];
  snippets: ExtensionSnippets[];
  languages: ExtensionLanguageContribution[];
  iconThemes: ExtensionIconTheme[];
  /** Settings this extension declares (`contributes.configuration`). */
  configuration: ExtensionSetting[];
  /** Commands this extension declares (`contributes.commands`). */
  commands: ExtensionCommandContribution[];
  /** Keybindings this extension declares (`contributes.keybindings`). */
  keybindings: ExtensionKeybinding[];
  /** TextMate grammars this extension declares (`contributes.grammars`). */
  grammars: ExtensionGrammar[];
  /** Menu items this extension declares (`contributes.menus`). */
  menus: ExtensionMenuItem[];
  /** Declared `capabilities`, read by the Workspace Trust policy. */
  capabilities: ExtensionCapabilities;
  /** What Restricted Mode allows for this extension right now. */
  trust: {
    activation: ExtensionTrustActivation;
    /** Settings the extension ignores while the workspace is untrusted. */
    restrictedConfigurations: string[];
  };
}

/** One menu item contributed via `contributes.menus`, flattened. */
export interface ExtensionMenuItem {
  menu: string;
  command: string;
  when: string | null;
  group: string | null;
}

/** One TextMate grammar shipped with its raw source (JSON or plist). */
export interface ExtensionGrammar {
  language: string | null;
  scopeName: string;
  path: string;
  content: string;
  embeddedLanguages: Record<string, string>;
  injectTo: string[];
}

/** One command contributed via `contributes.commands`. */
export interface ExtensionCommandContribution {
  command: string;
  title: string;
  category: string | null;
  /** `when`-clause gating where the command surfaces; null = always. */
  enablement: string | null;
}

/** One keybinding contributed via `contributes.keybindings`. */
export interface ExtensionKeybinding {
  command: string;
  key: string;
  mac: string | null;
  linux: string | null;
  win: string | null;
  when: string | null;
}

/** One setting declared under `contributes.configuration`. */
export interface ExtensionSetting {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | null;
  default: unknown;
  description: string;
  enum: unknown[] | null;
}

/** A declared setting resolved through every configuration scope. */
export interface ExtensionConfigurationValue {
  key: string;
  ownerId: string;
  type: ExtensionSetting['type'];
  description: string;
  enum: unknown[] | null;
  defaultValue: unknown;
  overrideValue: unknown;
  userValue: unknown;
  /** Value from `.forge/settings.json`; undefined without a workspace. */
  workspaceValue: unknown;
  effectiveValue: unknown;
  effectiveSource: 'default' | 'extension-override' | 'user' | 'workspace';
}

/** An installed extension with a newer version published in the catalog. */
export interface ExtensionUpdateInfo {
  id: string;
  installedVersion: string;
  latestVersion: string;
}

export interface MarketplaceExtension {
  id: string;
  name: string;
  namespace: string;
  displayName: string;
  description: string;
  version: string;
  iconUrl: string | null;
  downloadCount: number;
  averageRating: number | null;
  reviewCount: number;
  verified: boolean;
  deprecated: boolean;
  lastUpdated: string | null;
}

export interface MarketplaceSearchResult {
  total: number;
  extensions: MarketplaceExtension[];
}

/** Full Open VSX metadata + README shown in the extension-detail tab. */
export interface MarketplaceExtensionDetail extends MarketplaceExtension {
  readme: string | null;
  categories: string[];
  tags: string[];
  license: string | null;
  homepage: string | null;
  repository: string | null;
  bugs: string | null;
  engines: Record<string, string>;
  preRelease: boolean;
  publishedBy: string | null;
}

// ── Claude Code IDE bridge ─────────────────────────────────────────────

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

export interface ClaudeIdeOpenEditor {
  uri: string;
  filePath: string;
  isActive: boolean;
  label: string;
  languageId: string;
  isDirty: boolean;
  lineCount: number;
}

export interface ClaudeIdeEditorState {
  workspacePath: string | null;
  workspaceName: string | null;
  openEditors: ClaudeIdeOpenEditor[];
}

// ── Electron API type declaration ──────────────────────────────────────
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
  readDirectory: (dirPath: string) => Promise<TreeNode[]>;
  readFile: (filePath: string) => Promise<string>;
  /** Reads the file as binary and returns a `data:<mime>;base64,...` URL
   *  suitable for embedding in <img src=...>. Used by the image viewer. */
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
  onWorkspaceRestore: (callback: (workspacePath: string) => void) => TerminalDisposable;
  // Window controls
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
  /** Send a command string to the active pty (newline-terminated by caller). */
  terminalSendCommand: (id: string, command: string) => void;
  terminalOnData: (id: string, callback: (data: string) => void) => TerminalDisposable;
  terminalOnExit: (id: string, callback: (code: number) => void) => TerminalDisposable;
  // Clipboard
  readClipboard: () => Promise<string>;
  /** Reveal a file/folder in the OS file manager. */
  revealInFolder: (targetPath: string) => Promise<boolean>;
  /** Open an https:// URL in the default browser. */
  openExternal: (url: string) => Promise<boolean>;
  /** GitHub OAuth device flow — sign in so HTTPS push/pull work like VS Code. */
  github: {
    getAuth: () => Promise<{ authenticated: boolean; login: string | null; clientId: string | null }>;
    setClientId: (clientId: string) => Promise<boolean>;
    startDeviceFlow: () => Promise<{ userCode: string; verificationUri: string; expiresIn: number }>;
    /** Resolves when the user authorizes on github.com (token saved in main). */
    waitForToken: () => Promise<{ login: string }>;
    cancelDeviceFlow: () => Promise<boolean>;
    logout: () => Promise<boolean>;
  };
  // ── Live Server (built-in HTTP server, port 5500) ───────────────────
  liveServer: {
    /** Starts a static HTTP server rooted at the directory of the given
     *  HTML file. If a server is already running it is stopped first. */
    start: (htmlPath: string) => Promise<{
      active: boolean;
      port: number | null;
      root: string | null;
      htmlFile: string | null;
      url: string | null;
    }>;
    /** Stops the live server (no-op if not running). */
    stop: () => Promise<boolean>;
    /** Returns the current live-server status. */
    status: () => Promise<{
      active: boolean;
      port: number | null;
      root: string | null;
      htmlFile: string | null;
      url: string | null;
    }>;
    /** Subscribe to live-server status-change events emitted by main. */
    onStatusChange: (
      callback: (payload: {
        active: boolean;
        port: number | null;
        root: string | null;
        htmlFile: string | null;
        url: string | null;
      }) => void,
    ) => TerminalDisposable;
  };
  // ── LSP (typescript-language-server) ────────────────────────────────
  // The renderer doesn't speak directly to the language server; the main
  // process owns the child process and bridges JSON-RPC over IPC.
  lsp: {
    /** Spawn the language server for the given workspace, send `initialize`
     *  and `initialized`. Calling this for a different path tears down the
     *  previous server first. */
    start: (workspacePath: string) => Promise<boolean>;
    /** Gracefully shut down the language server. */
    stop: () => Promise<boolean>;
    /** Send a JSON-RPC request and resolve with the server's response. */
    request: (method: string, params: any) => Promise<any>;
    /** Send a JSON-RPC notification (fire-and-forget). */
    notification: (method: string, params: any) => void;
    /** Subscribe to `textDocument/publishDiagnostics` notifications. */
    onDiagnostics: (callback: (params: LspPublishDiagnosticsParams) => void) => TerminalDisposable;
    /** Subscribe to all other LSP notifications (raw method + params). */
    onNotification: (callback: (method: string, params: any) => void) => TerminalDisposable;
  };
  // ── AI / Agent ──────────────────────────────────────────────────────
  ai: {
    listProviders: () => Promise<ProviderInfo[]>;
    getConfig: () => Promise<{
      configuredProviders: ProviderId[];
      activeProvider: ProviderId | null;
      activeModel: string | null;
    }>;
    setApiKey: (provider: ProviderId, apiKey: string) => Promise<boolean>;
    removeApiKey: (provider: ProviderId) => Promise<boolean>;
    setActive: (provider: ProviderId, model: string) => Promise<boolean>;
    listModels: (provider: ProviderId) => Promise<string[]>;
    chatStream: (args: {
      streamId: string;
      provider: ProviderId;
      model: string;
      messages: ChatRole[];
    }) => Promise<boolean>;
    abortStream: (streamId: string) => Promise<boolean>;
    onStream: (
      streamId: string,
      callback: (event: 'delta' | 'done' | 'error', data: any) => void,
    ) => TerminalDisposable;
  };
  // ── Git (Source Control) ────────────────────────────────────────────
  git: {
    status: (workspacePath: string) => Promise<GitStatusPayload>;
    stage: (workspacePath: string, relPaths: string[]) => Promise<boolean>;
    unstage: (workspacePath: string, relPaths: string[]) => Promise<boolean>;
    /** Commits staged changes. Resolves with git's stdout summary. */
    commit: (workspacePath: string, message: string) => Promise<string>;
    /** Push; publishes the branch (`-u`) when it has no upstream yet. */
    push: (workspacePath: string) => Promise<string>;
    /** Pull --ff-only from the upstream. */
    pull: (workspacePath: string) => Promise<string>;
    branches: (workspacePath: string) => Promise<GitBranchEntry[]>;
    checkoutBranch: (workspacePath: string, branchName: string) => Promise<string>;
    createBranch: (workspacePath: string, branchName: string) => Promise<string>;
    /** Diff of pending changes (staged first, else working tree) as LLM input. */
    diffSummary: (workspacePath: string) => Promise<{ staged: boolean; text: string }>;
    /** Discard local changes (restore from HEAD / remove untracked). */
    discard: (workspacePath: string, relPaths: string[]) => Promise<boolean>;
    diff: (workspacePath: string, relPath: string, staged?: boolean) => Promise<string>;
    fileVersions: (
      workspacePath: string,
      relPath: string,
      staged?: boolean,
    ) => Promise<GitFileVersions>;
    commitFileVersions: (
      workspacePath: string,
      relPath: string,
      commitHash: string,
    ) => Promise<GitFileVersions>;
    log: (workspacePath: string, relPath?: string, limit?: number) => Promise<GitLogEntry[]>;
  };
  // ── Extensions (VSIX / Open VSX) ────────────────────────────────────
  ext: {
    /** Opens a file picker and installs the chosen .vsix. Returns the
     *  installed extension payload, or null if the dialog was cancelled. */
    installVsix: () => Promise<InstalledExtension | null>;
    /** Downloads and installs `publisher.name` from open-vsx.org. */
    installFromOpenVsx: (extensionId: string) => Promise<InstalledExtension>;
    searchOpenVsx: (query: string, size?: number) => Promise<MarketplaceSearchResult>;
    /** Full metadata + README for the extension-detail tab. */
    detail: (extensionId: string) => Promise<MarketplaceExtensionDetail>;
    list: () => Promise<{
      protocolVersion: 1;
      extensions: InstalledExtension[];
      activeTheme: string | null;
      activeIconTheme: string | null;
      workspaceTrust: WorkspaceTrustStatus;
    }>;
    uninstall: (id: string) => Promise<boolean>;
    setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
    /** Installed extensions with a newer version published in the catalog. */
    checkUpdates: () => Promise<ExtensionUpdateInfo[]>;
    rollback: (id: string) => Promise<InstalledExtension>;
    /** Every setting contributed by installed extensions, fully resolved. */
    listConfiguration: () => Promise<ExtensionConfigurationValue[]>;
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
    /** Records that the user trusts the open workspace. */
    grantWorkspaceTrust: () => Promise<WorkspaceTrustStatus>;
    /** Returns the open workspace to Restricted Mode. */
    revokeWorkspaceTrust: () => Promise<WorkspaceTrustStatus>;
    /** Fires after every trust decision and on workspace switch. */
    onTrustChanged: (
      callback: (status: WorkspaceTrustStatus) => void,
    ) => { dispose: () => void };
    /** Extension host state; the renderer observes, never commands it. */
    hostState: () => Promise<ExtensionHostState>;
    restartHost: () => Promise<ExtensionHostState>;
    onHostEvent: (
      callback: (event: ExtensionHostEvent) => void,
    ) => { dispose: () => void };
    /** Commands the live generation has registered. */
    hostCommands: () => Promise<ExtensionCommandRegistration[]>;
    /** Pushed when that set changes (activation, deactivation, restart). */
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
  // ── Claude Code IDE bridge ─────────────────────────────────────────
  claudeIde: {
    updateEditorState: (state: ClaudeIdeEditorState) => void;
    updateSelection: (selection: ClaudeIdeSelection | null) => void;
    status: () => Promise<Record<string, string>>;
    onCommand: (
      callback: (command: string, args: any) => Promise<any> | any,
    ) => TerminalDisposable;
  };
  // ── Forge per-project metadata (.forge/) ────────────────────────────
  forge: {
    /** Returns the parsed history.json messages or `null` if it doesn't
     *  exist (i.e. /init has not been run in this workspace). */
    readHistory: (workspacePath: string) => Promise<AIMessage[] | null>;
    /** Atomically writes `.forge/history.json`. */
    writeHistory: (workspacePath: string, messages: AIMessage[]) => Promise<boolean>;
    /** Creates `.forge/` and an empty `history.json` if absent. */
    ensureForgeDir: (workspacePath: string) => Promise<boolean>;
    /** Whether `.forge/history.json` already exists. */
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
    ) => Promise<ReplacePreviewResult>;
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

// ── LSP-flavoured shapes used in the renderer ─────────────────────────
// We intentionally keep these loose — the real LSP spec is huge and we
// only consume a subset (completion, hover, diagnostics).

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
  tags?: number[];
}
export interface LspPublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

export interface Problem {
  filePath: string;
  message: string;
  severity: 1 | 2 | 3 | 4;
  source: string;
  code?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
