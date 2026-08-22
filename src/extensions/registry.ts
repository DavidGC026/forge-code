// ── Extension registry (renderer) ───────────────────────────────────────
//
// Takes the InstalledExtension payloads provided by the main process and
// wires them into Monaco:
//
//   • Color themes: VSCode theme JSON → monaco.editor.defineTheme()
//   • Snippets:     VSCode snippet files → CompletionItemProvider
//
// Monaco may not be loaded yet when the store fetches the extension list,
// so applyExtensions() remembers the latest payload and attachMonaco()
// (called from the editor's beforeMount) replays it.

import type * as MonacoNS from 'monaco-editor';

type Monaco = typeof MonacoNS;

import type { ExtensionTheme, InstalledExtension } from '../types';
import {
  ContributionRegistry,
  type ContributionApplier,
  type Disposable,
} from './contributionRegistry';
import { contextKeys } from './contextKeys';
import { ExtensionCommandService, KeybindingService } from './commands';
import { DocumentSyncService, EditorSyncService } from './documentSync';
import { TextmateGrammarService } from './textmate';
import { EditorMenuService } from './editorMenu';
import type { IOnigLib } from 'vscode-textmate';

let monacoInstance: Monaco | null = null;
let pendingExtensions: InstalledExtension[] = [];
const registeredThemeIds = new Set<string>();
const registeredLanguageIds = new Set<string>();

// ── Theme conversion ─────────────────────────────────────────────────────

/**
 * TextMate scope → Monaco (monarch) token mapping, ordered so the first
 * match wins for a given scope. Monaco's built-in tokenizers are far less
 * granular than TextMate, so this is an approximation: enough for the
 * theme's overall palette (comments, strings, keywords, numbers, types…)
 * to come through.
 */
const SCOPE_TO_TOKEN: [string, string][] = [
  ['comment', 'comment'],
  ['punctuation.definition.comment', 'comment'],
  ['string.regexp', 'regexp'],
  ['string', 'string'],
  ['constant.numeric', 'number'],
  ['constant.character', 'string.escape'],
  ['constant.language', 'keyword'],
  ['constant', 'constant'],
  ['variable.parameter', 'variable.parameter'],
  ['variable.language', 'variable.predefined'],
  ['variable', 'variable'],
  ['support.variable', 'variable'],
  ['keyword.operator', 'operator'],
  ['keyword.control', 'keyword'],
  ['keyword', 'keyword'],
  ['storage.type', 'keyword'],
  ['storage.modifier', 'keyword'],
  ['storage', 'keyword'],
  ['entity.name.function', 'function'],
  ['support.function', 'function'],
  ['meta.function-call', 'function'],
  ['entity.name.type', 'type'],
  ['entity.name.class', 'type'],
  ['entity.other.inherited-class', 'type'],
  ['support.type', 'type'],
  ['support.class', 'type'],
  ['entity.name.namespace', 'namespace'],
  ['entity.name.tag', 'tag'],
  ['punctuation.definition.tag', 'tag'],
  ['entity.other.attribute-name', 'attribute.name'],
  ['support.type.property-name', 'key'],
  ['meta.object-literal.key', 'key'],
  ['punctuation', 'delimiter'],
  ['meta.brace', 'delimiter'],
  ['markup.heading', 'strong'],
  ['markup.bold', 'strong'],
  ['markup.italic', 'emphasis'],
  ['invalid', 'invalid'],
];

function scopeToTokens(scope: string): string[] {
  const tokens: string[] = [];
  for (const [prefix, token] of SCOPE_TO_TOKEN) {
    if (scope === prefix || scope.startsWith(prefix + '.') || scope.startsWith(prefix + ' ')) {
      tokens.push(token);
      break;
    }
  }
  return tokens;
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  // Monaco accepts #RGB, #RGBA, #RRGGBB, #RRGGBBAA.
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  return null;
}

function themeBase(theme: ExtensionTheme): MonacoNS.editor.BuiltinTheme {
  const hint = `${theme.uiTheme} ${theme.data?.type ?? ''}`.toLowerCase();
  if (hint.includes('hc-light')) return 'hc-light';
  if (hint.includes('hc')) return 'hc-black';
  if (hint.includes('light') || hint.includes('vs ') || theme.uiTheme === 'vs') return 'vs';
  return 'vs-dark';
}

