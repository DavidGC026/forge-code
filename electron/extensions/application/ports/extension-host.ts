import type {
  ExtensionHostDescriptor,
  RpcEnvelope,
  RpcErrorCode,
  RpcLogEntry,
} from '../../domain/rpc-protocol';

export type { ExtensionHostDescriptor };

/**
 * What the use cases need from an Extension Host, and nothing else. Both the
 * `utilityProcess` adapter and an in-process double implement it, so the
 * contract battery runs against either (design §9) and a future remote host
 * inherits it (architecture §16).
 */

export type ExtensionHostStatus =
  /** Never started, or stopped on request. */
  | 'stopped'
  /** Process spawned, handshake in flight. */
  | 'starting'
  /** Handshake completed; requests are accepted. */
  | 'running'
  /** Crashed or unresponsive; a new generation is scheduled. */
  | 'restarting'
  /** Crash loop breaker tripped: nothing restarts without explicit intent. */
  | 'disabled';

/** Observable snapshot; every transition is published through `onEvent`. */
export interface ExtensionHostState {
  status: ExtensionHostStatus;
  /** Current host generation. Increments on every spawn (design §1.3). */
  generation: number;
  /** Restarts inside the crash-loop window, for the breaker and the UI. */
  restartsInWindow: number;
  /** Why the last generation ended; null after a clean start. */
  lastError: { code: RpcErrorCode; message: string } | null;
}

/** Handshake body sent as `lifecycle.initialize` (design §3.2). */
export interface ExtensionHostInitializePayload {
  protocol: number;
  /** VS Code API version Forge emulates. */
  apiVersion: string;
  /** Everything this generation is allowed to load. An extension missing
   *  from the list cannot be activated at all — that is the trust boundary. */
  extensions: ExtensionHostDescriptor[];
  workspace: string | null;
  trust: boolean;
  /** Effective settings, flattened by key. Sent whole because
   *  `workspace.getConfiguration(...).get()` is synchronous host-side. */
  configuration: Record<string, unknown>;
  /** Buffers already open when this generation starts. State, not events. */
  documents: {
    uri: string;
    languageId: string;
    version: number;
    content: string;
    isDirty: boolean;
  }[];
}

/** What the host answers to the handshake. */
export interface ExtensionHostHandshake {
  protocol: number;
  nodeVersion: string;
  ready: boolean;
  /** Descriptors the host accepted; a rejected one never appears here. */
  loadable?: string[];
}

/** Result of `lifecycle.activate` for one extension. */
export interface ExtensionActivationReport {
  id: string;
  status: 'inactive' | 'activating' | 'active' | 'failed';
  durationMs: number;
  exports: string[];
}

export type ExtensionHostEvent =
  | { type: 'state'; state: ExtensionHostState }
  /** Aggregated `diagnostics.log` batch (design §3.4). */
  | { type: 'logs'; generation: number; entries: RpcLogEntry[] }
  /** Host-originated notification other than logs. */
  | { type: 'notification'; generation: number; envelope: RpcEnvelope }
  /** A request expired; its extension is to be marked unresponsive. */
  | { type: 'request-timeout'; generation: number; method: string; extensionId: string | null }
  /** A message was thrown away instead of routed; carries the reason. */
  | { type: 'dropped'; generation: number; reason: string; method: string };

export interface ExtensionHostRequestOptions {
  extensionId?: string;
  /** Overrides the family timeout for this single call. */
  timeoutMs?: number;
}

export interface ExtensionHost {
  readonly state: ExtensionHostState;
  /** Spawns and completes the handshake. Idempotent while running. */
  start(): Promise<ExtensionHostState>;
  /** Stops without scheduling a restart. Safe to call when stopped. */
  stop(reason?: string): Promise<void>;
  /** Explicit restart: clears the crash-loop breaker before starting. */
  restart(reason?: string): Promise<ExtensionHostState>;
  /** Sends a request and resolves its payload. Rejects with `RpcError`. */
  request(
    method: string,
    payload?: unknown,
    options?: ExtensionHostRequestOptions,
  ): Promise<unknown>;
  /** Subscribes to state and host-originated traffic. Returns the unsubscribe. */
  onEvent(listener: (event: ExtensionHostEvent) => void): () => void;
}
