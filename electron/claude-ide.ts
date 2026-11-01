import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
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

type RendererCommand = (command: string, args: any) => Promise<any>;

const MCP_PROTOCOL_VERSION = '2025-03-26';
const MIN_PORT = 10000;
const MAX_PORT = 65535;

function isLocalAddress(address: string | undefined): boolean {
  return (
    !address ||
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function mcpText(text: string) {
  return { content: [{ type: 'text', text }] };
}

function fileUri(filePath: string): string {
  try {
    return pathToFileURL(filePath).toString();
  } catch {
    return `file://${filePath}`;
  }
}

function basename(filePath: string): string {
  return path.basename(filePath) || filePath;
}

function makeTool(
  name: string,
  description: string,
  properties: Record<string, any> = {},
  required: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: true,
    },
  };
}

const TOOLS = [
  makeTool('getCurrentSelection', 'Get the current text selection in the active Forge Code editor.'),
  makeTool('getLatestSelection', 'Get the most recent text selection in Forge Code.'),
  makeTool('getOpenEditors', 'Get information about currently open Forge Code editor tabs.'),
  makeTool('getWorkspaceFolders', 'Get the currently opened Forge Code workspace folder.'),
  makeTool(
    'openFile',
    'Open a file in Forge Code and optionally select a text range.',
    {
      filePath: { type: 'string' },
      preview: { type: 'boolean' },
      startText: { type: 'string' },
      endText: { type: 'string' },
      selectToEndOfLine: { type: 'boolean' },
      makeFrontmost: { type: 'boolean' },
    },
    ['filePath'],
  ),
  makeTool(
    'checkDocumentDirty',
    'Check whether an open Forge Code document has unsaved changes.',
    { filePath: { type: 'string' } },
    ['filePath'],
  ),
  makeTool(
    'saveDocument',
    'Save an open Forge Code document.',
    { filePath: { type: 'string' } },
    ['filePath'],
  ),
  makeTool(
    'close_tab',
    'Close a Forge Code tab by label or file name.',
    { tab_name: { type: 'string' } },
    ['tab_name'],
  ),
  makeTool('getDiagnostics', 'Get diagnostics known to Forge Code. Currently returns an empty list.'),
  makeTool('closeAllDiffTabs', 'Close all diff tabs. Forge Code does not create Claude diff tabs yet.'),
  makeTool('openDiff', 'Open a blocking diff view. Not implemented in Forge Code yet.'),
];

class MiniWebSocketConnection {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void,
  ) {
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.close(false));
    socket.on('error', () => this.close(false));
  }

  sendJson(value: unknown): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  close(writeCloseFrame = true): void {
    if (this.closed) return;
    this.closed = true;
    if (writeCloseFrame) {
      try {
        this.sendFrame(0x8, Buffer.alloc(0));
      } catch {
        /* noop */
      }
    }
    try {
      this.socket.destroy();
    } catch {
      /* noop */
    }
    this.onClose();
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const longLength = this.buffer.readBigUInt64BE(offset);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close();
          return;
        }
        length = Number(longLength);
        offset += 8;
      }

      let mask: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);

      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      if (opcode === 0x1) {
        this.onText(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.close(false);
        return;
      } else if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
      }
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return;

    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    this.socket.write(Buffer.concat([header, payload]));
  }
}