export function convertVsCodeTheme(
  theme: ExtensionTheme,
): MonacoNS.editor.IStandaloneThemeData {
  const rules: MonacoNS.editor.ITokenThemeRule[] = [];
  const seen = new Set<string>();

  for (const entry of theme.data?.tokenColors ?? []) {
    if (!entry || !entry.settings) continue;
    const scopes = Array.isArray(entry.scope)
      ? entry.scope
      : typeof entry.scope === 'string'
        ? entry.scope.split(',').map((s) => s.trim())
        : ['']; // no scope → default token
    const foreground = normalizeColor(entry.settings.foreground)?.slice(1);
    const fontStyle = typeof entry.settings.fontStyle === 'string' ? entry.settings.fontStyle : undefined;
    if (!foreground && fontStyle === undefined) continue;

    for (const scope of scopes) {
      const targets = scope === '' ? [''] : scopeToTokens(scope);
      for (const token of targets) {
        // Later tokenColors entries override earlier ones (VSCode semantics):
        // remove any previous rule for the same token before pushing.
        if (seen.has(token)) {
          const idx = rules.findIndex((r) => r.token === token);
          if (idx >= 0) rules.splice(idx, 1);
        }
        seen.add(token);
        rules.push({
          token,
          ...(foreground ? { foreground } : {}),
          ...(fontStyle !== undefined ? { fontStyle } : {}),
        });
      }
    }
  }

  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.data?.colors ?? {})) {
    const color = normalizeColor(value);
    if (color) colors[key] = color;
  }

  return {
    base: themeBase(theme),
    inherit: true,
    rules,
    colors,
  };
}

// ── Snippets ─────────────────────────────────────────────────────────────

/** VSCode language ids that Monaco names differently. */
const LANGUAGE_ALIASES: Record<string, string> = {
  javascriptreact: 'javascript',
  typescriptreact: 'typescript',
  jsonc: 'json',
  shellscript: 'shell',
  vue: 'html',
};

interface SnippetItem {
  label: string;
  insertText: string;
  documentation: string;
}

function toMonacoLanguage(monaco: Monaco, vscodeLanguage: string): string | null {
  const candidate = LANGUAGE_ALIASES[vscodeLanguage] ?? vscodeLanguage;
  const known = monaco.languages.getLanguages().some((l) => l.id === candidate);
  return known ? candidate : null;
}

/** Builds the snippet providers for one extension, grouped per Monaco
 *  language. Registered per extension so retiring it disposes exactly its
 *  providers; Monaco merges suggestions across providers of a language. */
function snippetDisposablesFor(monaco: Monaco, ext: InstalledExtension): Disposable[] {
  // Group this extension's snippets by Monaco language: one provider each.
  const byLanguage = new Map<string, Map<string, SnippetItem>>();
  for (const file of ext.snippets) {
    const language = toMonacoLanguage(monaco, file.language);
    if (!language) continue;
    const bucket = byLanguage.get(language) ?? new Map<string, SnippetItem>();
    byLanguage.set(language, bucket);

    for (const [name, def] of Object.entries(file.snippets)) {
      if (!def || !def.body) continue;
      const body = Array.isArray(def.body) ? def.body.join('\n') : String(def.body);
      const prefixes = Array.isArray(def.prefix)
        ? def.prefix
        : def.prefix
          ? [def.prefix]
          : [name];
      for (const prefix of prefixes) {
        if (typeof prefix !== 'string' || !prefix) continue;
        bucket.set(`${prefix}\u0000${name}`, {
          label: prefix,
          insertText: body,
          documentation: def.description || name,
        });
      }
    }
  }

  const disposables: Disposable[] = [];
  for (const [language, bucket] of byLanguage) {
    const items = Array.from(bucket.values());
    const disposable = monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position);
        const range: MonacoNS.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: item.insertText,
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: item.documentation,
            detail: 'snippet',
            range,
          })),
        };
      },
    });
    disposables.push(disposable);
  }
  return disposables;
}

// ── Languages ────────────────────────────────────────────────────────────

/** Convert a string pattern to a RegExp, handling potential invalid regex
 *  gracefully (return undefined so Monaco falls back to defaults). */
function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** Language registrations + configurations for one extension. Monaco has no
 *  `unregister` for languages themselves, but the configuration disposables
 *  are per extension, so retiring one leaves the rest untouched. */
