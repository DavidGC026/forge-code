// ─────────────────────────────────────────────────────────────────────────
// LSP Manager — spawns typescript-language-server, speaks JSON-RPC over
// stdio (Content-Length framed), and bridges requests/notifications
// between the Electron renderer (via IPC) and the language server.
//
// Lifecycle
//   - start(workspacePath)  → spawns `typescript-language-server --stdio`
//                              with cwd = workspacePath, sends `initialize`
//                              + `initialized`. Subsequent calls switch
//                              workspaces (kills + respawns).
//   - request(method, params) → JSON-RPC request, resolves with response.
//   - notification(method, params) → fire-and-forget JSON-RPC notification.
//   - stop() → graceful shutdown/exit, then kill.
//
// Renderer IPC channels (handled from main.ts):
//   lsp:start, lsp:stop, lsp:request, lsp:notification
//
// Renderer-bound events:
//   lsp:notification → forwarded from server (publishDiagnostics, etc.)
// ─────────────────────────────────────────────────────────────────────────
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// ── JSON-RPC message types ─────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}
type AnyJsonRpc = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// Resolve the path to typescript-language-server's CLI entry. We resolve
// the package's `package.json` (CJS can read JSON) and derive the bin
// path from there. This works even with pnpm's symlink layout.
function resolveLspCliPath(): string | null {
  try {
    const pkgPath = require.resolve('typescript-language-server/package.json');
    const pkgDir = path.dirname(pkgPath);
    const candidate = path.join(pkgDir, 'lib', 'cli.mjs');
    if (fs.existsSync(candidate)) return candidate;
    // Fallback: read bin from package.json
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['typescript-language-server'];
    if (binRel) {
      const p = path.join(pkgDir, binRel);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* not installed */
  }
  return null;
}

// Resolve the path to the typescript package (lib/), used so the LSP picks
// up a known-good TS version regardless of what's in the user's workspace.
function resolveTypeScriptLibPath(): string | null {
  try {
    const tsPkgPath = require.resolve('typescript/package.json');
    const tsDir = path.dirname(tsPkgPath);
    const libDir = path.join(tsDir, 'lib');
    if (fs.existsSync(libDir)) return libDir;
  } catch {
    /* noop */
  }
  return null;
}

// Convert an absolute filesystem path to a file:// URI. Handles Windows
// drive letters and backslashes correctly.
export function pathToFileUri(p: string): string {
  if (!p) return '';
  let s = p.replace(/\\/g, '/');
  // Windows absolute path: prepend a leading slash so URI is file:///C:/...
  if (/^[a-zA-Z]:\//.test(s)) {
    s = '/' + s;
  }
  // Encode each segment so spaces / unicode are preserved.
  return 'file://' + s
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/g, ':'))
    .join('/');
}

