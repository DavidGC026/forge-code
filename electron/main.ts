import { app, BrowserWindow, ipcMain, dialog, nativeImage, clipboard, screen, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
// chokidar is CommonJS (v3.x) so plain require/import works in our CJS build.
import chokidar, { FSWatcher } from 'chokidar';
import { LspManager } from './lsp-manager';
import {
  PROVIDERS,
  ProviderId,
  ChatMessage,
  listModels as aiListModels,
  streamChat as aiStreamChat,
  StreamHandle,
} from './ai-providers';
import {
  leerArchivo,
  escribirArchivo,
  listarCarpeta,
  buscarEnProyecto,
  reemplazarEnProyecto,
  collectInitContext,
  snapshotFolder,
  fileExists as agentFileExists,
  readFileSafe as agentReadFileSafe,
} from './agent-tools';
import {
  installVsix,
  installFromOpenVsx,
  searchOpenVsx,
  getOpenVsxDetail,
  listExtensions,
  listConfiguration,
  setConfigurationValue,
  configureExtensionWorkspace,
  onExtensionConfigurationChanged,
  checkExtensionUpdates,
  rollbackExtension,
  sweepExtensionStore,
  uninstallExtension,
  setExtensionEnabled,
  setActiveTheme,
  setActiveIconTheme,
  getWorkspaceTrustStatus,
  setWorkspaceTrusted,
  onWorkspaceTrustChanged,
  startExtensionHost,
  stopExtensionHost,
  restartExtensionHost,
  syncExtensionHost,
  getExtensionHostState,
  onExtensionHostEvent,
  getExtensionCommandRegistry,
  executeExtensionCommand,
  getExtensionActivationReport,
  fireExtensionActivation,
  fireWorkspaceContainsActivation,
  resolveExtensionMessage,
  getSafeModeStatus,
  setSafeMode,
  onSafeModeChanged,
  SafeModeError,
} from './extensions';
import { RpcError } from './extensions/domain/rpc-protocol';
import {
  gitStatus,
  gitStage,
  gitUnstage,
  gitCommit,
  gitDiff,
  gitGetFileVersions,
  gitGetCommitFileVersions,
  gitLog,
  gitPush,
  gitPull,
  gitDiffSummary,
  gitDiscard,
  gitListBranches,
  gitCheckoutBranch,
  gitCreateBranch,
} from './git';
import {
  startDeviceFlow,
  waitForDeviceToken,
  cancelDeviceFlow,
  fetchGithubLogin,
  DeviceCodeInfo,
} from './github-auth';
import {
  ClaudeIdeEditorState,
  ClaudeIdeSelection,
  ClaudeIdeServer,
} from './claude-ide';

let mainWindow: BrowserWindow | null = null;
let currentWorkspacePath: string | null = null;
const lspManager = new LspManager();
/** Active AI streaming handles, keyed by stream id. */
const aiStreams = new Map<string, StreamHandle>();

let nextClaudeRendererRequestId = 1;
const pendingClaudeRendererRequests = new Map<
  number,
  { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();

function requestClaudeRenderer(command: string, args: any): Promise<any> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({ success: false, message: 'No renderer window available.' });
  }

  const id = nextClaudeRendererRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingClaudeRendererRequests.delete(id);
      reject(new Error(`Claude IDE renderer command timed out: ${command}`));
    }, 5000);
    pendingClaudeRendererRequests.set(id, { resolve, reject, timer });
    mainWindow?.webContents.send('claude:renderer-request', { id, command, args });
  });
}

const claudeIdeServer = new ClaudeIdeServer(requestClaudeRenderer);

// ── Simple JSON-file config (replacement for electron-store) ───────────
// electron-store v11 is ESM-only and cannot be require()'d from our CJS
// main process build, so we use a tiny fs-based helper instead. The file
// lives in app.getPath('userData') and stores arbitrary key/value pairs.
function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'forge-config.json');
}

function loadConfig(): Record<string, any> {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, any>): void {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[forge] failed to write config:', (err as Error).message);
  }
}

function getLastWorkspaceFromStore(): string | undefined {
  const cfg = loadConfig();
  const v = cfg.lastWorkspace;
  return typeof v === 'string' ? v : undefined;
}

function setLastWorkspaceInStore(workspacePath: string): void {
  const cfg = loadConfig();
  cfg.lastWorkspace = workspacePath;
  saveConfig(cfg);
}

// ── File system watcher (workspace) ────────────────────────────────────
// We keep at most one watcher alive. When a new workspace is opened (or the
// renderer asks us to switch), the previous watcher is torn down first.
let workspaceWatcher: FSWatcher | null = null;
let workspaceWatcherPath: string | null = null;
let fsChangedDebounceTimer: NodeJS.Timeout | null = null;

function notifyFsChanged(reason: string, changedPath: string) {
  // Debounce: chokidar can fire many events back-to-back (e.g. when a folder
  // tree is dropped). One refresh per burst is enough.
  if (fsChangedDebounceTimer) clearTimeout(fsChangedDebounceTimer);
  fsChangedDebounceTimer = setTimeout(() => {
    fsChangedDebounceTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fs:changed', { reason, path: changedPath });
    }
  }, 120);
}

function closeWorkspaceWatcher() {
  if (fsChangedDebounceTimer) {
    clearTimeout(fsChangedDebounceTimer);
    fsChangedDebounceTimer = null;
  }
  if (workspaceWatcher) {
    try {
      workspaceWatcher.close();
    } catch {
      /* noop */
    }
    workspaceWatcher = null;
    workspaceWatcherPath = null;
  }
}

function startWorkspaceWatcher(rootPath: string) {
  // Same path already being watched? Nothing to do.
  if (workspaceWatcherPath === rootPath && workspaceWatcher) return;

  closeWorkspaceWatcher();

  if (!rootPath) return;
  try {
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  // Ignore noisy / heavy directories. Patterns are matched against full paths
  // and basenames using anymatch under the hood.
  const ignored = [
    /(^|[/\\])\.git([/\\]|$)/,
    /(^|[/\\])node_modules([/\\]|$)/,
    /(^|[/\\])dist([/\\]|$)/,
    /(^|[/\\])dist-electron([/\\]|$)/,
    /(^|[/\\])\.DS_Store$/,
  ];

  try {
    const watcher = chokidar.watch(rootPath, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 80,
        pollInterval: 30,
      },
      // Be polite on macOS/Windows network mounts.
      ignorePermissionErrors: true,
      depth: 20,
    });

    const onEvent = (event: string) => (changedPath: string) => {
      notifyFsChanged(event, changedPath);
    };

    watcher
      .on('add', onEvent('add'))
      .on('unlink', onEvent('unlink'))
      .on('addDir', onEvent('addDir'))
      .on('unlinkDir', onEvent('unlinkDir'))
      .on('change', onEvent('change'))
      .on('error', (err) => {
        console.warn('[forge] workspace watcher error:', (err as Error).message);
      });

    workspaceWatcher = watcher;
    workspaceWatcherPath = rootPath;
  } catch (err) {
    console.warn('[forge] failed to start workspace watcher:', (err as Error).message);
  }
}

const isDev = !app.isPackaged;

// Resolve the application icon path. In dev mode the compiled main.js lives
// in dist-electron/, while in production builds the icon is copied next to
// main.js by the build script. We try the prod-style location first and fall
// back to the dev source-tree location.
function resolveIconPath(): string | null {
  const candidates = [
    path.join(__dirname, 'assets', 'forge-logo.png'),
    path.join(__dirname, '..', 'electron', 'assets', 'forge-logo.png'),
    path.join(process.cwd(), 'electron', 'assets', 'forge-logo.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* noop */
    }
  }
  return null;
}

