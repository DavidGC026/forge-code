// ── Extension commands + keybindings (renderer) ─────────────────────────
//
// Two small services with a single seam between them:
//
//   • ExtensionCommandService — maps command ids to handlers and executes
//     them. A local handler wins; otherwise the command falls through to
//     the Extension Host, which activates its extension on demand. Only a
//     command nobody owns is a well-reported no-op.
//   • KeybindingService — resolves `contributes.keybindings` chords for
//     the current platform and dispatches keyboard events to commands,
//     gated by their `when`-clauses.
//
// Both are erasable TypeScript (tested unbundled via Node type stripping)
// and receive their collaborators as functions, not imports (DIP).

import type { Disposable } from './contributionRegistry';

export type ExtensionCommandHandler = (...args: unknown[]) => unknown;

export interface ExtensionCommandServiceOptions {
  warn?: (message: string) => void;
  /**
   * Whether the Extension Host has a handler for this id. Must answer
   * **synchronously**: a keybinding has to decide whether it consumes the
   * keystroke before the round-trip could possibly finish.
   */
  hasRemote?: (command: string) => boolean;
  /** Runs the command in the host. Rejections are reported, not thrown:
   *  nobody is awaiting a keystroke. */
  executeRemote?: (command: string, args: unknown[]) => Promise<unknown>;
}

export class ExtensionCommandService {
  private readonly handlers = new Map<string, ExtensionCommandHandler>();
  private readonly warn: (message: string) => void;
  private readonly hasRemote: (command: string) => boolean;
  private readonly executeRemote: ((command: string, args: unknown[]) => Promise<unknown>) | null;

  constructor(options: ExtensionCommandServiceOptions | ((message: string) => void) = {}) {
    const resolved: ExtensionCommandServiceOptions =
      typeof options === 'function' ? { warn: options } : options;
    this.warn = resolved.warn ?? ((message) => console.warn('[forge:ext]', message));
    this.hasRemote = resolved.hasRemote ?? (() => false);
    this.executeRemote = resolved.executeRemote ?? null;
  }

  /** Registers the handler for a command id (last registration wins, as in
   *  VS Code's registerCommand). Disposing removes it only if it is still
   *  the active handler. */
  registerHandler(command: string, handler: ExtensionCommandHandler): Disposable {
    this.handlers.set(command, handler);
    return {
      dispose: () => {
        if (this.handlers.get(command) === handler) this.handlers.delete(command);
      },
    };
  }

  /** True when the command will actually run: a local handler, or one the
   *  Extension Host registered. */
  hasHandler(command: string): boolean {
    return this.handlers.has(command) || this.hasRemote(command);
  }

  /**
   * Runs the command. Returns whether it was dispatched at all — not
   * whether it succeeded — because that is the question the caller has:
   * a keystroke is consumed when something took the command, and a host
   * command that throws still took it.
   *
   * Local handlers win over the host's: they are the workbench's own, and
   * an extension must not be able to shadow them by claiming the id.
   */
  execute(command: string, ...args: unknown[]): boolean {
    const handler = this.handlers.get(command);
    if (handler) {
      try {
        handler(...args);
      } catch (err) {
        this.warn(`command "${command}" failed: ${(err as Error).message}`);
      }
      return true;
    }

    if (this.executeRemote && this.hasRemote(command)) {
      // Fire and report: the result lands long after the trigger returned.
      void this.executeRemote(command, args).catch((err: unknown) => {
        this.warn(`command "${command}" failed in the Extension Host: ${(err as Error).message}`);
      });
      return true;
    }

    this.warn(`command "${command}" has no handler`);
    return false;
  }

  /**
   * Runs the command and waits for it. For callers that need the result or
   * the failure — the palette reporting an activation error, mostly. An
   * unknown command still resolves `false` rather than throwing, so the
   * caller decides how loud to be.
   */
  async executeAndWait(command: string, ...args: unknown[]): Promise<boolean> {
    const handler = this.handlers.get(command);
    if (handler) {
      await handler(...args);
      return true;
    }
    if (this.executeRemote && this.hasRemote(command)) {
      await this.executeRemote(command, args);
      return true;
    }
    return false;
  }
}