function languageDisposablesFor(monaco: Monaco, ext: InstalledExtension): Disposable[] {
  const disposables: Disposable[] = [];
  const knownIds = new Set(monaco.languages.getLanguages().map((l) => l.id));

  for (const lang of ext.languages ?? []) {
    // Register the language with Monaco if it's not already known.
    if (!knownIds.has(lang.id) && !registeredLanguageIds.has(lang.id)) {
      monaco.languages.register({
        id: lang.id,
        aliases: lang.aliases.length > 0 ? lang.aliases : undefined,
        extensions: lang.extensions.length > 0 ? lang.extensions : undefined,
        filenames: lang.filenames.length > 0 ? lang.filenames : undefined,
        firstLine: lang.firstLine ?? undefined,
      });
      registeredLanguageIds.add(lang.id);
    }

    // Apply language configuration if provided.
    if (lang.configuration) {
      try {
        const cfg = lang.configuration;
        const monacoConfig: MonacoNS.languages.LanguageConfiguration = {};

        if (cfg.comments) {
          monacoConfig.comments = {};
          if (cfg.comments.lineComment) {
            monacoConfig.comments.lineComment = cfg.comments.lineComment;
          }
          if (cfg.comments.blockComment) {
            monacoConfig.comments.blockComment = cfg.comments.blockComment;
          }
        }

        if (cfg.brackets) {
          monacoConfig.brackets = cfg.brackets;
        }

        if (cfg.autoClosingPairs) {
          monacoConfig.autoClosingPairs = cfg.autoClosingPairs.map((pair) => {
            if (Array.isArray(pair)) {
              return { open: pair[0], close: pair[1] };
            }
            return pair;
          });
        }

        if (cfg.surroundingPairs) {
          monacoConfig.surroundingPairs = cfg.surroundingPairs.map((pair) => {
            if (Array.isArray(pair)) {
              return { open: pair[0], close: pair[1] };
            }
            return pair;
          });
        }

        if (cfg.folding?.markers?.start && cfg.folding?.markers?.end) {
          const startRe = safeRegExp(cfg.folding.markers.start);
          const endRe = safeRegExp(cfg.folding.markers.end);
          if (startRe && endRe) {
            monacoConfig.folding = {
              markers: {
                start: startRe,
                end: endRe,
              },
            };
          }
        }

        if (cfg.wordPattern) {
          const wp = safeRegExp(cfg.wordPattern);
          if (wp) monacoConfig.wordPattern = wp;
        }

        if (cfg.indentationRules) {
          const inc = cfg.indentationRules.increaseIndentPattern
            ? safeRegExp(cfg.indentationRules.increaseIndentPattern)
            : undefined;
          const dec = cfg.indentationRules.decreaseIndentPattern
            ? safeRegExp(cfg.indentationRules.decreaseIndentPattern)
            : undefined;
          if (inc || dec) {
            monacoConfig.indentationRules = {
              increaseIndentPattern: inc ?? /(?!)/,
              decreaseIndentPattern: dec ?? /(?!)/,
            };
          }
        }

        const disposable = monaco.languages.setLanguageConfiguration(lang.id, monacoConfig);
        disposables.push(disposable);
      } catch (err) {
        console.warn(`[forge:ext] failed to set language config for "${lang.id}":`, err);
      }
    }
  }
  return disposables;
}

// ── Appliers + registry ─────────────────────────────────────────────────
// One applier per contribution family (open/closed: new families are new
// appliers, not edits to the sync logic). The ContributionRegistry owns
// per-extension cleanup, so toggling one extension retires exactly its
// contributions without re-registering everyone else's.

const themeApplier: ContributionApplier<Monaco, InstalledExtension> = {
  family: 'themes',
  apply(monaco, ext) {
    for (const theme of ext.themes) {
      try {
        monaco.editor.defineTheme(theme.id, convertVsCodeTheme(theme));
        registeredThemeIds.add(theme.id);
      } catch (err) {
        console.warn(`[forge:ext] failed to register theme "${theme.label}":`, err);
      }
    }
    // Monaco has no `undefineTheme`: retired themes stay defined but inert
    // (the active-theme fallback in refreshExtensions stops selecting them).
    return [];
  },
};

const snippetApplier: ContributionApplier<Monaco, InstalledExtension> = {
  family: 'snippets',
  apply: (monaco, ext) => snippetDisposablesFor(monaco, ext),
};

const languageApplier: ContributionApplier<Monaco, InstalledExtension> = {
  family: 'languages',
  apply: (monaco, ext) => languageDisposablesFor(monaco, ext),
};

