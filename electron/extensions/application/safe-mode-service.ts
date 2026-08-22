/**
 * Safe Mode as a service: resolve the state, let the user enter and leave,
 * and tell everyone who cares.
 *
 * The policy itself is pure (`domain/safe-mode.ts`); what lives here is the
 * collaboration with persistence and the rule that makes Safe Mode useful
 * at all: **entering it must not depend on the host being healthy**. It is
 * the way out of a crash loop, so it is decided entirely on this side, and
 * the host simply finds nothing to load.
 */
import {
  hasDisableExtensionsFlag,
  resolveSafeMode,
} from '../domain/safe-mode';
import type { SafeModeStatus } from '../domain/safe-mode';
import type { SafeModeRecord, SafeModeStore } from './ports/safe-mode-store';

export class SafeModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeModeError';
  }
}

export interface SafeModeServiceOptions {
  store: SafeModeStore;
  /** Process arguments, injected so the flag can be tested without a spawn. */
  argv: () => readonly string[];
  now?: () => number;
  warn?: (message: string) => void;
}

export class SafeModeService {
  private readonly options: SafeModeServiceOptions;
  private readonly listeners = new Set<(status: SafeModeStatus) => void>();
  /** Read once: the command line cannot change while the process runs. */
  private readonly fromCommandLine: boolean;

  constructor(options: SafeModeServiceOptions) {
    this.options = options;
    this.fromCommandLine = hasDisableExtensionsFlag(options.argv());
  }

  status(): SafeModeStatus {
    let persisted: SafeModeRecord = { enabled: false };
    try {
      persisted = this.options.store.read();
    } catch (err) {
      this.warn(`no se pudo leer el estado de modo seguro: ${(err as Error).message}`);
    }
    return resolveSafeMode({
      commandLine: this.fromCommandLine,
      persisted: Boolean(persisted.enabled),
      persistedReason: persisted.reason ?? null,
    });
  }

  get active(): boolean {
    return this.status().active;
  }

  /**
   * Turns Safe Mode on or off. Leaving fails loudly while the flag holds it
   * on — telling the user it worked when the next check will still say
   * "active" is worse than refusing.
   */
  set(enabled: boolean, reason?: string): SafeModeStatus {
    if (!enabled && this.fromCommandLine) {
      throw new SafeModeError(
        'Forge se inició con --disable-extensions: reinícialo sin esa opción '
        + 'para salir del modo seguro.',
      );
    }

    this.options.store.write(enabled
      ? { enabled: true, reason: reason ?? null, at: this.now() }
      : { enabled: false, reason: null });

    const status = this.status();
    this.publish(status);
    return status;
  }

  onDidChange(listener: (status: SafeModeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(status: SafeModeStatus): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(status);
      } catch (err) {
        // A subscriber must not be able to break the very mechanism that
        // recovers the editor.
        this.warn(`suscriptor de modo seguro falló: ${(err as Error).message}`);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private warn(message: string): void {
    (this.options.warn ?? ((text: string) => console.warn('[forge:ext]', text)))(message);
  }
}