interface TreeNode {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

interface RemoteWorkspace {
  target: string;
  path: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quotes a user-provided remote directory while preserving the shell's home
 * expansion. A plain shellQuote("~") produces the literal directory "~".
 */
function remoteDirectoryExpression(remotePath: string): string {
  const trimmed = remotePath.trim() || '~';
  if (trimmed === '~') return '"$HOME"';
  if (trimmed.startsWith('~/')) {
    const relativePath = trimmed.slice(2);
    return relativePath ? `"$HOME"/${shellQuote(relativePath)}` : '"$HOME"';
  }
  return shellQuote(trimmed);
}

function isRemoteWorkspacePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ssh://');
}

function parseRemoteWorkspaceUri(uri: string): RemoteWorkspace {
  if (!isRemoteWorkspacePath(uri)) {
    throw new Error('Ruta remota inválida.');
  }
  const rest = uri.slice('ssh://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error('La ruta remota debe incluir host y carpeta.');
  const target = decodeURIComponent(rest.slice(0, slash));
  const remotePath = decodeURI(rest.slice(slash)) || '/';
  if (!target || /[\s\x00-\x1f]/.test(target)) {
    throw new Error('Host SSH inválido.');
  }
  return { target, path: remotePath };
}

function buildRemoteWorkspaceUri(target: string, remotePath: string): string {
  const cleanTarget = target.trim();
  let cleanPath = remotePath.trim() || '~';
  if (!cleanPath.startsWith('/')) cleanPath = `~/${cleanPath.replace(/^~\/?/, '')}`;
  return `ssh://${encodeURIComponent(cleanTarget)}${encodeURI(cleanPath)}`;
}

function splitRemoteParent(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  if (idx <= 0) return '/';
  return filePath.slice(0, idx);
}

function remoteChildPath(parent: string, child: string): string {
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

function remotePathFromUri(uri: string): string {
  return parseRemoteWorkspaceUri(uri).path;
}

function remoteUriWithPath(uri: string, remotePath: string): string {
  const remote = parseRemoteWorkspaceUri(uri);
  return buildRemoteWorkspaceUri(remote.target, remotePath);
}

function runSshCommand(
  target: string,
  command: string,
  input?: string | Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      target,
      command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (b) => stdout.push(Buffer.from(b)));
    child.stderr.on('data', (b) => stderr.push(Buffer.from(b)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const message = Buffer.concat(stderr).toString('utf8').trim() || `ssh exited with ${code}`;
        reject(new Error(message));
      }
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runInteractiveSshCommand(target: string, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'ConnectTimeout=10', target, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (b) => stdout.push(Buffer.from(b)));
    child.stderr.on('data', (b) => stderr.push(Buffer.from(b)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `ssh exited with ${code}`));
    });
  });
}

async function assertRemoteDirectory(target: string, remotePath: string): Promise<string> {
  const out = await runInteractiveSshCommand(
    target,
    `cd ${remoteDirectoryExpression(remotePath)} && pwd -P`,
  );
  const resolved = out.toString('utf8').trim();
  if (!resolved) throw new Error('No se pudo resolver la carpeta remota.');
  return resolved;
}

async function browseRemoteDirectory(
  target: string,
  remotePath: string,
): Promise<{ path: string; parent: string | null; directories: { name: string; path: string }[] }> {
  const resolvedPath = await assertRemoteDirectory(target, remotePath);
  const output = await runSshCommand(
    target,
    [
      `cd ${shellQuote(resolvedPath)} || exit 2`,
      `printf '%s\\0' "$PWD"`,
      `find . -mindepth 1 -maxdepth 1 -type d -printf '%f\\0'`,
    ].join(' && '),
  );
  const values = output.toString('utf8').split('\0');
  const currentPath = values.shift() || resolvedPath;
  const directories = values
    .filter((name) => name && name !== '.' && name !== '..')
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: remoteChildPath(currentPath, name) }));
  const parent = currentPath === '/' ? null : splitRemoteParent(currentPath);
  return { path: currentPath, parent, directories };
}

async function readRemoteDirectoryRecursive(uri: string): Promise<TreeNode[]> {
  const remote = parseRemoteWorkspaceUri(uri);
  const command = [
    `cd ${shellQuote(remote.path)} || exit 2`,
    `find . -maxdepth 11 \\( -name node_modules -o -name dist -o -name dist-electron \\) -prune -o -mindepth 1 -exec sh -c 'for p do if [ -d "$p" ]; then printf "d\\t%s\\n" "$p"; else printf "f\\t%s\\n" "$p"; fi; done' sh {} +`,
  ].join(' && ');
  const output = await runSshCommand(remote.target, command);
  const rows = output.toString('utf8').split('\n').filter(Boolean);
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeNode[]>();
  dirs.set('.', root);

  for (const row of rows) {
    const tab = row.indexOf('\t');
    if (tab <= 0) continue;
    const kind = row.slice(0, tab);
    const rel = row.slice(tab + 1).replace(/^\.\//, '');
    if (!rel) continue;
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    const parentRel = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    const remotePath = remoteChildPath(remote.path.replace(/\/+$/, ''), rel);
    const childUri = remoteUriWithPath(uri, remotePath);
    const node: TreeNode = {
      id: childUri,
      name,
      path: childUri,
      type: kind === 'd' ? 'directory' : 'file',
    };
    if (kind === 'd') {
      node.children = [];
      dirs.set(rel, node.children);
    }
    const parent = dirs.get(parentRel);
    if (parent) parent.push(node);
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  };
  sortNodes(root);
  return root;
}

function readDirectoryRecursive(dirPath: string, depth: number = 0): TreeNode[] {
  if (depth > 10) return [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const nodes: TreeNode[] = [];

    // Include hidden files/folders (those starting with ".") so users can
    // see .git, .env, .vscode, etc. in the explorer. We still skip a few
    // very large, well-known build/cache directories that should virtually
    // never be inspected from the explorer to keep recursion cheap.
    const HEAVY_DIRS = new Set(['node_modules', 'dist', 'dist-electron']);
    const sorted = entries
      .filter((e) => !HEAVY_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      const fullPath = path.join(dirPath, entry.name);
      const node: TreeNode = {
        id: fullPath,
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };

      if (entry.isDirectory()) {
        node.children = readDirectoryRecursive(fullPath, depth + 1);
      }

      nodes.push(node);
    }

    return nodes;
  } catch {
    return [];
  }
}

function createWindow(options: { restoreLastWorkspace?: boolean } = {}) {
  const restoreLastWorkspace = options.restoreLastWorkspace ?? true;
  const iconPath = resolveIconPath();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined;

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 520,
    minHeight: 600,
    frame: false,
    title: 'Forge',
    titleBarStyle: 'hidden',
    backgroundColor: '#323643',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;

  installEdgeSnap(window);

  // Ensure Linux/Wayland docks pick up the icon as well.
  if (process.platform === 'linux' && icon && !icon.isEmpty()) {
    try {
      window.setIcon(icon);
    } catch {
      /* noop */
    }
  }

  if (isDev) {
    window.loadURL('http://localhost:5173');
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    window.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Let the renderer own zoom (editor font size). Block Electron's default
  // page zoom on Ctrl/Cmd + +/-/0 so shortcuts don't fight each other.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.control || input.meta) || input.alt) return;
    const zoomKey =
      input.code === 'Equal' ||
      input.code === 'NumpadAdd' ||
      input.code === 'Minus' ||
      input.code === 'NumpadSubtract' ||
      input.code === 'Digit0' ||
      input.code === 'Numpad0';
    if (zoomKey) {
      event.preventDefault();
    }
  });

  window.webContents.once('did-finish-load', () => {
    if (!restoreLastWorkspace) return;
    const lastPath = getLastWorkspaceFromStore();
    if (lastPath && !window.isDestroyed()) {
      currentWorkspacePath = lastPath;
      window.webContents.send('workspace:restore', lastPath);
    }
  });

  // The LSP manager forwards notifications (publishDiagnostics, etc.) to
  // the current renderer window. Make sure it always knows which window to
  // target.
  lspManager.setWindow(window);

  window.on('focus', () => {
    mainWindow = window;
    lspManager.setWindow(window);
  });

  window.on('closed', () => {
    closeWorkspaceWatcher();
    // Best-effort: stop the LSP. We can't await here, but stop() handles
    // killed children gracefully.
    void lspManager.stop().catch(() => undefined);
    // Tear down the live server as well — sockets won't stay alive past the
    // process anyway, but doing it explicitly keeps shutdown clean.
    void stopLiveServer().catch(() => undefined);
    lspManager.setWindow(null);
    if (mainWindow === window) {
      mainWindow = BrowserWindow.getAllWindows()[0] || null;
      lspManager.setWindow(mainWindow);
    }
  });
}