// ── TextMate grammars ───────────────────────────────────────────────────
// Real tokenization for `contributes.grammars`. The Oniguruma WASM is
// inlined as a data URL by vite (see assetsInlineLimit) so it also loads
// under file:// in the packaged app; everything is imported lazily so the
// engine is only paid for when a grammar actually registers.

async function createOnigLib(): Promise<IOnigLib> {
  const [oniguruma, wasmModule] = await Promise.all([
    import('vscode-oniguruma'),
    import('vscode-oniguruma/release/onig.wasm?url'),
  ]);
  const response = await fetch(wasmModule.default);
  await oniguruma.loadWASM(await response.arrayBuffer());
  return {
    createOnigScanner: (patterns) => oniguruma.createOnigScanner(patterns),
    createOnigString: (value) => oniguruma.createOnigString(value),
  };
}

export const textmateGrammarService = new TextmateGrammarService({
  createOnigLib,
});

/** Async bridge to monaco.languages.setTokensProvider: the registration
 *  only happens if the grammar compiles, and disposing before that
 *  resolves cancels it. */
function tokensProviderDisposable(monaco: Monaco, languageId: string): Disposable {
  let disposed = false;
  let registration: Disposable | null = null;
  void textmateGrammarService
    .createTokensProvider(languageId)
    .then((provider) => {
      if (!provider || disposed) return;
      registration = monaco.languages.setTokensProvider(
        languageId,
        provider as MonacoNS.languages.TokensProvider,
      );
    })
    .catch((err: Error) => {
      console.warn(`[forge:ext] tokens provider for "${languageId}" failed:`, err.message);
    });
  return {
    dispose: () => {
      disposed = true;
      registration?.dispose();
    },
  };
}

const grammarApplier: ContributionApplier<Monaco, InstalledExtension> = {
  family: 'grammars',
  apply(monaco, ext) {
    const disposables: Disposable[] = [];
    for (const grammar of ext.grammars ?? []) {
      disposables.push(textmateGrammarService.register(grammar));
      // The language applier runs earlier in the same pass, so a language
      // this extension declares is already registered with Monaco.
      if (grammar.language) {
        disposables.push(tokensProviderDisposable(monaco, grammar.language));
      }
    }
    return disposables;
  },
};

const contributionRegistry = new ContributionRegistry<Monaco, InstalledExtension>([
  themeApplier,
  snippetApplier,
  languageApplier,
  grammarApplier,
]);

// ── Commands + keybindings ──────────────────────────────────────────────
// Workbench-level contributions: they need no Monaco instance, so they
// live in their own registry synced on every applyExtensions() call.

// Commands the Extension Host has registered. Kept as a plain set here so
// `hasHandler` stays synchronous — a keybinding must decide whether it
// consumes the keystroke before any IPC could answer. The workbench fills
// it through `setHostCommands`; this module never touches `window`.
const hostCommands = new Set<string>();
// Commands an installed extension promises to register when woken up
// (`onCommand:<id>`). Main activates on demand, so these are runnable even
// though no handler exists yet — treating them as missing would make every
// command fail until something else happened to activate its extension.
const activatableCommands = new Set<string>();
let hostCommandRunner: ((command: string, args: unknown[]) => Promise<unknown>) | null = null;

/** Publishes the host's command registry (replaces the previous set). */
export function setHostCommands(commands: readonly { command: string }[]): void {
  hostCommands.clear();
  for (const entry of commands) hostCommands.add(entry.command);
}

/** Wires how a host command is run. Without it, host commands are inert. */
export function setHostCommandRunner(
  runner: ((command: string, args: unknown[]) => Promise<unknown>) | null,
): void {
  hostCommandRunner = runner;
}

/** Runtime command handlers. Declarative commands ship metadata only; a
 *  command with no local handler falls through to the Extension Host, and
 *  one nobody registers never consumes its trigger. */
export const extensionCommandService = new ExtensionCommandService({
  hasRemote: (command) => hostCommands.has(command) || activatableCommands.has(command),
  executeRemote: (command, args) => (hostCommandRunner
    ? hostCommandRunner(command, args)
    : Promise.reject(new Error('el Extension Host no está conectado'))),
});

/**
 * Mirrors open buffers to the Extension Host. It lives here, next to the
 * other workbench-level services, so `registry.ts` stays the single place
 * the editor talks to about extensions — and, like the rest of this module,
 * it holds no reference to `window`: the transport is wired from outside.
 */
