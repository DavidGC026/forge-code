import { RPC_PROTOCOL_VERSION, RpcError } from '../../domain/rpc-protocol';
import { RpcBroker, systemTimers } from './rpc-broker';
import type { RpcBrokerEvent, RpcRequestHandler, RpcTimers, RpcTransport } from './rpc-broker';
import type {
  ExtensionHost,
  ExtensionHostEvent,
  ExtensionHostInitializePayload,
  ExtensionHostRequestOptions,
  ExtensionHostState,
} from '../../application/ports/extension-host';

/** Message that hands the host its end of the channel and its generation. */
export const HOST_PORT_MESSAGE = 'forge:extension-host-port';

/** A spawned host process, reduced to what the lifecycle policy needs. */
export interface HostProcessHandle {
  transport: RpcTransport;
  kill(): void;
  /** Subscribes to process death. Returns the unsubscribe. */
  onExit(listener: (code: number | null) => void): () => void;
}

/**
 * Spawns a host process. The real one forks an Electron `utilityProcess`;
 * tests pass a fake, which is why every Electron symbol is confined to
 * `createUtilityProcessLauncher`.
 */
export interface HostProcessLauncher {
  spawn(generation: number): HostProcessHandle;
}

export interface UtilityProcessHostOptions {
  launcher: HostProcessLauncher;
  timers?: RpcTimers;
  /** Handshake body, rebuilt per generation so it reflects current state. */
  initialize?: () => Omit<ExtensionHostInitializePayload, 'protocol'>;
  /** Host → main requests. Without one, every method answers UNSUPPORTED_API. */
  onRequest?: RpcRequestHandler;
  heartbeatIntervalMs?: number;
  heartbeatFailureThreshold?: number;
  /** Crash-loop window and budget for the circuit breaker (design §6). */
  restartWindowMs?: number;
  maxRestartsInWindow?: number;
  backoffMs?: (attempt: number) => number;
  /** Timeout for the handshake; defaults to the `lifecycle` family budget. */
  handshakeTimeoutMs?: number;
  warn?: (message: string) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_FAILURES = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_MAX_RESTARTS = 3;

function defaultBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * Supervises the `utilityProcess` generation by generation: handshake,
 * heartbeat, restart with backoff and crash-loop breaker. Every temporal
 * dependency is injected (`timers`), so the whole policy is testable without
 * waiting and without Electron.
 */
export class UtilityProcessExtensionHost implements ExtensionHost {
  private readonly options: UtilityProcessHostOptions;
  private readonly timers: RpcTimers;
  private readonly warn: (message: string) => void;
  private readonly listeners = new Set<(event: ExtensionHostEvent) => void>();

  private current: ExtensionHostState = {
    status: 'stopped',
    generation: 0,
    restartsInWindow: 0,
    lastError: null,
  };

  private handle: HostProcessHandle | null = null;
  private detachExit: (() => void) | null = null;
  private broker: RpcBroker | null = null;
  private heartbeatTimer: unknown = null;
  private restartTimer: unknown = null;
  private heartbeatFailures = 0;
  private restartTimestamps: number[] = [];
  private startInFlight: Promise<ExtensionHostState> | null = null;
  /** True while a stop/restart we asked for is in progress. */
  private intentional = false;

  constructor(options: UtilityProcessHostOptions) {
    this.options = options;
    this.timers = options.timers ?? systemTimers;
    this.warn = options.warn ?? ((message) => console.warn('[forge:ext-host]', message));
  }

  get state(): ExtensionHostState {
    return { ...this.current, lastError: this.current.lastError && { ...this.current.lastError } };
  }