function installEdgeSnap(window: BrowserWindow): void {
  // Linux window managers often do not provide edge-snap for frameless
  // Electron windows. Keep the native behavior where it exists, and add a
  // small fallback for the left/right/top edges after the user stops moving.
  if (process.platform !== 'linux') return;

  const threshold = 18;
  let timer: NodeJS.Timeout | null = null;
  let applying = false;

  window.on('move', () => {
    if (applying || window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) return;

      const bounds = window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const area = display.workArea;
      const leftDistance = Math.abs(bounds.x - area.x);
      const rightDistance = Math.abs(bounds.x + bounds.width - (area.x + area.width));
      const topDistance = Math.abs(bounds.y - area.y);

      let next: Electron.Rectangle | null = null;
      if (leftDistance <= threshold) {
        next = {
          x: area.x,
          y: area.y,
          width: Math.floor(area.width / 2),
          height: area.height,
        };
      } else if (rightDistance <= threshold) {
        const width = Math.floor(area.width / 2);
        next = {
          x: area.x + area.width - width,
          y: area.y,
          width,
          height: area.height,
        };
      } else if (topDistance <= threshold) {
        window.maximize();
        return;
      }

      if (!next) return;
      applying = true;
      window.setBounds(next, true);
      setTimeout(() => { applying = false; }, 250);
    }, 160);
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const selectedPath = result.filePaths[0];
  currentWorkspacePath = selectedPath;
  setLastWorkspaceInStore(selectedPath);
  return selectedPath;
});

ipcMain.handle(
  'remote:connect',
  async (_event, args: { target?: string; path?: string }) => {
    const target = typeof args?.target === 'string' ? args.target.trim() : '';
    const requestedPath = typeof args?.path === 'string' && args.path.trim()
      ? args.path.trim()
      : '~';
    if (!target) throw new Error('Debes indicar un host SSH.');
    if (/[\s\x00-\x1f]/.test(target)) {
      throw new Error('El host SSH no puede contener espacios.');
    }

    const resolvedPath = await assertRemoteDirectory(target, requestedPath);
    const uri = buildRemoteWorkspaceUri(target, resolvedPath);
    currentWorkspacePath = uri;
    setLastWorkspaceInStore(uri);
    return uri;
  },
);

ipcMain.handle(
  'remote:browse',
  async (_event, args: { target?: string; path?: string }) => {
    const target = typeof args?.target === 'string' ? args.target.trim() : '';
    const requestedPath = typeof args?.path === 'string' && args.path.trim()
      ? args.path.trim()
      : '~';
    if (!target) throw new Error('Debes indicar un host SSH.');
    if (/\s|[\x00-\x1f]/.test(target)) {
      throw new Error('El host SSH no puede contener espacios.');
    }
    return browseRemoteDirectory(target, requestedPath);
  },
);

ipcMain.handle('fs:readDirectory', async (_event, dirPath: string) => {
  try {
    if (isRemoteWorkspacePath(dirPath)) {
      return readRemoteDirectoryRecursive(dirPath);
    }
    return readDirectoryRecursive(dirPath);
  } catch {
    return [];
  }
});

ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  try {
    if (isRemoteWorkspacePath(filePath)) {
      const remote = parseRemoteWorkspaceUri(filePath);
      const out = await runSshCommand(remote.target, `cat ${shellQuote(remote.path)}`);
      return out.toString('utf8');
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    throw new Error(`Failed to read file: ${err.message}`);
  }
});

// MIME types for image extensions — the image viewer needs the correct
// Content-Type baked into the data URL so the browser can decode it.
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

ipcMain.handle('fs:readImageDataUrl', async (_event, filePath: string) => {
  try {
    const actualPath = isRemoteWorkspacePath(filePath)
      ? remotePathFromUri(filePath)
      : filePath;
    const ext = path.extname(actualPath).toLowerCase();
    const mime = IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
    const buf = isRemoteWorkspacePath(filePath)
      ? await runSshCommand(
          parseRemoteWorkspaceUri(filePath).target,
          `cat ${shellQuote(parseRemoteWorkspaceUri(filePath).path)}`,
        )
      : fs.readFileSync(filePath);
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    return { dataUrl, size: buf.length };
  } catch (err: any) {
    throw new Error(`Failed to read image: ${err.message}`);
  }
});

ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    if (isRemoteWorkspacePath(filePath)) {
      const remote = parseRemoteWorkspaceUri(filePath);
      const parent = splitRemoteParent(remote.path);
      await runSshCommand(
        remote.target,
        `mkdir -p ${shellQuote(parent)} && cat > ${shellQuote(remote.path)}`,
        content,
      );
      return true;
    }
    // Ensure parent directories exist (mkdir -p) so callers can write to
    // brand-new paths — e.g. the AI agent's real-time streaming writes
    // files like `src/components/NewFile.tsx` whose parent folders may
    // not have been created yet by the user.
    const parent = path.dirname(filePath);
    if (parent && parent !== '.' && parent !== filePath) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch (err: any) {
    throw new Error(`Failed to write file: ${err.message}`);
  }
});

ipcMain.handle('fs:createFile', async (_event, filePath: string) => {
  try {
    if (isRemoteWorkspacePath(filePath)) {
      const remote = parseRemoteWorkspaceUri(filePath);
      await runSshCommand(
        remote.target,
        `if [ -e ${shellQuote(remote.path)} ]; then echo "File already exists" >&2; exit 1; fi; mkdir -p ${shellQuote(splitRemoteParent(remote.path))} && : > ${shellQuote(remote.path)}`,
      );
      return true;
    }
    if (fs.existsSync(filePath)) {
      throw new Error('File already exists');
    }
    fs.writeFileSync(filePath, '', 'utf-8');
    return true;
  } catch (err: any) {
    throw new Error(`Failed to create file: ${err.message}`);
  }
});

ipcMain.handle('fs:createDirectory', async (_event, dirPath: string) => {
  try {
    if (isRemoteWorkspacePath(dirPath)) {
      const remote = parseRemoteWorkspaceUri(dirPath);
      await runSshCommand(
        remote.target,
        `if [ -e ${shellQuote(remote.path)} ]; then echo "Directory already exists" >&2; exit 1; fi; mkdir -p ${shellQuote(remote.path)}`,
      );
      return true;
    }
    if (fs.existsSync(dirPath)) {
      throw new Error('Directory already exists');
    }
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (err: any) {
    throw new Error(`Failed to create directory: ${err.message}`);
  }
});

ipcMain.handle('fs:deleteItem', async (_event, itemPath: string) => {
  try {
    if (isRemoteWorkspacePath(itemPath)) {
      const remote = parseRemoteWorkspaceUri(itemPath);
      await runSshCommand(remote.target, `rm -rf -- ${shellQuote(remote.path)}`);
      return true;
    }
    const stat = fs.statSync(itemPath);
    if (stat.isDirectory()) {
      fs.rmSync(itemPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(itemPath);
    }
    return true;
  } catch (err: any) {
    throw new Error(`Failed to delete: ${err.message}`);
  }
});

ipcMain.handle('fs:renameItem', async (_event, oldPath: string, newPath: string) => {
  try {
    if (isRemoteWorkspacePath(oldPath) || isRemoteWorkspacePath(newPath)) {
      if (!isRemoteWorkspacePath(oldPath) || !isRemoteWorkspacePath(newPath)) {
        throw new Error('Cannot rename between local and remote paths');
      }
      const oldRemote = parseRemoteWorkspaceUri(oldPath);
      const newRemote = parseRemoteWorkspaceUri(newPath);
      if (oldRemote.target !== newRemote.target) {
        throw new Error('Cannot rename between different SSH hosts');
      }
      await runSshCommand(
        oldRemote.target,
        `mkdir -p ${shellQuote(splitRemoteParent(newRemote.path))} && mv -- ${shellQuote(oldRemote.path)} ${shellQuote(newRemote.path)}`,
      );
      return true;
    }
    fs.renameSync(oldPath, newPath);
    return true;
  } catch (err: any) {
    throw new Error(`Failed to rename: ${err.message}`);
  }
});

// ── Workspace watcher IPC ──────────────────────────────────────────────
// The renderer calls fs:watch(path) right after opening a workspace, and
// fs:unwatch when it closes / switches workspace. Switching workspaces is
// handled implicitly: a second fs:watch call tears down the previous
// watcher first.
ipcMain.handle('fs:watch', async (_event, dirPath: string) => {
  if (dirPath) {
    currentWorkspacePath = dirPath;
    setLastWorkspaceInStore(dirPath);
    // Workspace-scope settings follow the open workspace: let renderers
    // re-resolve their configuration against the new .forge/settings.json.
    broadcastExtensionConfigChange('*');
    // Trust is per workspace too, and the new one starts restricted unless
    // it was decided before: push the state without waiting for a poll.
    broadcastWorkspaceTrust(getWorkspaceTrustStatus());
  }
  if (isRemoteWorkspacePath(dirPath)) {
    closeWorkspaceWatcher();
    return true;
  }
  startWorkspaceWatcher(dirPath);
  return true;
});

ipcMain.handle('fs:unwatch', async () => {
  closeWorkspaceWatcher();
  return true;
});

// ── Window Controls ──────────────────────────────────────────────────────
ipcMain.on('window:new', () => {
  createWindow({ restoreLastWorkspace: false });
});

ipcMain.on('window:minimize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  window?.minimize();
});

ipcMain.on('window:maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (window?.isMaximized()) {
    window.unmaximize();
  } else {
    window?.maximize();
  }
});