export class LspManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private workspacePath: string | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void; method: string }
  >();
  private window: BrowserWindow | null = null;
  // While we're shutting down, drop incoming responses/notifications.
  private stopping = false;

  setWindow(win: BrowserWindow | null) {
    this.window = win;
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /** Start (or restart) the language server for the given workspace. */
  async start(workspacePath: string): Promise<void> {
    if (!workspacePath || typeof workspacePath !== 'string') {
      throw new Error('LSP start: workspacePath is required');
    }

    // Already running for this workspace? Nothing to do.
    if (this.isRunning() && this.workspacePath === workspacePath) {
      return;
    }

    // Stop any existing instance first.
    if (this.isRunning()) {
      await this.stop().catch(() => undefined);
    }

    const cliPath = resolveLspCliPath();
    if (!cliPath) {
      console.warn(
        '[forge:lsp] typescript-language-server is not installed; LSP features disabled.'
      );
      return;
    }

    // typescript-language-server v5 no longer accepts --tsserver-path. The
    // bundled TS path is instead passed in via initializationOptions.
    // Resolve our own typescript install so the server doesn't have to hunt
    // for one in the user's workspace.
    const tsLib = resolveTypeScriptLibPath();
    const args: string[] = [cliPath, '--stdio'];

    this.workspacePath = workspacePath;
    this.buffer = Buffer.alloc(0);
    this.pending.clear();
    this.nextId = 1;
    this.stopping = false;

    try {
      this.child = spawn(process.execPath, args, {
        cwd: workspacePath,
        env: {
          ...process.env,
          // Make sure the LSP doesn't get confused by Electron-specific vars.
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error('[forge:lsp] failed to spawn language server:', (err as Error).message);
      this.child = null;
      this.workspacePath = null;
      return;
    }

    this.child.on('error', (err) => {
      console.error('[forge:lsp] child error:', err.message);
    });
    this.child.on('exit', (code, signal) => {
      if (!this.stopping) {
        console.warn(
          `[forge:lsp] language server exited unexpectedly (code=${code}, signal=${signal})`
        );
      }
      this.cleanupAfterExit();
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) console.debug('[forge:lsp:stderr]', text);
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));

    // Send initialize.
    const rootUri = pathToFileUri(workspacePath);
    try {
      const initResult = await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Forge Code', version: '1.0.0' },
        rootUri,
        rootPath: workspacePath,
        workspaceFolders: [{ uri: rootUri, name: path.basename(workspacePath) || 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            completion: {
              dynamicRegistration: false,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: false,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: true,
                preselectSupport: true,
                insertReplaceSupport: true,
                resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
              },
              contextSupport: true,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            signatureHelp: {
              dynamicRegistration: false,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            definition: { dynamicRegistration: false, linkSupport: false },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: { relatedInformation: true, versionSupport: false },
          },
          workspace: {
            applyEdit: false,
            workspaceFolders: true,
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: false },
            didChangeWatchedFiles: { dynamicRegistration: false },
          },
        },
        initializationOptions: {
          // Point typescript-language-server at our own bundled tsserver so
          // we don't depend on the user's workspace having `typescript`
          // installed. Falls through silently if we couldn't resolve it.
          ...(tsLib
            ? {
                tsserver: {
                  // typescript-language-server expects the path to the
                  // directory containing tsserver.js (i.e. typescript/lib).
                  path: tsLib,
                },
              }
            : {}),
          // Reasonable defaults; users may override later via didChangeConfiguration.
          preferences: {
            includeCompletionsForModuleExports: true,
            includeCompletionsWithInsertText: true,
            allowIncompleteCompletions: true,
            importModuleSpecifierPreference: 'shortest',
            quotePreference: 'auto',
          },
        },
      });
      // Acknowledge.
      this.notification('initialized', {});
      console.log('[forge:lsp] initialized', initResult?.serverInfo || '(no serverInfo)');
    } catch (err) {
      console.error('[forge:lsp] initialize failed:', (err as Error).message);
      // Tear down on a failed handshake.
      await this.stop().catch(() => undefined);
    }
  }

  /** Send a JSON-RPC request and wait for the response. */
  request(method: string, params: any): Promise<any> {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('LSP not running'));
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.writeMessage(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notification(method: string, params: any): void {
    if (!this.child || this.child.killed) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    try {
      this.writeMessage(msg);
    } catch (err) {
      console.debug('[forge:lsp] failed to send notification', method, (err as Error).message);
    }
  }

  /** Gracefully shut down the language server. */
  async stop(): Promise<void> {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;

    // Best-effort graceful shutdown.
    try {
      await Promise.race([
        this.request('shutdown', null),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    } catch {
      /* noop */
    }
    try {
      this.notification('exit', null);
    } catch {
      /* noop */
    }

    // Give it a moment to exit cleanly, then SIGTERM as last resort.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGTERM');
        } catch {
          /* noop */
        }
        resolve();
      }, 500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });

    this.cleanupAfterExit();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private cleanupAfterExit() {
    // Reject any in-flight requests.
    for (const { reject, method } of this.pending.values()) {
      try {
        reject(new Error(`LSP exited before responding to ${method}`));
      } catch {
        /* noop */
      }
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child = null;
    this.workspacePath = null;
    this.stopping = false;
  }

  private writeMessage(msg: AnyJsonRpc): void {
    if (!this.child || !this.child.stdin.writable) return;
    const json = JSON.stringify(msg);
    const body = Buffer.from(json, 'utf-8');
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    this.child.stdin.write(header);
    this.child.stdin.write(body);
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Parse as many complete LSP messages as we can from the buffer.
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // need more data

      const headerText = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Malformed; drop everything up to and including the header boundary
        // to try to recover.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return; // partial body; wait

      const body = this.buffer.slice(messageStart, messageEnd).toString('utf-8');
      this.buffer = this.buffer.slice(messageEnd);

      let parsed: AnyJsonRpc | null = null;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        console.warn('[forge:lsp] failed to parse message:', (err as Error).message);
      }
      if (parsed) this.dispatch(parsed);
    }
  }

  private dispatch(msg: AnyJsonRpc): void {
    if (this.stopping) return;

    // Response to one of our requests.
    if ('id' in msg && (msg as JsonRpcResponse).id !== undefined && !(msg as any).method) {
      const resp = msg as JsonRpcResponse;
      const id = typeof resp.id === 'number' ? resp.id : Number(resp.id);
      const handler = this.pending.get(id);
      if (handler) {
        this.pending.delete(id);
        if (resp.error) handler.reject(new Error(resp.error.message || 'LSP error'));
        else handler.resolve(resp.result);
      }
      return;
    }

    // Server → client request. We don't currently handle these except to
    // reply with a benign default to a couple of well-known methods so we
    // don't leave the server waiting.
    if ('id' in msg && (msg as any).method) {
      const req = msg as JsonRpcRequest;
      let result: any = null;
      // Respond to workspace/configuration with empty configs for each item.
      if (req.method === 'workspace/configuration' && Array.isArray(req.params?.items)) {
        result = req.params.items.map(() => ({}));
      }
      // window/workDoneProgress/create → acknowledge.
      const resp: JsonRpcResponse = { jsonrpc: '2.0', id: req.id, result };
      try {
        this.writeMessage(resp);
      } catch {
        /* noop */
      }
      return;
    }

    // Pure notification from server → renderer.
    const note = msg as JsonRpcNotification;
    if (this.window && !this.window.isDestroyed()) {
      try {
        this.window.webContents.send('lsp:notification', {
          method: note.method,
          params: note.params,
        });
      } catch {
        /* noop */
      }
    }
  }
}
