/**
 * The object an extension gets from `require('vscode')`.
 *
 * Built **per extension** (design §4). What is genuinely implemented in this
 * increment is only what carries no workbench behaviour: primitives, enums,
 * `version` and the read-only parts of `env`. Every namespace that would need
 * to reach the workbench — `commands`, `window`, `workspace`, `languages`,
 * … — is present but throws `UnsupportedApiError` on use and reports itself,
 * so a Hello World fails with "vscode.commands.registerCommand todavía no
 * está implementado" instead of a `TypeError` inside its own bundle.
 *
 * Increment 3.3 replaces the `commands` members one by one; the namespaces
 * that stay unsupported keep feeding the compatibility report meanwhile.
 */
import {
  CancellationError,
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  Position,
  Range,
  Selection,
  Uri,
} from './primitives';
import { TextEdit, WorkspaceEdit } from './workspace-edit';
import { FileSystemError } from './workspace-fs';
import { VSCODE_ENUMS } from './enums';
import { createUnsupportedNamespace } from './unsupported';
import type { UnsupportedApiReporter } from './unsupported';

/** Namespaces of the `vscode` API surface Forge acknowledges. Listing them
 *  explicitly (instead of proxying anything) keeps a typo in an extension —
 *  `vscode.comands` — an honest `undefined` rather than a fake namespace. */
export const VSCODE_NAMESPACES = [
  'commands',
  'window',
  'workspace',
  'languages',
  'extensions',
  'tasks',
  'debug',
  'scm',
  'notebooks',
  'tests',
  'comments',
  'authentication',
  'l10n',
  'env',
] as const;

export interface VscodeFacadeOptions {
  extensionId: string;
  /** VS Code API version Forge emulates; also `vscode.version`. */
  apiVersion: string;
  /** Reported per access so compatibility is measured, not guessed. */
  reportUnsupported: UnsupportedApiReporter;
  /** Members already implemented, keyed by namespace. Increments add here. */
  implemented?: Record<string, Record<string, unknown>>;
  /** Absolute path of the current workspace, or `null`. */
  workspacePath?: string | null;
  language?: string;
}

export function createVscodeApi(options: VscodeFacadeOptions): Record<string, unknown> {
  const { extensionId, reportUnsupported } = options;
  const implemented = options.implemented ?? {};

  const api: Record<string, unknown> = {
    version: options.apiVersion,

    // Primitives: same classes for everyone, no per-extension state.
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Selection,
    TextEdit,
    WorkspaceEdit,
    FileSystemError,
    CancellationTokenSource,
    CancellationError,
    ...VSCODE_ENUMS,
  };

  for (const namespace of VSCODE_NAMESPACES) {
    api[namespace] = createUnsupportedNamespace(
      namespace,
      extensionId,
      reportUnsupported,
      namespace === 'env'
        ? { ...staticEnv(options), ...(implemented.env ?? {}) }
        : implemented[namespace] ?? {},
    );
  }

  return api;
}

/** Read-only facts about the running app. Answering them costs nothing and
 *  extensions branch on them at import time, long before any activation. */
function staticEnv(options: VscodeFacadeOptions): Record<string, unknown> {
  return {
    appName: 'Forge',
    appHost: 'desktop',
    uriScheme: 'forge',
    language: options.language ?? 'es',
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    // A stable, non-identifying value: extensions use it as a cache key, and
    // shipping a real machine id would be gratuitous fingerprinting.
    machineId: 'forge-local',
    sessionId: `forge-${options.extensionId}`,
    shell: process.env.SHELL ?? '',
  };
}