ipcMain.on('window:close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  window?.close();
});

// ── Native Edit Commands ────────────────────────────────────────────────
function focusedContents() {
  return BrowserWindow.getFocusedWindow()?.webContents || mainWindow?.webContents || null;
}

ipcMain.on('edit:undo', () => focusedContents()?.undo());
ipcMain.on('edit:redo', () => focusedContents()?.redo());
ipcMain.on('edit:cut', () => focusedContents()?.cut());
ipcMain.on('edit:copy', () => focusedContents()?.copy());
ipcMain.on('edit:paste', () => focusedContents()?.paste());
ipcMain.on('edit:selectAll', () => focusedContents()?.selectAll());

// ── Terminal (node-pty with child_process fallback) ──────────────────────
//
// We try to load node-pty (a real PTY). If it isn't available — common in
// environments where the native binary wasn't rebuilt — we fall back to a
// plain child_process shell. The terminal will still work; it just won't
// support full ANSI features like clear / interactive vim.

interface PtyLike {
  pid: number;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (d: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

let ptyModule: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ptyModule = require('node-pty');
} catch (err) {
  console.warn('[forge] node-pty not available, falling back to child_process:', (err as Error).message);
}

function createPty(opts: { cwd?: string; cols?: number; rows?: number }): PtyLike {
  const shell = process.platform === 'win32'
    ? (process.env.COMSPEC || 'powershell.exe')
    : (process.env.SHELL || '/bin/bash');
  const cwd = opts.cwd || os.homedir();
  const cols = opts.cols || 80;
  const rows = opts.rows || 24;

  if (ptyModule) {
    const claudeEnv = claudeIdeServer.getTerminalEnv();
    const p = ptyModule.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        ...claudeEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as { [k: string]: string },
    });
    return {
      pid: p.pid,
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(cb),
      write: (d) => p.write(d),
      resize: (c, r) => { try { p.resize(c, r); } catch { /* noop */ } },
      kill: () => { try { p.kill(); } catch { /* noop */ } },
    };
  }

  // Fallback: child_process — line-buffered, no real PTY.
  const child: ChildProcessWithoutNullStreams = spawn(shell, [], {
    cwd,
    env: { ...process.env, ...claudeIdeServer.getTerminalEnv(), TERM: 'xterm-256color' },
  });

  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((e: { exitCode: number }) => void)[] = [];

  child.stdout.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString('utf8'))));
  child.stderr.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString('utf8'))));
  child.on('exit', (code) => exitCbs.forEach((cb) => cb({ exitCode: code ?? 0 })));

  // Welcome banner so the user sees something
  setTimeout(() => {
    const banner = '\x1b[90m[forge] node-pty unavailable — using basic shell. Install node-pty for full terminal support.\x1b[0m\r\n';
    dataCbs.forEach((cb) => cb(banner));
  }, 50);

  return {
    pid: child.pid || 0,
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    write: (d) => { try { child.stdin.write(d); } catch { /* noop */ } },
    resize: () => { /* not supported */ },
    kill: () => { try { child.kill(); } catch { /* noop */ } },
  };
}

function createSshPty(remote: RemoteWorkspace, opts: { cols?: number; rows?: number }): PtyLike {
  const command = `cd ${shellQuote(remote.path)} && exec "\${SHELL:-/bin/sh}" -l`;
  const cols = opts.cols || 80;
  const rows = opts.rows || 24;

  if (ptyModule) {
    const p = ptyModule.spawn('ssh', ['-t', remote.target, command], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as { [k: string]: string },
    });
    return {
      pid: p.pid,
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(cb),
      write: (d) => p.write(d),
      resize: (c, r) => { try { p.resize(c, r); } catch { /* noop */ } },
      kill: () => { try { p.kill(); } catch { /* noop */ } },
    };
  }

  const child: ChildProcessWithoutNullStreams = spawn('ssh', ['-tt', remote.target, command], {
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  const dataCbs: ((d: string) => void)[] = [];
  const exitCbs: ((e: { exitCode: number }) => void)[] = [];
  child.stdout.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString('utf8'))));
  child.stderr.on('data', (b) => dataCbs.forEach((cb) => cb(b.toString('utf8'))));
  child.on('exit', (code) => exitCbs.forEach((cb) => cb({ exitCode: code ?? 0 })));
  return {
    pid: child.pid || 0,
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    write: (d) => { try { child.stdin.write(d); } catch { /* noop */ } },
    resize: () => { /* not supported */ },
    kill: () => { try { child.kill(); } catch { /* noop */ } },
  };
}

const terminals = new Map<string, PtyLike>();
let nextTermId = 1;

ipcMain.handle('terminal:create', (_event, opts: { cwd?: string; cols?: number; rows?: number }) => {
  const id = `term-${nextTermId++}`;
  // Prefer explicit cwd from the caller, otherwise fall back to:
  //   1) the currently-open workspace
  //   2) the user's home directory (os.homedir() handles Windows / *nix)
  // `process.cwd()` is intentionally a last-ditch fallback only.
  const requestedCwd = typeof opts?.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : undefined;
  const resolvedCwd =
    requestedCwd ||
    (currentWorkspacePath && currentWorkspacePath.length > 0
      ? currentWorkspacePath
      : os.homedir() || process.cwd());

  const pty = isRemoteWorkspacePath(resolvedCwd)
    ? createSshPty(parseRemoteWorkspaceUri(resolvedCwd), opts || {})
    : createPty({
        ...(opts || {}),
        cwd: resolvedCwd,
      });
  terminals.set(id, pty);

  pty.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal:data:${id}`, data);
    }
  });

  pty.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal:exit:${id}`, exitCode);
    }
    terminals.delete(id);
  });

  return { id };
});

ipcMain.on('terminal:write', (_event, id: string, data: string) => {
  const pty = terminals.get(id);
  if (pty) pty.write(data);
});

ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
  const pty = terminals.get(id);
  if (pty) pty.resize(cols, rows);
});

ipcMain.on('terminal:kill', (_event, id: string) => {
  const pty = terminals.get(id);
  if (pty) {
    pty.kill();
    terminals.delete(id);
  }
});

// Sends a command string to the pty. Identical to terminal:write but kept
// as a separate channel so future enhancements (history, auto-newline,
// shell escaping) can hook in without breaking the raw write path.
ipcMain.on('terminal:sendCommand', (_event, id: string, command: string) => {
  const pty = terminals.get(id);
  if (pty && typeof command === 'string') {
    pty.write(command);
  }
});

// ── Clipboard ────────────────────────────────────────────────────────────
ipcMain.handle('clipboard:read', () => {
  try {
    return clipboard.readText() || '';
  } catch {
    return '';
  }
});