export class ClaudeIdeServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<MiniWebSocketConnection>();
  private authToken = '';
  private port: number | null = null;
  private lockPath: string | null = null;
  private editorState: ClaudeIdeEditorState = {
    workspacePath: null,
    workspaceName: null,
    openEditors: [],
  };
  private currentSelection: ClaudeIdeSelection | null = null;
  private latestSelection: ClaudeIdeSelection | null = null;

  constructor(private readonly runRendererCommand: RendererCommand) {}

  async start(): Promise<void> {
    if (this.server && this.port != null) return;

    this.authToken = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));

    const candidates = new Set<number>();
    while (candidates.size < 48) {
      candidates.add(crypto.randomInt(MIN_PORT, MAX_PORT + 1));
    }

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(candidate, '127.0.0.1');
        });
        this.server = server;
        this.port = candidate;
        this.writeLockFile();
        console.log(`[forge:claude] IDE server listening on 127.0.0.1:${candidate}`);
        return;
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw lastError || new Error('No free port found for Claude IDE server.');
  }

  dispose(): void {
    for (const client of Array.from(this.clients)) {
      client.close();
    }
    this.clients.clear();

    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* noop */
      }
      this.server = null;
    }

    if (this.lockPath) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        /* noop */
      }
      this.lockPath = null;
    }
    this.port = null;
  }

  getTerminalEnv(): Record<string, string> {
    if (this.port == null) return {};
    return {
      CLAUDE_CODE_SSE_PORT: String(this.port),
      ENABLE_IDE_INTEGRATION: 'true',
    };
  }

  updateEditorState(next: Partial<ClaudeIdeEditorState>): void {
    this.editorState = { ...this.editorState, ...next };
    this.writeLockFile();
  }

  updateSelection(selection: ClaudeIdeSelection | null): void {
    this.currentSelection = selection;
    if (selection && !selection.selection.isEmpty) {
      this.latestSelection = selection;
    }
    if (selection) {
      this.broadcast({
        jsonrpc: '2.0',
        method: 'selection_changed',
        params: selection,
      });
    }
  }

  private handleUpgrade(req: http.IncomingMessage, socketLike: net.Socket | NodeJS.ReadWriteStream): void {
    const socket = socketLike as net.Socket;
    if (!isLocalAddress(socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const providedToken = req.headers['x-claude-code-ide-authorization'];
    if (providedToken !== this.authToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    let client: MiniWebSocketConnection;
    client = new MiniWebSocketConnection(
      socket,
      (text) => void this.handleText(client, text),
      () => this.clients.delete(client),
    );
    this.clients.add(client);
  }

  private async handleText(client: MiniWebSocketConnection, text: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return;
    }

    try {
      const result = await this.handleRequest(message.method, message.params);
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        client.sendJson({ jsonrpc: '2.0', id: message.id, result });
      }
    } catch (err) {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        client.sendJson({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: (err as Error).message || String(err),
          },
        });
      }
    }
  }

  private async handleRequest(method: string, params: any): Promise<any> {
    if (method === 'initialize') {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'Forge Code', version: '1.0.0' },
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS };
    if (method === 'tools/call') {
      return this.callTool(params?.name, params?.arguments || {});
    }
    if (method === 'resources/list') return { resources: [] };
    if (method === 'prompts/list') return { prompts: [] };
    if (method === 'notifications/initialized') return {};
    throw new Error(`Unsupported Claude IDE method: ${method}`);
  }

  private async callTool(name: string, args: any): Promise<any> {
    if (name === 'getCurrentSelection') {
      return mcpText(jsonText(this.selectionPayload(this.currentSelection)));
    }
    if (name === 'getLatestSelection') {
      return mcpText(jsonText(this.selectionPayload(this.latestSelection)));
    }
    if (name === 'getOpenEditors') {
      return mcpText(jsonText({ tabs: this.editorState.openEditors }));
    }
    if (name === 'getWorkspaceFolders') {
      return mcpText(jsonText(this.workspacePayload()));
    }
    if (name === 'getDiagnostics') {
      return mcpText('[]');
    }
    if (name === 'checkDocumentDirty') {
      const filePath = String(args?.filePath || '');
      const tab = this.findOpenEditor(filePath);
      if (!tab) {
        return mcpText(jsonText({ success: false, message: `Document not open: ${filePath}` }));
      }
      return mcpText(jsonText({
        success: true,
        filePath: tab.filePath,
        isDirty: tab.isDirty,
        isUntitled: false,
      }));
    }
    if (name === 'saveDocument') {
      const filePath = String(args?.filePath || '');
      const saved = await this.runRendererCommand('saveDocument', { filePath });
      return mcpText(jsonText({
        success: Boolean(saved?.success),
        filePath,
        saved: Boolean(saved?.saved),
        message: saved?.message || (saved?.success ? 'Document saved successfully' : 'Document not open'),
      }));
    }
    if (name === 'openFile') {
      const filePath = String(args?.filePath || '');
      if (!filePath) throw new Error('openFile requires filePath');
      const opened = await this.runRendererCommand('openFile', args);
      if (!opened?.success) {
        return mcpText(jsonText({
          success: false,
          filePath,
          message: opened?.message || `Could not open file: ${filePath}`,
        }));
      }
      if (args?.makeFrontmost === false) {
        return mcpText(jsonText(opened));
      }
      return mcpText(`Opened file: ${opened.filePath || filePath}`);
    }
    if (name === 'close_tab') {
      const result = await this.runRendererCommand('closeTab', {
        tabName: String(args?.tab_name || ''),
      });
      return mcpText(result?.closed ? 'TAB_CLOSED' : 'TAB_NOT_FOUND');
    }
    if (name === 'closeAllDiffTabs') {
      return mcpText('CLOSED_0_DIFF_TABS');
    }
    if (name === 'openDiff') {
      return mcpText('DIFF_NOT_SUPPORTED');
    }

    throw new Error(`Unsupported Claude IDE tool: ${name}`);
  }

  private selectionPayload(selection: ClaudeIdeSelection | null): any {
    if (!selection) {
      return { success: false, message: 'No selection available' };
    }
    return { success: true, ...selection };
  }

  private workspacePayload(): any {
    const workspacePath = this.editorState.workspacePath;
    if (!workspacePath) {
      return { success: false, folders: [], rootPath: null };
    }
    return {
      success: true,
      folders: [{
        name: this.editorState.workspaceName || basename(workspacePath),
        uri: fileUri(workspacePath),
        path: workspacePath,
      }],
      rootPath: workspacePath,
    };
  }

  private findOpenEditor(filePathOrUri: string): ClaudeIdeOpenEditor | undefined {
    return this.editorState.openEditors.find((tab) => (
      tab.filePath === filePathOrUri ||
      tab.uri === filePathOrUri ||
      tab.label === filePathOrUri ||
      path.basename(tab.filePath) === filePathOrUri
    ));
  }

  private broadcast(value: unknown): void {
    for (const client of Array.from(this.clients)) {
      try {
        client.sendJson(value);
      } catch {
        client.close();
      }
    }
  }

  private writeLockFile(): void {
    if (this.port == null || !this.authToken) return;
    try {
      const dir = path.join(os.homedir(), '.claude', 'ide');
      fs.mkdirSync(dir, { recursive: true });
      const lockPath = path.join(dir, `${this.port}.lock`);
      const workspaceFolders = this.editorState.workspacePath
        ? [this.editorState.workspacePath]
        : [];
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          workspaceFolders,
          ideName: 'Forge Code',
          transport: 'ws',
          authToken: this.authToken,
        }, null, 2),
        'utf-8',
      );
      this.lockPath = lockPath;
    } catch (err) {
      console.warn('[forge:claude] failed to write lock file:', (err as Error).message);
    }
  }
}