  onEvent(listener: (event: ExtensionHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): Promise<ExtensionHostState> {
    if (this.current.status === 'disabled') {
      return Promise.reject(new RpcError(
        'HOST_UNAVAILABLE',
        'El Extension Host está deshabilitado tras un crash loop; reinícialo a mano.',
      ));
    }
    if (this.current.status === 'running') return Promise.resolve(this.state);
    if (this.startInFlight) return this.startInFlight;

    const attempt = this.spawnGeneration().finally(() => {
      if (this.startInFlight === attempt) this.startInFlight = null;
    });
    this.startInFlight = attempt;
    return attempt;
  }

  async stop(reason = 'Detenido por Forge.'): Promise<void> {
    this.intentional = true;
    this.clearRestartTimer();
    this.clearHeartbeat();

    if (this.current.status === 'running' && this.broker) {
      // Best effort: a host that ignores `shutdown` is killed anyway.
      try {
        await this.broker.request('lifecycle.shutdown', { reason });
      } catch (err) {
        this.warn(`shutdown no confirmado: ${describe(err)}`);
      }
    }
    this.teardownCurrent();
    this.setState({ status: 'stopped' });
  }

  /**
   * Explicit restart. Unlike the automatic one it clears the crash-loop
   * budget: a human (or a command) asking for it is new intent, not another
   * symptom of the loop that tripped the breaker.
   */
  async restart(reason = 'Reinicio solicitado.'): Promise<ExtensionHostState> {
    this.restartTimestamps = [];
    if (this.current.status === 'disabled') {
      this.setState({ status: 'stopped', restartsInWindow: 0 });
    }
    await this.stop(reason);
    return this.start();
  }

  request(
    method: string,
    payload?: unknown,
    options?: ExtensionHostRequestOptions,
  ): Promise<unknown> {
    if (this.current.status !== 'running' || !this.broker) {
      return Promise.reject(new RpcError(
        'HOST_UNAVAILABLE',
        `El Extension Host no está corriendo (estado: ${this.current.status}).`,
      ));
    }
    return this.broker.request(method, payload, options);
  }

  // ── Generation lifecycle ──────────────────────────────────────────────

  private async spawnGeneration(): Promise<ExtensionHostState> {
    this.intentional = false;
    this.clearRestartTimer();
    this.teardownCurrent();

    const generation = this.current.generation + 1;
    this.setState({ status: 'starting', generation, lastError: null });

    try {
      const handle = this.options.launcher.spawn(generation);
      this.handle = handle;
      this.detachExit = handle.onExit((code) => this.handleExit(generation, code));
      this.broker = new RpcBroker({
        transport: handle.transport,
        generation,
        timers: this.timers,
        onRequest: this.options.onRequest,
        onEvent: (event) => this.forward(generation, event),
        warn: this.warn,
      });

      const handshake = await this.broker.request(
        'lifecycle.initialize',
        { protocol: RPC_PROTOCOL_VERSION, ...this.handshakePayload() },
        this.options.handshakeTimeoutMs
          ? { timeoutMs: this.options.handshakeTimeoutMs }
          : undefined,
      );
      assertHandshake(handshake);

      if (generation !== this.current.generation) {
        // The process died while the handshake was in flight; the exit path
        // already owns the outcome.
        throw new RpcError('HOST_UNAVAILABLE', 'El host murió durante el handshake.');
      }
      this.heartbeatFailures = 0;
      this.setState({ status: 'running', lastError: null });
      this.scheduleHeartbeat();
      return this.state;
    } catch (err) {
      const error = err instanceof RpcError
        ? err
        : new RpcError('HOST_UNAVAILABLE', describe(err));
      // A handshake failure is deterministic (bad entrypoint, protocol
      // mismatch): it stops instead of looping. Only `starting` is overridden
      // so a crash already routed to the restart path keeps its state.
      if (this.current.status === 'starting') {
        this.teardownCurrent();
        this.setState({ status: 'stopped', lastError: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }

  private handshakePayload(): Omit<ExtensionHostInitializePayload, 'protocol'> {
    return this.options.initialize?.() ?? {
      apiVersion: '1.0.0',
      extensions: [],
      workspace: null,
      trust: false,
      configuration: {},
      documents: [],
      editors: { editors: [], activeUri: null },
    };
  }

  private handleExit(generation: number, code: number | null): void {
    if (generation !== this.current.generation) return;
    this.teardownCurrent();
    if (this.intentional) return;
    if (this.current.status === 'stopped' || this.current.status === 'disabled') return;
    this.scheduleRestart(new RpcError(
      'HOST_UNAVAILABLE',
      `El Extension Host terminó (código ${code === null ? 'desconocido' : code}).`,
    ));
  }

  /**
   * Crash-loop breaker: the budget counts restarts already performed inside
   * the window, so the crash that follows the last allowed restart disables
   * the host instead of spawning generation after generation.
   */
  private scheduleRestart(error: RpcError): void {
    const now = this.timers.now();
    const windowMs = this.options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    const budget = this.options.maxRestartsInWindow ?? DEFAULT_MAX_RESTARTS;
    this.restartTimestamps = this.restartTimestamps.filter((at) => now - at < windowMs);

    if (this.restartTimestamps.length >= budget) {
      this.setState({
        status: 'disabled',
        restartsInWindow: this.restartTimestamps.length,
        lastError: {
          code: 'HOST_UNAVAILABLE',
          message: `Extension Host deshabilitado: ${this.restartTimestamps.length} reinicios en ${Math.round(windowMs / 1_000)} s.`,
        },
      });
      return;
    }

    this.restartTimestamps.push(now);
    const attempt = this.restartTimestamps.length - 1;
    this.setState({
      status: 'restarting',
      restartsInWindow: this.restartTimestamps.length,
      lastError: { code: error.code, message: error.message },
    });

    const delay = (this.options.backoffMs ?? defaultBackoffMs)(attempt);
    this.restartTimer = this.timers.setTimer(() => {
      this.restartTimer = null;
      this.start().catch((err) => this.warn(`reinicio fallido: ${describe(err)}`));
    }, delay);
  }

  // ── Heartbeat (design §6) ─────────────────────────────────────────────

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = this.timers.setTimer(() => {
      this.heartbeatTimer = null;
      void this.beat();
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  private async beat(): Promise<void> {
    const generation = this.current.generation;
    const broker = this.broker;
    if (!broker || this.current.status !== 'running') return;

    try {
      await broker.request('lifecycle.heartbeat', { at: this.timers.now() });
      if (generation !== this.current.generation || this.current.status !== 'running') return;
      this.heartbeatFailures = 0;
    } catch (err) {
      if (generation !== this.current.generation || this.current.status !== 'running') return;
      this.heartbeatFailures += 1;
      this.warn(`heartbeat sin respuesta (${this.heartbeatFailures}): ${describe(err)}`);
      if (this.heartbeatFailures >= (this.options.heartbeatFailureThreshold ?? DEFAULT_HEARTBEAT_FAILURES)) {
        // A hung host cannot answer `shutdown` either: kill it and let the
        // exit path open the next generation.
        this.killUnresponsive();
        return;
      }
    }
    this.scheduleHeartbeat();
  }

  private killUnresponsive(): void {
    const handle = this.handle;
    this.heartbeatFailures = 0;
    if (!handle) return;
    try {
      handle.kill();
    } catch (err) {
      this.warn(`no se pudo matar al host colgado: ${describe(err)}`);
    }
  }

  // ── Housekeeping ──────────────────────────────────────────────────────

  private teardownCurrent(): void {
    this.clearHeartbeat();
    const detach = this.detachExit;
    const broker = this.broker;
    const handle = this.handle;
    this.detachExit = null;
    this.broker = null;
    this.handle = null;
    this.heartbeatFailures = 0;

    if (detach) detach();
    if (broker) broker.dispose();
    if (handle) {
      try {
        handle.kill();
      } catch (err) {
        this.warn(`no se pudo cerrar el host: ${describe(err)}`);
      }
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    this.timers.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer === null) return;
    this.timers.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  private setState(patch: Partial<ExtensionHostState>): void {
    this.current = { ...this.current, ...patch };
    this.emit({ type: 'state', state: this.state });
  }

  private forward(generation: number, event: RpcBrokerEvent): void {
    switch (event.type) {
      case 'logs':
        this.emit({ type: 'logs', generation, entries: event.entries });
        return;
      case 'notification':
        this.emit({ type: 'notification', generation, envelope: event.envelope });
        return;
      case 'request-timeout':
        this.emit({
          type: 'request-timeout',
          generation,
          method: event.method,
          extensionId: event.extensionId,
        });
        return;
      case 'dropped':
        this.emit({ type: 'dropped', generation, reason: event.reason, method: event.method });
    }
  }

  private emit(event: ExtensionHostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.warn(`suscriptor del host falló: ${describe(err)}`);
      }
    }
  }
}

function assertHandshake(payload: unknown): void {
  if (payload === null || typeof payload !== 'object') {
    throw new RpcError('HOST_UNAVAILABLE', 'El host no devolvió un handshake válido.');
  }
  const body = payload as { protocol?: unknown; ready?: unknown };
  if (body.protocol !== RPC_PROTOCOL_VERSION) {
    // Never degrade silently: an incompatible host is worse than none.
    throw new RpcError(
      'HOST_UNAVAILABLE',
      `Protocolo incompatible: el host habla ${String(body.protocol)}, Forge ${RPC_PROTOCOL_VERSION}.`,
    );
  }
  if (body.ready !== true) {
    throw new RpcError('HOST_UNAVAILABLE', 'El host respondió el handshake sin estar listo.');
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface UtilityProcessLauncherOptions {
  /** Absolute path of the compiled bootstrap (`dist-electron/extension-host/bootstrap.js`). */
  entryPoint: string;
  /** Extra environment for the host process. */
  env?: Record<string, string>;
  warn?: (message: string) => void;
}

/**
 * The only Electron-aware piece: forks the `utilityProcess` and hands it one
 * end of a `MessageChannelMain`. `electron` is required lazily so the module
 * stays loadable in the test runner, where Electron is absent.
 */
export function createUtilityProcessLauncher(
  options: UtilityProcessLauncherOptions,
): HostProcessLauncher {
  const warn = options.warn ?? ((message: string) => console.warn('[forge:ext-host]', message));
  return {
    spawn(generation: number): HostProcessHandle {
      const electron = loadElectron();
      const channel = new electron.MessageChannelMain();
      const child = electron.utilityProcess.fork(options.entryPoint, [], {
        serviceName: `forge-extension-host-${generation}`,
        // Electron 28 rejects an explicitly undefined env; omitting it is
        // what preserves the parent's environment for the normal launcher.
        ...(options.env ? { env: options.env } : {}),
        stdio: 'inherit',
      });

      // The port must travel after the process exists, or the message is lost.
      child.once('spawn', () => {
        child.postMessage({ type: HOST_PORT_MESSAGE, generation }, [channel.port2]);
      });
      channel.port1.start();

      return {
        transport: {
          send(envelope) {
            channel.port1.postMessage(envelope);
          },
          onMessage(listener) {
            const forward = (event: { data: unknown }) => listener(event.data);
            channel.port1.on('message', forward);
            return () => channel.port1.off('message', forward);
          },
          close() {
            channel.port1.close();
          },
        },
        kill() {
          child.kill();
        },
        onExit(listener) {
          const forward = (code: number) => listener(code);
          child.on('exit', forward);
          return () => child.off('exit', forward);
        },
      };
    },
  };
}

declare const require: (id: string) => unknown;

function loadElectron(): typeof import('electron') {
  return require('electron') as typeof import('electron');
}
