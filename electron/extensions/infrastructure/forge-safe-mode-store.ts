import type { SafeModeRecord, SafeModeStore } from '../application/ports/safe-mode-store';

export type ForgeConfig = Record<string, unknown>;

export interface ForgeSafeModeStoreOptions {
  readConfig: () => ForgeConfig;
  writeConfig: (config: ForgeConfig) => void;
}

const SAFE_MODE_KEY = 'extensionSafeMode';

/**
 * Safe Mode persisted next to the rest of Forge's configuration, under its
 * own key so it is not entangled with the extension registry — the whole
 * point is that it still works when that registry is what went wrong.
 *
 * Decoding only accepts an explicit `true`: anything else reads as off. A
 * corrupt document must not be able to strand the user without extensions
 * and without an explanation.
 */
export class ForgeSafeModeStore implements SafeModeStore {
  constructor(private readonly options: ForgeSafeModeStoreOptions) {}

  read(): SafeModeRecord {
    const raw = this.options.readConfig()[SAFE_MODE_KEY];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { enabled: false };
    }
    const record = raw as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      reason: typeof record.reason === 'string' ? record.reason : null,
      at: typeof record.at === 'number' ? record.at : undefined,
    };
  }

  write(record: SafeModeRecord): void {
    const config = this.options.readConfig();
    if (record.enabled) {
      config[SAFE_MODE_KEY] = {
        enabled: true,
        reason: record.reason ?? null,
        at: record.at ?? Date.now(),
      };
    } else {
      // Leaving removes the key instead of writing `false`: the absence is
      // the natural state, and a leftover record is one more thing that can
      // decay into a stale "why am I in safe mode?".
      delete config[SAFE_MODE_KEY];
    }
    this.options.writeConfig(config);
  }
}