// ── Shell integration ────────────────────────────────────────────────────
ipcMain.handle('shell:revealInFolder', (_event, targetPath: string) => {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('shell:openExternal', (_event, url: string) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  void shell.openExternal(url);
  return true;
});

// ── GitHub OAuth (device flow) ───────────────────────────────────────────
//
// Token + client id live in the same local JSON config as the AI keys.

interface GithubConfig {
  clientId?: string;
  token?: string;
  login?: string;
}

function loadGithubConfig(): GithubConfig {
  const cfg = loadConfig();
  return cfg.github && typeof cfg.github === 'object' ? (cfg.github as GithubConfig) : {};
}

function saveGithubConfig(gh: GithubConfig): void {
  const cfg = loadConfig();
  cfg.github = gh;
  saveConfig(cfg);
}

// Device-flow state for the session (deviceCode never goes to the renderer).
let pendingGithubFlow: { clientId: string; info: DeviceCodeInfo } | null = null;

ipcMain.handle('github:getAuth', async () => {
  const gh = loadGithubConfig();
  return {
    authenticated: Boolean(gh.token),
    login: gh.login || null,
    clientId: gh.clientId || null,
  };
});

ipcMain.handle('github:setClientId', async (_event, clientId: string) => {
  if (typeof clientId !== 'string') throw new Error('Argumentos inválidos.');
  const gh = loadGithubConfig();
  gh.clientId = clientId.trim();
  saveGithubConfig(gh);
  return true;
});

ipcMain.handle('github:startDeviceFlow', async () => {
  const gh = loadGithubConfig();
  if (!gh.clientId) {
    throw new Error('Configura primero el Client ID de tu OAuth App de GitHub.');
  }
  const info = await startDeviceFlow(gh.clientId);
  pendingGithubFlow = { clientId: gh.clientId, info };
  return {
    userCode: info.userCode,
    verificationUri: info.verificationUri,
    expiresIn: info.expiresIn,
  };
});

ipcMain.handle('github:waitForToken', async () => {
  if (!pendingGithubFlow) throw new Error('No hay una autenticación en curso.');
  const { clientId, info } = pendingGithubFlow;
  const token = await waitForDeviceToken(clientId, info);
  pendingGithubFlow = null;
  const login = await fetchGithubLogin(token);
  const gh = loadGithubConfig();
  gh.token = token;
  gh.login = login;
  saveGithubConfig(gh);
  return { login };
});

ipcMain.handle('github:cancelDeviceFlow', async () => {
  cancelDeviceFlow();
  pendingGithubFlow = null;
  return true;
});

ipcMain.handle('github:logout', async () => {
  cancelDeviceFlow();
  pendingGithubFlow = null;
  const gh = loadGithubConfig();
  delete gh.token;
  delete gh.login;
  saveGithubConfig(gh);
  return true;
});

// ── Claude Code IDE bridge ───────────────────────────────────────────────
ipcMain.on('claude:editorStateChanged', (_event, state: ClaudeIdeEditorState) => {
  if (!state || typeof state !== 'object') return;
  if (typeof state.workspacePath === 'string' || state.workspacePath === null) {
    currentWorkspacePath = state.workspacePath;
  }
  claudeIdeServer.updateEditorState({
    workspacePath:
      typeof state.workspacePath === 'string' && state.workspacePath
        ? state.workspacePath
        : null,
    workspaceName:
      typeof state.workspaceName === 'string' && state.workspaceName
        ? state.workspaceName
        : null,
    openEditors: Array.isArray(state.openEditors) ? state.openEditors : [],
  });
});

ipcMain.on('claude:selectionChanged', (_event, selection: ClaudeIdeSelection | null) => {
  claudeIdeServer.updateSelection(selection);
});

ipcMain.on(
  'claude:renderer-response',
  (_event, payload: { id: number; ok: boolean; result?: any; error?: string }) => {
    if (!payload || typeof payload.id !== 'number') return;
    const pending = pendingClaudeRendererRequests.get(payload.id);
    if (!pending) return;
    pendingClaudeRendererRequests.delete(payload.id);
    clearTimeout(pending.timer);
    if (payload.ok) {
      pending.resolve(payload.result);
    } else {
      pending.reject(new Error(payload.error || 'Claude IDE renderer command failed.'));
    }
  },
);

ipcMain.handle('claude:status', async () => {
  return claudeIdeServer.getTerminalEnv();
});

// ── Live Server (built-in HTTP server on port 5500) ──────────────────────
//
// Serves static files (HTML, JS, CSS, images, fonts…) from the directory
// containing the chosen HTML file. There is at most one server running at
// any time; calling startLiveServer() while one is already up tears the
// previous server down first. The server is killed automatically when the
// Electron app shuts down (see app.on('window-all-closed')).

const LIVE_SERVER_BASE_PORT = 5500;
const LIVE_SERVER_MAX_PORT_ATTEMPTS = 50;
let liveServerActivePort: number | null = null;

const LIVE_SERVER_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

interface LiveServerStatus {
  active: boolean;
  port: number | null;
  root: string | null;
  htmlFile: string | null;
  url: string | null;
}

let liveServer: http.Server | null = null;
let liveServerRoot: string | null = null;
let liveServerHtmlFile: string | null = null;

function liveServerStatusPayload(): LiveServerStatus {
  if (!liveServer || liveServerActivePort == null) {
    return { active: false, port: null, root: null, htmlFile: null, url: null };
  }
  return {
    active: true,
    port: liveServerActivePort,
    root: liveServerRoot,
    htmlFile: liveServerHtmlFile,
    url: liveServerHtmlFile
      ? `http://localhost:${liveServerActivePort}/${encodeURIComponent(liveServerHtmlFile)}`
      : `http://localhost:${liveServerActivePort}/`,
  };
}

function broadcastLiveServerStatus() {
  const payload = liveServerStatusPayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('liveServer:status', payload);
  }
}

function stopLiveServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!liveServer) {
      liveServerRoot = null;
      liveServerHtmlFile = null;
      liveServerActivePort = null;
      resolve();
      return;
    }
    const srv = liveServer;
    liveServer = null;
    try {
      srv.closeAllConnections?.();
    } catch {
      /* noop */
    }
    srv.close(() => {
      liveServerRoot = null;
      liveServerHtmlFile = null;
      liveServerActivePort = null;
      broadcastLiveServerStatus();
      resolve();
    });
    // closeAllConnections + close() should be near-instant, but in case a
    // keep-alive socket lingers, force resolution after 500ms.
    setTimeout(() => resolve(), 500);
  });
}

function buildLiveServer(rootDir: string): http.Server {
  const normalizedRoot = path.resolve(rootDir);

  return http.createServer((req, res) => {
    try {
      const rawUrl = req.url || '/';
      const queryless = rawUrl.split('?')[0].split('#')[0];
      let pathname: string;
      try {
        pathname = decodeURIComponent(queryless);
      } catch {
        pathname = queryless;
      }

      // Normalize and prevent directory traversal.
      const safeRel = path
        .normalize(pathname)
        .replace(/^([\\/]+)/, ''); // strip leading slashes
      const candidatePath = path.resolve(normalizedRoot, safeRel);
      if (
        candidatePath !== normalizedRoot &&
        !candidatePath.startsWith(normalizedRoot + path.sep)
      ) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }

      let finalPath = candidatePath;
      try {
        const stat = fs.statSync(finalPath);
        if (stat.isDirectory()) {
          const indexCandidate = path.join(finalPath, 'index.html');
          if (fs.existsSync(indexCandidate)) {
            finalPath = indexCandidate;
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
          }
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(finalPath).toLowerCase();
      const mime = LIVE_SERVER_MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      fs.createReadStream(finalPath)
        .on('error', () => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          res.end('500 Internal Server Error');
        })
        .pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(`500 Internal Server Error: ${(err as Error).message}`);
    }
  });
}

async function startLiveServer(htmlPath: string): Promise<LiveServerStatus> {
  if (typeof htmlPath !== 'string' || !htmlPath) {
    throw new Error('Ruta de archivo HTML requerida.');
  }
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`El archivo no existe: ${htmlPath}`);
  }

  const stat = fs.statSync(htmlPath);
  const rootDir = stat.isDirectory() ? htmlPath : path.dirname(htmlPath);
  const htmlFile = stat.isDirectory() ? 'index.html' : path.basename(htmlPath);

  // Stop any previous server before starting a new one.
  await stopLiveServer();

  const server = buildLiveServer(rootDir);

  // Try the base port first; if EADDRINUSE, increment and retry until a free
  // one is found (or the attempt limit is reached).
  const tryListen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  let boundPort: number | null = null;
  let lastError: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < LIVE_SERVER_MAX_PORT_ATTEMPTS; i++) {
    const candidatePort = LIVE_SERVER_BASE_PORT + i;
    try {
      await tryListen(candidatePort);
      boundPort = candidatePort;
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      lastError = e;
      if (e.code !== 'EADDRINUSE') {
        throw e;
      }
      // Port in use — try the next one on the next loop iteration.
    }
  }

  if (boundPort == null) {
    const last = LIVE_SERVER_BASE_PORT + LIVE_SERVER_MAX_PORT_ATTEMPTS - 1;
    throw new Error(
      `No se encontró un puerto libre entre ${LIVE_SERVER_BASE_PORT} y ${last}` +
        (lastError ? ` (último error: ${lastError.message})` : '') +
        '.'
    );
  }

  liveServer = server;
  liveServerRoot = rootDir;
  liveServerHtmlFile = htmlFile;
  liveServerActivePort = boundPort;
  broadcastLiveServerStatus();

  return liveServerStatusPayload();
}