// ── Keybindings ─────────────────────────────────────────────────────────

/** Declarative binding as it arrives in the extension payload. Structural
 *  twin of `ExtensionKeybinding` in types.ts, declared locally so this
 *  module stays importable without the workbench type barrel. */
export interface ExtensionKeybindingContribution {
  command: string;
  key: string;
  mac: string | null;
  linux: string | null;
  win: string | null;
  when: string | null;
}

export type KeybindingPlatform = 'mac' | 'win' | 'linux';

/** The subset of KeyboardEvent the dispatcher needs (DOM-free for tests). */
export interface KeyStrokeEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ParsedChord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

/** VS Code key names → `KeyboardEvent.key` (lowercased) equivalents. */
const KEY_NAME_TO_EVENT_KEY: Record<string, string> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  space: ' ',
  escape: 'escape',
  enter: 'enter',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
};

/**
 * Parses a single-stroke chord like `ctrl+shift+p`. Multi-stroke chords
 * (`ctrl+k ctrl+s`) return null — Forge's dispatcher is single-stroke for
 * now. `cmd`/`meta`/`win` all map to the meta modifier.
 */
export function parseChord(chord: string): ParsedChord | null {
  if (/\s/.test(chord.trim())) return null;
  const parsed: ParsedChord = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const rawPart of chord.split('+')) {
    const part = rawPart.trim().toLowerCase();
    if (!part) return null;
    if (part === 'ctrl' || part === 'control') parsed.ctrl = true;
    else if (part === 'shift') parsed.shift = true;
    else if (part === 'alt' || part === 'option') parsed.alt = true;
    else if (part === 'cmd' || part === 'meta' || part === 'win') parsed.meta = true;
    else if (parsed.key) return null; // two non-modifier parts
    else parsed.key = KEY_NAME_TO_EVENT_KEY[part] ?? part;
  }
  return parsed.key ? parsed : null;
}

/** Chord to resolve on `platform`, falling back to the default `key`. */
export function chordForPlatform(
  binding: ExtensionKeybindingContribution,
  platform: KeybindingPlatform,
): string {
  const specific = platform === 'mac' ? binding.mac : platform === 'win' ? binding.win : binding.linux;
  return specific ?? binding.key;
}

export function matchesStroke(chord: ParsedChord, event: KeyStrokeEvent): boolean {
  return (
    chord.ctrl === event.ctrlKey &&
    chord.shift === event.shiftKey &&
    chord.alt === event.altKey &&
    chord.meta === event.metaKey &&
    chord.key === event.key.toLowerCase()
  );
}

// ── Human-readable summaries ────────────────────────────────────────────
// What the extension detail view shows: the commands an extension
// declares, each with the shortcut that reaches it on this platform.

/** `KeyboardEvent.key` values → the labels VS Code prints. */
const EVENT_KEY_TO_LABEL: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  ' ': 'Space',
  escape: 'Esc',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

/** Renders a chord the way the platform writes it: `⇧⌘P` on macOS,
 *  `Ctrl+Shift+P` elsewhere. Returns null when the chord is unsupported
 *  (multi-stroke), which is also what the dispatcher refuses to register. */
export function formatChord(chord: string, platform: KeybindingPlatform): string | null {
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const key =
    EVENT_KEY_TO_LABEL[parsed.key] ??
    (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.replace(/^f(\d+)$/, 'F$1'));
  if (platform === 'mac') {
    return `${parsed.ctrl ? '⌃' : ''}${parsed.alt ? '⌥' : ''}${parsed.shift ? '⇧' : ''}${parsed.meta ? '⌘' : ''}${key}`;
  }
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  if (parsed.meta) parts.push(platform === 'win' ? 'Win' : 'Super');
  parts.push(key);
  return parts.join('+');
}

