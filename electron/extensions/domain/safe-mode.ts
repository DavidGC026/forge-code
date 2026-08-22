/**
 * Safe Mode: Forge running with every extension inert.
 *
 * It exists for one situation — the user cannot get back to a working
 * editor because of an extension — so its rules are about recovery, not
 * convenience:
 *
 * - **The command line wins and never persists.** `--disable-extensions` is
 *   the rescue hatch; writing it to disk would turn a one-off rescue into a
 *   permanent state the user never asked for, and the next launch would
 *   silently keep extensions off.
 * - **The user's decision does persist.** Its whole point is surviving the
 *   restart that gets someone out of a crash loop.
 * - **Leaving is only possible for what this process can undo.** A session
 *   started with the flag cannot exit Safe Mode by writing a file: the flag
 *   is still there. Saying so beats pretending it worked.
 */

export type SafeModeSource =
  /** Not in Safe Mode. */
  | 'off'
  /** `--disable-extensions` on the command line; lasts this run only. */
  | 'command-line'
  /** The user asked for it; persisted until they leave. */
  | 'user';

export interface SafeModeStatus {
  active: boolean;
  source: SafeModeSource;
  /** False when the flag holds it on: only a relaunch without it can help. */
  canDisable: boolean;
  /** Why it is on, for the banner. Null when off. */
  reason: string | null;
}

/** The flag VS Code uses, so muscle memory transfers. */
export const DISABLE_EXTENSIONS_FLAG = '--disable-extensions';

/** Whether the process was launched asking for Safe Mode. Argument parsing
 *  is exact: `--disable-extensions-foo` is a different flag, and a prefix
 *  match would silently disable extensions for it. */
export function hasDisableExtensionsFlag(argv: readonly string[]): boolean {
  return argv.some((argument) => argument === DISABLE_EXTENSIONS_FLAG);
}

export interface SafeModeInput {
  /** `--disable-extensions` was passed to this process. */
  commandLine: boolean;
  /** The persisted decision, as the store read it. */
  persisted: boolean;
  /** Persisted note about why, when there is one. */
  persistedReason?: string | null;
}

export function resolveSafeMode(input: SafeModeInput): SafeModeStatus {
  if (input.commandLine) {
    return {
      active: true,
      source: 'command-line',
      // The flag outlives anything this process writes.
      canDisable: false,
      reason: `Forge se inició con ${DISABLE_EXTENSIONS_FLAG}.`,
    };
  }
  if (input.persisted) {
    return {
      active: true,
      source: 'user',
      canDisable: true,
      reason: input.persistedReason || 'Modo seguro activado desde Forge.',
    };
  }
  return { active: false, source: 'off', canDisable: true, reason: null };
}