ipcMain.handle('liveServer:start', async (_event, htmlPath: string) => {
  return startLiveServer(htmlPath);
});

ipcMain.handle('liveServer:stop', async () => {
  await stopLiveServer();
  return true;
});

ipcMain.handle('liveServer:status', async () => {
  return liveServerStatusPayload();
});

// ── LSP (typescript-language-server) ─────────────────────────────────────
ipcMain.handle('lsp:start', async (_event, workspacePath: string) => {
  if (typeof workspacePath !== 'string' || !workspacePath) {
    throw new Error('lsp:start requires a workspacePath');
  }
  if (isRemoteWorkspacePath(workspacePath)) {
    await lspManager.stop();
    return true;
  }
  await lspManager.start(workspacePath);
  return true;
});

ipcMain.handle('lsp:stop', async () => {
  await lspManager.stop();
  return true;
});

ipcMain.handle('lsp:request', async (_event, method: string, params: any) => {
  if (typeof method !== 'string') throw new Error('lsp:request: method is required');
  return lspManager.request(method, params);
});

ipcMain.on('lsp:notification', (_event, method: string, params: any) => {
  if (typeof method !== 'string') return;
  lspManager.notification(method, params);
});

// ── AI providers / Agent ─────────────────────────────────────────────────
//
// API keys live in the same JSON config file used for `lastWorkspace`.
// electron-store is installed as a dependency, but our main process is
// compiled to CommonJS while electron-store v11 is ESM-only — so we just
// extend the existing fs-based helpers, which provide identical "stored
// locally, never leaves the machine" semantics.

interface AIConfig {
  apiKeys?: Partial<Record<ProviderId, string>>;
  activeProvider?: ProviderId;
  activeModel?: string;
}

function loadAIConfig(): AIConfig {
  const cfg = loadConfig();
  const ai = cfg.ai;
  return ai && typeof ai === 'object' ? (ai as AIConfig) : {};
}

function saveAIConfig(ai: AIConfig): void {
  const cfg = loadConfig();
  cfg.ai = ai;
  saveConfig(cfg);
}

ipcMain.handle('ai:listProviders', async () => PROVIDERS);

ipcMain.handle('ai:getConfig', async () => {
  const ai = loadAIConfig();
  // Don't ship the actual keys to the renderer; just tell it which providers
  // are configured so the UI can render available options.
  const configuredProviders = Object.entries(ai.apiKeys || {})
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .map(([k]) => k as ProviderId);
  return {
    configuredProviders,
    activeProvider: ai.activeProvider || null,
    activeModel: ai.activeModel || null,
  };
});

ipcMain.handle('ai:setApiKey', async (_event, provider: ProviderId, apiKey: string) => {
  if (typeof provider !== 'string') throw new Error('provider requerido');
  if (typeof apiKey !== 'string') throw new Error('apiKey requerido');
  const ai = loadAIConfig();
  ai.apiKeys = { ...(ai.apiKeys || {}), [provider]: apiKey };
  saveAIConfig(ai);
  return true;
});

ipcMain.handle('ai:removeApiKey', async (_event, provider: ProviderId) => {
  const ai = loadAIConfig();
  if (ai.apiKeys && ai.apiKeys[provider]) {
    delete ai.apiKeys[provider];
    saveAIConfig(ai);
  }
  return true;
});

ipcMain.handle('ai:setActive', async (_event, provider: ProviderId, model: string) => {
  const ai = loadAIConfig();
  // An empty provider/model pair clears the active selection (used when the
  // user deletes the API key of the currently-active provider).
  if (!provider || !model) {
    delete ai.activeProvider;
    delete ai.activeModel;
  } else {
    ai.activeProvider = provider;
    ai.activeModel = model;
  }
  saveAIConfig(ai);
  return true;
});

ipcMain.handle('ai:listModels', async (_event, provider: ProviderId) => {
  if (typeof provider !== 'string') throw new Error('provider requerido');
  const ai = loadAIConfig();
  const apiKey = ai.apiKeys?.[provider];
  if (!apiKey) throw new Error(`No hay clave de API configurada para ${provider}.`);
  return aiListModels(provider, apiKey);
});

// Start a streaming chat. The renderer supplies a streamId and listens on
// the corresponding channels.
ipcMain.handle(
  'ai:chatStream',
  async (
    _event,
    args: {
      streamId: string;
      provider: ProviderId;
      model: string;
      messages: ChatMessage[];
    },
  ) => {
    if (!args || typeof args !== 'object') throw new Error('args requerido');
    const { streamId, provider, model, messages } = args;
    if (!streamId) throw new Error('streamId requerido');
    const ai = loadAIConfig();
    const apiKey = ai.apiKeys?.[provider];
    if (!apiKey) throw new Error(`No hay clave de API configurada para ${provider}.`);
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages requerido');
    }

    console.log(`[forge:ai] chatStream → provider=${provider} model=${model} messages=${messages.length}`);

    const send = (event: string, data: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`ai:stream:${streamId}`, { event, data });
      }
    };

    const handle = aiStreamChat({
      provider,
      apiKey,
      model,
      messages,
      handlers: {
        onDelta: (text) => send('delta', text),
        onDone: () => {
          aiStreams.delete(streamId);
          send('done', null);
        },
        onError: (err) => {
          aiStreams.delete(streamId);
          send('error', err.message || String(err));
        },
      },
    });
    aiStreams.set(streamId, handle);
    return true;
  },
);

ipcMain.handle('ai:abortStream', async (_event, streamId: string) => {
  const handle = aiStreams.get(streamId);
  if (handle) {
    try {
      handle.abort();
    } catch {
      /* noop */
    }
    aiStreams.delete(streamId);
  }
  return true;
});

// ── Agent filesystem tools ───────────────────────────────────────────────
ipcMain.handle('agent:leerArchivo', async (_event, workspacePath: string, ruta: string) => {
  if (!workspacePath) throw new Error('Sin workspace abierto.');
  return leerArchivo(workspacePath, ruta);
});

ipcMain.handle(
  'agent:escribirArchivo',
  async (_event, workspacePath: string, ruta: string, contenido: string) => {
    if (!workspacePath) throw new Error('Sin workspace abierto.');
    return escribirArchivo(workspacePath, ruta, contenido);
  },
);

ipcMain.handle('agent:listarCarpeta', async (_event, workspacePath: string, ruta: string) => {
  if (!workspacePath) throw new Error('Sin workspace abierto.');
  return listarCarpeta(workspacePath, ruta);
});

ipcMain.handle('agent:buscarEnProyecto', async (_event, workspacePath: string, texto: string) => {
  if (!workspacePath) throw new Error('Sin workspace abierto.');
  return buscarEnProyecto(workspacePath, texto);
});

ipcMain.handle(
  'agent:reemplazarEnProyecto',
  async (
    _event,
    workspacePath: string,
    search: string,
    replace: string,
    options?: { previewOnly?: boolean },
  ) => {
    if (!workspacePath || typeof search !== 'string' || typeof replace !== 'string') {
      throw new Error('Argumentos inválidos.');
    }
    return reemplazarEnProyecto(workspacePath, search, replace, options ?? {});
  },
);

ipcMain.handle('agent:initContext', async (_event, workspacePath: string) => {
  if (!workspacePath) throw new Error('Sin workspace abierto.');
  return collectInitContext(workspacePath);
});

ipcMain.handle(
  'agent:snapshotFolder',
  async (_event, workspacePath: string, folderPath: string) => {
    if (!workspacePath) throw new Error('Sin workspace abierto.');
    return snapshotFolder(workspacePath, folderPath);
  },
);

ipcMain.handle('agent:fileExists', async (_event, workspacePath: string, ruta: string) => {
  if (!workspacePath) return false;
  return agentFileExists(workspacePath, ruta);
});

ipcMain.handle('agent:readFileSafe', async (_event, workspacePath: string, ruta: string) => {
  if (!workspacePath) return null;
  return agentReadFileSafe(workspacePath, ruta);
});