/** A command as the detail view lists it. */
export interface CommandSummary {
  command: string;
  /** Category-prefixed title, falling back to the raw id. */
  title: string;
  enablement: string | null;
  /** Shortcuts reaching this command on `platform`, in declaration order.
   *  `label` is null for chords Forge cannot dispatch yet. */
  keybindings: { label: string | null; chord: string; when: string | null }[];
}

/** Pairs an extension's declared commands with its keybindings. Bindings
 *  that target a command the extension does not declare are listed too —
 *  VS Code allows re-binding another extension's (or a built-in) command,
 *  and hiding them would misrepresent what the extension changes. */
export function summarizeCommands(
  extension: {
    commands: { command: string; title: string; category: string | null; enablement: string | null }[];
    keybindings: ExtensionKeybindingContribution[];
  },
  platform: KeybindingPlatform,
): CommandSummary[] {
  const summaries = new Map<string, CommandSummary>();
  for (const cmd of extension.commands ?? []) {
    summaries.set(cmd.command, {
      command: cmd.command,
      title: cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title,
      enablement: cmd.enablement,
      keybindings: [],
    });
  }
  for (const binding of extension.keybindings ?? []) {
    let summary = summaries.get(binding.command);
    if (!summary) {
      summary = {
        command: binding.command,
        title: binding.command,
        enablement: null,
        keybindings: [],
      };
      summaries.set(binding.command, summary);
    }
    const chord = chordForPlatform(binding, platform);
    summary.keybindings.push({
      label: formatChord(chord, platform),
      chord,
      when: binding.when,
    });
  }
  return [...summaries.values()];
}

export interface KeybindingServiceOptions {
  /** Evaluates a binding's when-clause (null always matches). */
  matchWhen: (expression: string | null) => boolean;
  /** Runs the command; false = no handler, the event is not consumed. */
  execute: (command: string) => boolean;
  platform?: KeybindingPlatform;
  warn?: (message: string) => void;
}

interface RegisteredKeybinding {
  chord: ParsedChord;
  command: string;
  when: string | null;
}

export function detectPlatform(): KeybindingPlatform {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'win';
  return 'linux';
}

export class KeybindingService {
  private readonly bindings: RegisteredKeybinding[] = [];
  private readonly options: Required<Omit<KeybindingServiceOptions, 'warn' | 'platform'>> & {
    platform: KeybindingPlatform;
    warn: (message: string) => void;
  };

  constructor(options: KeybindingServiceOptions) {
    this.options = {
      matchWhen: options.matchWhen,
      execute: options.execute,
      platform: options.platform ?? detectPlatform(),
      warn: options.warn ?? ((message) => console.warn('[forge:ext]', message)),
    };
  }

  /** Registers one contributed binding. Unsupported chords (multi-stroke,
   *  unparsable) warn and return an inert disposable. */
  register(binding: ExtensionKeybindingContribution): Disposable {
    const chordText = chordForPlatform(binding, this.options.platform);
    const chord = parseChord(chordText);
    if (!chord) {
      this.options.warn(
        `keybinding "${chordText}" for "${binding.command}" is not supported (single-stroke chords only)`,
      );
      return { dispose: () => {} };
    }
    const entry: RegisteredKeybinding = { chord, command: binding.command, when: binding.when };
    this.bindings.push(entry);
    return {
      dispose: () => {
        const index = this.bindings.indexOf(entry);
        if (index >= 0) this.bindings.splice(index, 1);
      },
    };
  }

  /**
   * Dispatches a keystroke: the most recently registered matching binding
   * whose when-clause holds wins (VS Code resolves ties the same way).
   * Returns true only when a handler actually ran, so a binding without a
   * runtime handler never swallows the user's keystroke.
   */
  dispatch(event: KeyStrokeEvent): boolean {
    for (let i = this.bindings.length - 1; i >= 0; i -= 1) {
      const binding = this.bindings[i];
      if (!matchesStroke(binding.chord, event)) continue;
      if (!this.options.matchWhen(binding.when)) continue;
      return this.options.execute(binding.command);
    }
    return false;
  }
}