export const documentSyncService = new DocumentSyncService({
  send: (event) => {
    try {
      (window as unknown as {
        electronAPI?: { ext?: { syncDocument?: (payload: unknown) => void } };
      }).electronAPI?.ext?.syncDocument?.(event);
    } catch {
      /* outside Electron there is no host to mirror to */
    }
  },
});

/** Publishes the editor layout (visible editors, caret, focus) to the host. */
export const editorSyncService = new EditorSyncService({
  send: (layout) => {
    try {
      (window as unknown as {
        electronAPI?: { ext?: { syncEditors?: (payload: unknown) => void } };
      }).electronAPI?.ext?.syncEditors?.(layout);
    } catch {
      /* outside Electron there is no host to publish to */
    }
  },
});

/** Dispatches contributed keybindings, gated by their when-clauses. */
export const extensionKeybindingService = new KeybindingService({
  matchWhen: (expression) => contextKeys.match(expression),
  execute: (command) => extensionCommandService.execute(command),
});

const keybindingApplier: ContributionApplier<null, InstalledExtension> = {
  family: 'keybindings',
  apply: (_host, ext) =>
    ext.keybindings.map((binding) => extensionKeybindingService.register(binding)),
};

const workbenchRegistry = new ContributionRegistry<null, InstalledExtension>([
  keybindingApplier,
]);

// ── editor/context menu ──────────────────────────────────────────────────
// Monaco actions cannot be hidden by a predicate, so the service keeps the
// registered set equal to the currently-visible items and reconciles on
// both triggers: extension-set changes (applyExtensions) and context-key
// changes (subscription below).

export const editorMenuService = new EditorMenuService({
  matchWhen: (expression) => contextKeys.match(expression),
  execute: (command, ...args) => extensionCommandService.execute(command, ...args),
  activeResource: () => {
    const path = contextKeys.get('resourcePath');
    return typeof path === 'string' ? path : null;
  },
});

// The workbench publishes its keys one `set()` at a time, so coalesce the
// burst into a single reconciliation per tick.
let editorMenuRefreshQueued = false;
contextKeys.onDidChange(() => {
  if (editorMenuRefreshQueued) return;
  editorMenuRefreshQueued = true;
  queueMicrotask(() => {
    editorMenuRefreshQueued = false;
    editorMenuService.refresh();
  });
});

// ── Public API ───────────────────────────────────────────────────────────

/** Called from the editor's beforeMount with the live monaco namespace. */
export function attachMonaco(monaco: Monaco): void {
  if (monacoInstance !== monaco) {
    // Disposables from a previous Monaco instance are meaningless for the
    // new one: drop the applied state and replay from scratch.
    contributionRegistry.reset();
  }
  monacoInstance = monaco;
  contributionRegistry.sync(monaco, pendingExtensions);
  editorMenuService.attach(monaco.editor);
}

/** Reconciles the active extension set: themes + snippets + languages.
 *  Disabled extensions contribute nothing; only extensions that appeared,
 *  disappeared or changed version are (re)applied or retired. Safe to call
 *  before Monaco is loaded — the payload replays on attachMonaco(). */
export function applyExtensions(extensions: InstalledExtension[]): void {
  const active = extensions.filter((ext) => ext.enabled !== false);
  pendingExtensions = active;
  activatableCommands.clear();
  for (const ext of active) {
    for (const event of ext.activationEvents ?? []) {
      if (event.startsWith('onCommand:')) activatableCommands.add(event.slice('onCommand:'.length));
    }
  }
  // Keybindings work with no editor open, so their registry syncs even
  // before Monaco loads.
  workbenchRegistry.sync(null, active);
  // Derived on demand from the active set: an extension that left simply
  // stops contributing items, so its actions are retired by the diff.
  editorMenuService.sync(active);
  if (monacoInstance) {
    contributionRegistry.sync(monacoInstance, active);
  }
}

/** Whether a theme id is safe to pass to Monaco (built-ins + registered). */
export function isThemeAvailable(themeId: string): boolean {
  return (
    themeId === 'forge-dark' ||
    themeId === 'vs' ||
    themeId === 'vs-dark' ||
    themeId === 'hc-black' ||
    themeId === 'hc-light' ||
    registeredThemeIds.has(themeId)
  );
}