// ── Git (Source Control panel) ───────────────────────────────────────────
ipcMain.handle('git:status', async (_event, workspacePath: string) => {
  if (typeof workspacePath !== 'string' || !workspacePath) {
    return {
      isRepo: false,
      branch: null,
      changes: [],
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      hasRemote: false,
    };
  }
  if (isRemoteWorkspacePath(workspacePath)) {
    return {
      isRepo: false,
      branch: null,
      changes: [],
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      hasRemote: false,
    };
  }
  return gitStatus(workspacePath);
});

ipcMain.handle('git:stage', async (_event, workspacePath: string, relPaths: string[]) => {
  if (isRemoteWorkspacePath(workspacePath)) return true;
  if (!workspacePath || !Array.isArray(relPaths)) throw new Error('Argumentos inválidos.');
  await gitStage(workspacePath, relPaths.filter((p) => typeof p === 'string'));
  return true;
});

ipcMain.handle('git:unstage', async (_event, workspacePath: string, relPaths: string[]) => {
  if (isRemoteWorkspacePath(workspacePath)) return true;
  if (!workspacePath || !Array.isArray(relPaths)) throw new Error('Argumentos inválidos.');
  await gitUnstage(workspacePath, relPaths.filter((p) => typeof p === 'string'));
  return true;
});

ipcMain.handle('git:commit', async (_event, workspacePath: string, message: string) => {
  if (isRemoteWorkspacePath(workspacePath)) throw new Error('Git remoto está disponible desde la terminal SSH.');
  if (!workspacePath || typeof message !== 'string') throw new Error('Argumentos inválidos.');
  return gitCommit(workspacePath, message);
});

ipcMain.handle('git:discard', async (_event, workspacePath: string, relPaths: string[]) => {
  if (isRemoteWorkspacePath(workspacePath)) return true;
  if (!workspacePath || !Array.isArray(relPaths)) throw new Error('Argumentos inválidos.');
  await gitDiscard(workspacePath, relPaths.filter((p) => typeof p === 'string'));
  return true;
});

ipcMain.handle('git:diffSummary', async (_event, workspacePath: string) => {
  if (isRemoteWorkspacePath(workspacePath)) return { staged: false, text: '' };
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('Argumentos inválidos.');
  return gitDiffSummary(workspacePath);
});

function currentGitAuth(): { githubToken: string } | undefined {
  const token = loadGithubConfig().token;
  return token ? { githubToken: token } : undefined;
}

ipcMain.handle('git:push', async (_event, workspacePath: string) => {
  if (isRemoteWorkspacePath(workspacePath)) throw new Error('Git remoto está disponible desde la terminal SSH.');
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('Argumentos inválidos.');
  return gitPush(workspacePath, currentGitAuth());
});

ipcMain.handle('git:pull', async (_event, workspacePath: string) => {
  if (isRemoteWorkspacePath(workspacePath)) throw new Error('Git remoto está disponible desde la terminal SSH.');
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('Argumentos inválidos.');
  return gitPull(workspacePath, currentGitAuth());
});

ipcMain.handle('git:branches', async (_event, workspacePath: string) => {
  if (isRemoteWorkspacePath(workspacePath)) return [];
  if (!workspacePath || typeof workspacePath !== 'string') throw new Error('Argumentos inválidos.');
  return gitListBranches(workspacePath);
});

ipcMain.handle('git:checkoutBranch', async (_event, workspacePath: string, branchName: string) => {
  if (isRemoteWorkspacePath(workspacePath)) throw new Error('Git remoto está disponible desde la terminal SSH.');
  if (!workspacePath || typeof branchName !== 'string') throw new Error('Argumentos inválidos.');
  return gitCheckoutBranch(workspacePath, branchName);
});

ipcMain.handle('git:createBranch', async (_event, workspacePath: string, branchName: string) => {
  if (isRemoteWorkspacePath(workspacePath)) throw new Error('Git remoto está disponible desde la terminal SSH.');
  if (!workspacePath || typeof branchName !== 'string') throw new Error('Argumentos inválidos.');
  return gitCreateBranch(workspacePath, branchName);
});

ipcMain.handle('git:diff', async (_event, workspacePath: string, relPath: string, staged = false) => {
  if (isRemoteWorkspacePath(workspacePath)) return '';
  if (!workspacePath || typeof relPath !== 'string') throw new Error('Argumentos inválidos.');
  return gitDiff(workspacePath, relPath, Boolean(staged));
});

ipcMain.handle(
  'git:fileVersions',
  async (_event, workspacePath: string, relPath: string, staged = false) => {
    if (isRemoteWorkspacePath(workspacePath)) return { original: '', modified: '' };
    if (!workspacePath || typeof relPath !== 'string') throw new Error('Argumentos inválidos.');
    return gitGetFileVersions(workspacePath, relPath, Boolean(staged));
  },
);

ipcMain.handle(
  'git:commitFileVersions',
  async (_event, workspacePath: string, relPath: string, commitHash: string) => {
    if (isRemoteWorkspacePath(workspacePath)) return { original: '', modified: '' };
    if (!workspacePath || typeof relPath !== 'string' || typeof commitHash !== 'string') {
      throw new Error('Argumentos inválidos.');
    }
    return gitGetCommitFileVersions(workspacePath, relPath, commitHash);
  },
);

ipcMain.handle('git:log', async (_event, workspacePath: string, relPath?: string, limit?: number) => {
  if (isRemoteWorkspacePath(workspacePath)) return [];
  if (!workspacePath) throw new Error('Argumentos inválidos.');
  return gitLog(
    workspacePath,
    typeof relPath === 'string' && relPath.trim() ? relPath : undefined,
    typeof limit === 'number' ? limit : undefined,
  );
});

// ── Extensions (VSIX / Open VSX) ───────────────────────────────────────────
ipcMain.handle('ext:installVsix', async () => {
  return installVsix(mainWindow);
});

ipcMain.handle('ext:installFromOpenVsx', async (_event, extensionId: string) => {
  if (typeof extensionId !== 'string' || !extensionId.trim()) {
    throw new Error('Identificador de extensión requerido.');
  }
  return installFromOpenVsx(extensionId);
});

ipcMain.handle('ext:searchOpenVsx', async (_event, query: string, size?: number) => {
  if (typeof query !== 'string') throw new Error('Consulta de búsqueda inválida.');
  return searchOpenVsx(query, typeof size === 'number' ? size : 20);
});

ipcMain.handle('ext:detail', async (_event, extensionId: string) => {
  if (typeof extensionId !== 'string' || !extensionId.trim()) {
    throw new Error('Identificador de extensión requerido.');
  }
  return getOpenVsxDetail(extensionId);
});

ipcMain.handle('ext:list', async () => {
  return listExtensions();
});

ipcMain.handle('ext:uninstall', async (_event, id: string) => {
  if (typeof id !== 'string' || !id) return false;
  return uninstallExtension(id);
});

ipcMain.handle('ext:setEnabled', async (_event, id: string, enabled: boolean) => {
  if (typeof id !== 'string' || !id) return false;
  const changed = setExtensionEnabled(id, enabled !== false);
  // Disabling must reach the host too: its loaded set is fixed per
  // generation, so the change lands as a restart (or a stop, when nothing
  // is left to run).
  if (changed) {
    void syncExtensionHost(`extensión "${id}" ${enabled !== false ? 'habilitada' : 'deshabilitada'}`)
      .catch((err) => console.warn('[forge:ext-host] sync falló:', (err as Error).message));
  }
  return changed;
});

ipcMain.handle('ext:checkUpdates', async () => {
  return checkExtensionUpdates();
});

// Workspace-scope settings and Workspace Trust resolve against the open
// workspace; the facade receives a provider instead of reaching into main's
// state. Remote workspaces are forwarded as-is: trust must be able to tell
// "remote" apart from "no workspace".
configureExtensionWorkspace(() => currentWorkspacePath);

function broadcastExtensionConfigChange(key: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ext:config:changed', { key });
  }
}

onExtensionConfigurationChanged(broadcastExtensionConfigChange);

ipcMain.handle('ext:config:list', async () => {
  return listConfiguration();
});

ipcMain.handle(
  'ext:config:set',
  async (_event, key: string, value: unknown, scope?: string) => {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('Clave de setting requerida.');
    }
    setConfigurationValue(key, value, scope === 'workspace' ? 'workspace' : 'user');
    return true;
  },
);

// ── Workspace Trust ────────────────────────────────────────────────────
// Restricted Mode is the default; every window has to learn about a change
// at once, so decisions broadcast like configuration writes do.
function broadcastWorkspaceTrust(status: ReturnType<typeof getWorkspaceTrustStatus>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ext:trust:changed', status);
  }
}

onWorkspaceTrustChanged((status) => {
  broadcastWorkspaceTrust(status);
  // The set of extensions a generation may load travels in the handshake,
  // so a trust decision only takes effect on a new one — or on stopping the
  // host outright when nothing is activatable any more.
  void syncExtensionHost('cambio de confianza del workspace').catch((err) => {
    console.warn('[forge:ext-host] sync tras trust falló:', (err as Error).message);
  });
});

// ── Extension host ─────────────────────────────────────────────────────
// The renderer never talks to the host directly (design §1.2): it observes
// state through these channels and main stays the only broker.

onExtensionHostEvent((event) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ext:host:event', event);
  }
});

ipcMain.handle('ext:host:state', async () => getExtensionHostState());

ipcMain.handle('ext:host:restart', async () => restartExtensionHost());

ipcMain.handle('ext:host:commands', async () => getExtensionCommandRegistry());

ipcMain.handle('ext:host:activation', async () => getExtensionActivationReport());

// Safe Mode. Entering must work even when the host is wedged, so nothing
// here waits on it: the decision is main's and the host follows.
ipcMain.handle('ext:safe-mode:status', async () => getSafeModeStatus());

ipcMain.handle('ext:safe-mode:set', async (_event, enabled: boolean, reason?: string) => {
  try {
    return { ok: true as const, status: await setSafeMode(Boolean(enabled), reason) };
  } catch (err) {
    if (err instanceof SafeModeError) {
      return { ok: false as const, error: err.message, status: getSafeModeStatus() };
    }
    throw err;
  }
});

onSafeModeChanged((status) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ext:safe-mode:changed', status);
  }
});

// The user answered (or dismissed) an extension's message. `send`, not
// `invoke`: the renderer has nothing to wait for, and the host's promise is
// resolved on this side.
ipcMain.on('ext:host:message:respond', (_event, id: number, selection: string | null) => {
  if (typeof id !== 'number') return;
  resolveExtensionMessage(id, typeof selection === 'string' ? selection : null);
});

// `onLanguage:` is a workbench fact — which language the user is looking at
// — so the renderer reports it and main decides who that wakes up. Fire and
// forget: opening a file must not wait on an extension, nor fail with it.
ipcMain.on('ext:activate:language', (_event, language: string) => {
  if (typeof language !== 'string' || !language) return;
  void fireExtensionActivation({ kind: 'language', language });
});

// Extension commands run in the host, but the renderer is what triggers
// them (palette, keybinding, menu). The error is flattened to a typed body
// so it survives the IPC boundary as data instead of a rejected invoke the
// renderer would only see as a string.
ipcMain.handle('ext:command:execute', async (_event, command: string, args: unknown[] = []) => {
  try {
    const result = await executeExtensionCommand(command, Array.isArray(args) ? args : []);
    return { ok: true as const, result };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : 'ACTIVATION_FAILED';
    return { ok: false as const, error: { code, message: (err as Error).message } };
  }
});

ipcMain.handle('ext:trust:status', async () => {
  return getWorkspaceTrustStatus();
});

ipcMain.handle('ext:trust:grant', async () => {
  return setWorkspaceTrusted(true);
});

ipcMain.handle('ext:trust:revoke', async () => {
  return setWorkspaceTrusted(false);
});

ipcMain.handle('ext:rollback', async (_event, id: string) => {
  if (typeof id !== 'string' || !id) {
    throw new Error('Identificador de extensión requerido.');
  }
  return rollbackExtension(id);
});

ipcMain.handle('ext:setActiveTheme', async (_event, themeId: string | null) => {
  setActiveTheme(typeof themeId === 'string' && themeId ? themeId : null);
  return true;
});

ipcMain.handle('ext:setActiveIconTheme', async (_event, iconThemeId: string | null) => {
  setActiveIconTheme(typeof iconThemeId === 'string' && iconThemeId ? iconThemeId : null);
  return true;
});

// ── Forge per-project metadata (.forge/) ─────────────────────────────────
//
// Each project gets a `.forge/` folder where the agent stores its
// conversation history (history.json). The folder is created by /init.
//
// readHistory  → returns the parsed array, or `null` if the file doesn't
//                exist. Returns an empty array if the file exists but is
//                empty/invalid.
// writeHistory → atomically writes the messages array to disk. Creates the
//                `.forge/` directory if needed.
// ensureForge  → creates `.forge/` and an empty history.json if absent.

function getForgeHistoryPath(workspacePath: string): string {
  return path.join(workspacePath, '.forge', 'history.json');
}

ipcMain.handle('forge:readHistory', async (_event, workspacePath: string) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return null;
  const histPath = getForgeHistoryPath(workspacePath);
  try {
    if (!fs.existsSync(histPath)) return null;
    const text = fs.readFileSync(histPath, 'utf-8');
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
    return [];
  } catch (err) {
    console.warn('[forge] readHistory failed:', (err as Error).message);
    return [];
  }
});

ipcMain.handle(
  'forge:writeHistory',
  async (_event, workspacePath: string, messages: unknown) => {
    if (typeof workspacePath !== 'string' || !workspacePath) return false;
    if (!Array.isArray(messages)) return false;
    const dir = path.join(workspacePath, '.forge');
    const histPath = getForgeHistoryPath(workspacePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write through a tmp file to avoid leaving a half-written history
      // when the app is killed mid-write.
      const tmp = histPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf-8');
      fs.renameSync(tmp, histPath);
      return true;
    } catch (err) {
      console.warn('[forge] writeHistory failed:', (err as Error).message);
      return false;
    }
  },
);

ipcMain.handle('forge:ensureForgeDir', async (_event, workspacePath: string) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return false;
  const dir = path.join(workspacePath, '.forge');
  const histPath = getForgeHistoryPath(workspacePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(histPath)) {
      fs.writeFileSync(histPath, '[]', 'utf-8');
    }
    return true;
  } catch (err) {
    console.warn('[forge] ensureForgeDir failed:', (err as Error).message);
    return false;
  }
});

ipcMain.handle('forge:hasHistory', async (_event, workspacePath: string) => {
  if (typeof workspacePath !== 'string' || !workspacePath) return false;
  try {
    return fs.existsSync(getForgeHistoryPath(workspacePath));
  } catch {
    return false;
  }
});

// ── App Lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    await claudeIdeServer.start();
  } catch (err) {
    console.warn('[forge:claude] IDE server unavailable:', (err as Error).message);
  }
  // No install is in flight yet: safe moment to drop abandoned staging and
  // orphan directories a post-commit failure could have left in the store.
  sweepExtensionStore();
  // Non-blocking on purpose: a host that will not come up must not delay or
  // prevent the window. It reports its state through `ext:host:event`.
  void startExtensionHost().then(() => {
    // Both triggers fire after the window exists, which is what
    // `onStartupFinished` means: not "as early as possible" but "once the
    // user has a workbench to see the result in".
    void fireExtensionActivation({ kind: 'startupFinished' });
    void fireWorkspaceContainsActivation();
  });
  createWindow();
});

app.on('window-all-closed', () => {
  // Clean up running terminals & file system watcher
  terminals.forEach((p) => { try { p.kill(); } catch { /* noop */ } });
  terminals.clear();
  closeWorkspaceWatcher();
  // Best-effort: shut down the language server.
  void lspManager.stop().catch(() => undefined);
  // Stop the live server — important: it runs in-process so without this
  // an EADDRINUSE leak could survive the next start. (window-all-closed
  // fires before quit on every platform; we await synchronously enough.)
  void stopLiveServer().catch(() => undefined);
  // The utilityProcess dies with the app anyway; stopping it explicitly is
  // what gives loaded extensions their deactivate() (design §5).
  void stopExtensionHost().catch(() => undefined);
  claudeIdeServer.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Final safety net: if the app quits without going through window-all-closed
// (e.g. force-quit on macOS), still try to stop the live server.
app.on('before-quit', () => {
  void stopLiveServer().catch(() => undefined);
  claudeIdeServer.dispose();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
