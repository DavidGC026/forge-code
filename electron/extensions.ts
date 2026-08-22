// ── VSIX extension manager (main process) ──────────────────────────────
//
// Forge installs complete VSIX packages and currently activates the safe,
// declarative subset that doesn't require running extension code.
//
//   contributes.themes    -> color themes (converted to Monaco in renderer)
//   contributes.snippets  -> completion snippets per language
//
// Everything else is preserved as manifest metadata so the UI can expose
// what is installed and what needs a future extension host / VSCode API shim.
//
// A .vsix is just a ZIP with the extension under `extension/`. We extract
// it into userData/extensions/<publisher.name>/ and keep a registry in the
// same JSON config file the rest of the app uses.

import { app, dialog, net, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { ExtensionRegistry } from './extensions/application/ports/extension-registry';
import type { ManifestReader } from './extensions/application/ports/manifest-reader';
import type {
  GrammarContributionReader,
  IconThemeContributionReader,
  LanguageContributionReader,
  SnippetContributionReader,
  ThemeContributionReader,
} from './extensions/application/ports/contribution-readers';
import type { ExtensionCompatibilityAnalyzer } from './extensions/application/ports/extension-compatibility-analyzer';
import {
  DeclarativeCompatibilityAnalyzer,
  toLegacySupported,
} from './extensions/application/declarative-compatibility-analyzer';
import {
  EXTENSION_IPC_PROTOCOL_VERSION,
  type ExtensionListPayload,
  type InstalledExtensionPayload,
  type MarketplaceExtensionDetailPayload,
  type MarketplaceExtensionPayload,
  type MarketplaceSearchPayload,
  type WorkspaceTrustStatusPayload,
} from './extensions/domain/extension-dto';
import type { InstalledExtensionRecord } from './extensions/domain/extension-manifest';
import { FORGE_VSCODE_API_VERSION } from './extensions/domain/vscode-engine';
import {
  isActivatableUnderTrust,
  isRemoteWorkspaceUri,
  resolveExtensionTrust,
} from './extensions/domain/workspace-trust';
import {
  UtilityProcessExtensionHost,
  createUtilityProcessLauncher,
} from './extensions/infrastructure/hosts/utility-process-host';
import type {
  ExtensionHostDescriptor,
  ExtensionHostEvent,
  ExtensionHostState,
} from './extensions/application/ports/extension-host';
import {
  ExtensionCommandDispatcher,
  type CommandRegistration,
} from './extensions/application/extension-command-dispatcher';
import {
  ExtensionActivationService,
  type ActivationFailure,
  type ActivationMetric,
} from './extensions/application/extension-activation-service';
import { scanWorkspaceForPatterns } from './extensions/infrastructure/workspace-scanner';
import {
  SafeModeService,
  SafeModeError,
} from './extensions/application/safe-mode-service';
import { ForgeSafeModeStore } from './extensions/infrastructure/forge-safe-mode-store';
import type { SafeModeStatus } from './extensions/domain/safe-mode';
import { RpcError } from './extensions/domain/rpc-protocol';
import {
  ExtensionFileSystem,
  ExtensionFileSystemError,
} from './extensions/application/extension-file-system';
import {
  NodeExtensionFileSystem,
  type RemoteFileSystemBridge,
} from './extensions/infrastructure/node-extension-file-system';
import {
  WorkspaceTrustService,
  WorkspaceTrustError,
} from './extensions/application/workspace-trust-service';
import { ForgeWorkspaceTrustStore } from './extensions/infrastructure/forge-workspace-trust-store';
import {
  CheckExtensionUpdates,
  type ExtensionUpdateInfo,
} from './extensions/application/check-extension-updates';
import {
  ConfigurationService,
  type ConfigurationInspection,
  type WritableConfigurationScope,
} from './extensions/application/configuration-service';
import { ForgeWorkspaceSettingsStore } from './extensions/infrastructure/forge-workspace-settings-store';
import { InstallExtensionById } from './extensions/application/install-extension-by-id';
import { InstallExtensionFromVsix } from './extensions/application/install-extension-from-vsix';
import { RollbackExtension } from './extensions/application/rollback-extension';
import { OpenVsxCatalog } from './extensions/infrastructure/open-vsx-catalog';
import { VsixPackageStore } from './extensions/infrastructure/vsix-package-store';
import { FileGrammarContributionReader } from './extensions/infrastructure/grammar-contribution-reader';
import { FileIconThemeContributionReader } from './extensions/infrastructure/icon-theme-contribution-reader';
import { JsonExtensionRegistry } from './extensions/infrastructure/json-extension-registry';
import { FileLanguageContributionReader } from './extensions/infrastructure/language-contribution-reader';
import { FileSnippetContributionReader } from './extensions/infrastructure/snippet-contribution-reader';
import { FileThemeContributionReader } from './extensions/infrastructure/theme-contribution-reader';
import { VscodeManifestReader } from './extensions/infrastructure/vscode-manifest-reader';

const manifestReader: ManifestReader = new VscodeManifestReader();
const themeReader: ThemeContributionReader = new FileThemeContributionReader();
const snippetReader: SnippetContributionReader = new FileSnippetContributionReader();
const languageReader: LanguageContributionReader = new FileLanguageContributionReader();
const iconThemeReader: IconThemeContributionReader = new FileIconThemeContributionReader();
const grammarReader: GrammarContributionReader = new FileGrammarContributionReader();
const compatibilityAnalyzer: ExtensionCompatibilityAnalyzer = new DeclarativeCompatibilityAnalyzer();

// ── Config helpers (same forge-config.json as the rest of main.ts) ─────

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'forge-config.json');
}

function loadConfig(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  try {
    // Atomic replace: a crash mid-write must never leave a truncated
    // forge-config.json behind (it holds the extension registry).
    const configPath = getConfigPath();
    const tmpPath = `${configPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    console.warn('[forge:ext] failed to write config:', (err as Error).message);
  }
}

const extensionRegistry: ExtensionRegistry = new JsonExtensionRegistry({
  readConfig: loadConfig,
  writeConfig: saveConfig,
});

function getExtensionsRoot(): string {
  return path.join(app.getPath('userData'), 'extensions');
}

// ── Install / list / uninstall ──────────────────────────────────────────

function entryToPayload(
  entry: InstalledExtensionRecord,
  trustState: 'trusted' | 'restricted' = getWorkspaceTrustStatus().state,
): InstalledExtensionPayload {
  const themes = themeReader.read(entry);
  const snippets = snippetReader.read(entry);
  const languages = languageReader.read(entry);
  const iconThemes = iconThemeReader.read(entry);
  const grammars = grammarReader.read(entry);
  const compatibility = compatibilityAnalyzer.analyze(entry, {
    themes: themes.length,
    snippets: snippets.length,
    languages: languages.length,
    iconThemes: iconThemes.length,
    // Settings are declared inline in the manifest, so what normalization
    // kept is exactly what the ConfigurationService serves.
    configuration: entry.configuration.length,
    configurationDefaults: Object.keys(entry.configurationDefaults).length,
    commands: entry.commands.length,
    keybindings: entry.keybindings.length,
    grammars: grammars.length,
    menus: entry.menus.length,
  });

  return {
    id: entry.id,
    displayName: entry.displayName,
    publisher: entry.publisher,
    version: entry.version,
    description: entry.description,
    categories: entry.categories || [],
    activationEvents: entry.activationEvents || [],
    extensionKind: entry.extensionKind || [],
    main: entry.main || null,
    browser: entry.browser || null,
    contributes: entry.contributes || [],
    supported: toLegacySupported(compatibility),
    compatibility,
    enabled: entry.enabled,
    previousVersion: entry.previousVersion?.version ?? null,
    themes,
    iconThemes,
    snippets,
    languages,
    configuration: entry.configuration.map((setting) => ({
      key: setting.key,
      type: setting.type,
      default: setting.default,
      description: setting.description,
      enum: setting.enum,
    })),
    commands: entry.commands,
    keybindings: entry.keybindings,
    grammars,
    menus: entry.menus,
    capabilities: entry.capabilities,
    trust: (() => {
      const { activation, restrictedConfigurations } = resolveExtensionTrust(entry, trustState);
      return { activation, restrictedConfigurations };
    })(),
  };
}

export function listExtensions(): ExtensionListPayload {
  const cfg = loadConfig();
  const workspaceTrust = getWorkspaceTrustStatus();
  return {
    protocolVersion: EXTENSION_IPC_PROTOCOL_VERSION,
    extensions: extensionRegistry.list().map((entry) => entryToPayload(entry, workspaceTrust.state)),
    workspaceTrust,
    activeTheme: typeof cfg.activeTheme === 'string' ? cfg.activeTheme : null,
    activeIconTheme: typeof cfg.activeIconTheme === 'string' ? cfg.activeIconTheme : null,
  };
}

export function setActiveTheme(themeId: string | null): void {
  const cfg = loadConfig();
  if (themeId) cfg.activeTheme = themeId;
  else delete cfg.activeTheme;
  saveConfig(cfg);
}

export function setActiveIconTheme(iconThemeId: string | null): void {
  const cfg = loadConfig();
  if (iconThemeId) cfg.activeIconTheme = iconThemeId;
  else delete cfg.activeIconTheme;
  saveConfig(cfg);
}

export async function installVsix(
  window: BrowserWindow | null,
): Promise<InstalledExtensionPayload | null> {
  if (!window) return null;
  const result = await dialog.showOpenDialog(window, {
    title: 'Install extension from VSIX',
    properties: ['openFile'],
    filters: [{ name: 'VSCode Extension', extensions: ['vsix', 'zip'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return installVsixFromPath(result.filePaths[0]);
}

const packageStore = new VsixPackageStore({
  rootDir: getExtensionsRoot,
  manifestReader,
});

const installFromVsix = new InstallExtensionFromVsix({
  packageStore,
  registry: extensionRegistry,
});

const catalog = new OpenVsxCatalog({
  tempDir: () => app.getPath('temp'),
  fetchImpl: net.fetch,
});

const installById = new InstallExtensionById({
  catalog,
  installer: installFromVsix,
  registry: extensionRegistry,
  deleteTempFile: (filePath) => fs.rmSync(filePath, { force: true }),
});

const updateChecker = new CheckExtensionUpdates({
  catalog,
  registry: extensionRegistry,
});

// Main owns which workspace is open; the facade only needs a provider that
// yields it verbatim — a local path, a remote URI, or null. Trust cares
// about remote workspaces (they can never be trusted), so the raw value is
// what crosses the boundary and the local-only view is derived here.
let workspaceProvider: () => string | null = () => null;

/** Wires the active-workspace provider; called once from main. */
export function configureExtensionWorkspace(provider: () => string | null): void {
  workspaceProvider = provider;
}

function localWorkspaceDir(): string | null {
  const workspace = workspaceProvider();
  return workspace && !isRemoteWorkspaceUri(workspace) ? workspace : null;
}

// User-scope setting values live under their own forge-config.json key so
// they survive uninstall/reinstall of the extension that declares them.
const configurationService = new ConfigurationService({
  records: () => extensionRegistry.list(),
  workspaceStore: () => {
    const dir = localWorkspaceDir();
    return dir ? new ForgeWorkspaceSettingsStore({ workspaceDir: dir }) : null;
  },
  userStore: {
    read: () => {
      const raw = loadConfig().extensionSettings;
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
    },
    write: (values) => {
      const cfg = loadConfig();
      cfg.extensionSettings = values;
      saveConfig(cfg);
    },
  },
});

// Trust decisions live under their own forge-config.json key: they are a
// property of the workspace, not of any installed extension.
const workspaceTrustService = new WorkspaceTrustService({
  store: new ForgeWorkspaceTrustStore({ readConfig: loadConfig, writeConfig: saveConfig }),
  workspace: () => workspaceProvider(),
});

// Safe Mode lives next to trust: both decide what may run before anything
// runs. It is the way out of a crash loop, so it is resolved entirely on
// this side — the host simply finds nothing to load.
const safeModeService = new SafeModeService({
  store: new ForgeSafeModeStore({ readConfig: loadConfig, writeConfig: saveConfig }),
  argv: () => process.argv,
});

export function getSafeModeStatus(): SafeModeStatus {
  return safeModeService.status();
}

/** Enters or leaves Safe Mode and syncs the host. Resolves with the new
 *  status; throws `SafeModeError` when the command line holds it on. */
export async function setSafeMode(enabled: boolean, reason?: string): Promise<SafeModeStatus> {
  const status = safeModeService.set(enabled, reason);
  await syncExtensionHost(enabled ? 'modo seguro activado' : 'modo seguro desactivado');
  return status;
}

export function onSafeModeChanged(listener: (status: SafeModeStatus) => void): () => void {
  return safeModeService.onDidChange(listener);
}

export { SafeModeError };

/** Trust of the open workspace, for IPC and the extension payloads. */
export function getWorkspaceTrustStatus(): WorkspaceTrustStatusPayload {
  return workspaceTrustService.status();
}

/** Records the user's decision for the open workspace. Throws
 *  `WorkspaceTrustError` when the workspace cannot hold one (none open, or
 *  remote). */
export function setWorkspaceTrusted(trusted: boolean): WorkspaceTrustStatusPayload {
  return trusted ? workspaceTrustService.grant() : workspaceTrustService.revoke();
}

/** Notifies after every trust decision. Returns the unsubscribe. */
export function onWorkspaceTrustChanged(
  listener: (status: WorkspaceTrustStatusPayload) => void,
): () => void {
  return workspaceTrustService.onDidChange(listener);
}

export { WorkspaceTrustError };

const rollback = new RollbackExtension({
  packageStore,
  registry: extensionRegistry,
  manifestReader,
  readManifestSource: (dir) => fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'),
});

export function installVsixFromPath(vsixPath: string): InstalledExtensionPayload {
  return entryToPayload(installFromVsix.install(vsixPath));
}

/** Re-points an installed extension at its retained previous version. */
export function rollbackExtension(id: string): InstalledExtensionPayload {
  return entryToPayload(rollback.rollback(id));
}

/** Installed extensions with a newer version published in the catalog. */
export function checkExtensionUpdates(): Promise<ExtensionUpdateInfo[]> {
  return updateChecker.check();
}

/** Every setting contributed by installed extensions, fully resolved. */
export function listConfiguration(): ConfigurationInspection[] {
  return configurationService.inspectAll();
}

/** Writes (`undefined` clears) a setting value in the given scope. */
export function setConfigurationValue(
  key: string,
  value: unknown,
  scope: WritableConfigurationScope = 'user',
): void {
  configurationService.setValue(key, value, scope);
}

/** Notifies after every configuration write. Returns the unsubscribe. */
export function onExtensionConfigurationChanged(
  listener: (key: string) => void,
): () => void {
  return configurationService.onDidChange(listener);
}

/**
 * Startup inventory: removes abandoned staging and orphan directories a
 * post-commit failure could have left in the store.
 */
export function sweepExtensionStore(): void {
  try {
    for (const removed of packageStore.sweep(extensionRegistry.list())) {
      console.warn('[forge:ext] swept orphan store entry:', removed);
    }
  } catch (err) {
    console.warn('[forge:ext] store sweep failed:', (err as Error).message);
  }
}

// ── Open VSX (`ext install publisher.name`) ─────────────────────────────
// Open VSX (open-vsx.org) is the vendor-neutral extension registry used by
// VSCode forks — the Microsoft marketplace is licensed for MS products only.

export async function installFromOpenVsx(extensionId: string): Promise<InstalledExtensionPayload> {
  return entryToPayload(await installById.install(extensionId));
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeMarketplaceExtension(raw: any): MarketplaceExtensionPayload | null {
  const namespace = typeof raw?.namespace === 'string' ? raw.namespace : '';
  const name = typeof raw?.name === 'string' ? raw.name : '';
  if (!namespace || !name) return null;

  return {
    id: `${namespace}.${name}`.toLowerCase(),
    namespace,
    name,
    displayName:
      typeof raw.displayName === 'string' && raw.displayName.trim()
        ? raw.displayName
        : name,
    description: typeof raw.description === 'string' ? raw.description : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    iconUrl: typeof raw?.files?.icon === 'string' ? raw.files.icon : null,
    downloadCount: asNumber(raw.downloadCount),
    averageRating:
      typeof raw.averageRating === 'number' && Number.isFinite(raw.averageRating)
        ? raw.averageRating
        : null,
    reviewCount: asNumber(raw.reviewCount),
    verified: Boolean(raw.verified),
    deprecated: Boolean(raw.deprecated),
    lastUpdated: typeof raw.timestamp === 'string' ? raw.timestamp : null,
  };
}

export async function searchOpenVsx(
  query: string,
  size = 20,
): Promise<MarketplaceSearchPayload> {
  const cleanQuery = query.trim();
  const safeSize = Math.max(1, Math.min(50, Math.round(size)));
  const url = new URL('https://open-vsx.org/api/-/search');
  if (cleanQuery) url.searchParams.set('query', cleanQuery);
  url.searchParams.set('size', String(safeSize));
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('sortOrder', 'desc');

  const res = await net.fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open VSX respondió ${res.status} al buscar extensiones.`);
  }

  const data: any = await res.json();
  const extensions = Array.isArray(data?.extensions)
    ? data.extensions
        .map(normalizeMarketplaceExtension)
        .filter((ext: MarketplaceExtensionPayload | null): ext is MarketplaceExtensionPayload =>
          Boolean(ext),
        )
    : [];

  return {
    total: asNumber(data?.totalSize, extensions.length),
    extensions,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Full metadata + README for the extension-detail page shown in the editor
// area. README download is capped so a pathological package can't balloon
// the renderer payload.
const README_MAX_BYTES = 512 * 1024;

export async function getOpenVsxDetail(
  extensionId: string,
): Promise<MarketplaceExtensionDetailPayload> {
  const match = extensionId.trim().match(/^([A-Za-z0-9][\w.-]*)\.([A-Za-z0-9][\w-]*)$/);
  if (!match) {
    throw new Error(`Identificador inválido: "${extensionId}". Usa el formato publisher.nombre.`);
  }
  const [, namespace, name] = match;

  const res = await net.fetch(
    `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/latest`,
  );
  if (res.status === 404) {
    throw new Error(`No se encontró "${namespace}.${name}" en Open VSX (open-vsx.org).`);
  }
  if (!res.ok) {
    throw new Error(`Open VSX respondió ${res.status} al obtener "${namespace}.${name}".`);
  }
  const meta: any = await res.json();

  let readme: string | null = null;
  const readmeUrl = asOptionalString(meta?.files?.readme);
  if (readmeUrl) {
    try {
      const readmeRes = await net.fetch(readmeUrl);
      if (readmeRes.ok) {
        readme = (await readmeRes.text()).slice(0, README_MAX_BYTES);
      }
    } catch {
      /* README is optional — the page still renders without it */
    }
  }

  const engines: Record<string, string> = {};
  if (meta?.engines && typeof meta.engines === 'object') {
    for (const [key, value] of Object.entries(meta.engines)) {
      if (typeof value === 'string') engines[key] = value;
    }
  }

  return {
    id: `${namespace}.${name}`.toLowerCase(),
    namespace,
    name,
    displayName: asOptionalString(meta?.displayName) ?? name,
    description: typeof meta?.description === 'string' ? meta.description : '',
    version: typeof meta?.version === 'string' ? meta.version : '',
    iconUrl: asOptionalString(meta?.files?.icon),
    downloadCount: asNumber(meta?.downloadCount),
    averageRating:
      typeof meta?.averageRating === 'number' && Number.isFinite(meta.averageRating)
        ? meta.averageRating
        : null,
    reviewCount: asNumber(meta?.reviewCount),
    verified: Boolean(meta?.verified),
    deprecated: Boolean(meta?.deprecated),
    lastUpdated: asOptionalString(meta?.timestamp),
    readme,
    categories: asStringArray(meta?.categories),
    tags: asStringArray(meta?.tags).filter((t) => !t.startsWith('__')),
    license: asOptionalString(meta?.license),
    homepage: asOptionalString(meta?.homepage),
    repository: asOptionalString(meta?.repository),
    bugs: asOptionalString(meta?.bugs),
    engines,
    preRelease: Boolean(meta?.preRelease),
    publishedBy: asOptionalString(meta?.publishedBy?.loginName),
  };
}

/** Toggles an installed extension without uninstalling it. */
export function setExtensionEnabled(id: string, enabled: boolean): boolean {
  const entry = extensionRegistry.get(id);
  if (!entry || entry.enabled === enabled) return Boolean(entry);
  extensionRegistry.upsert({ ...entry, enabled });
  return true;
}

export function uninstallExtension(id: string): boolean {
  const entry = extensionRegistry.get(id);
  if (!entry) return false;
  try {
    // Only delete directories we created under our own extensions root.
    // Installs are versioned (`<root>/<id>/<version>`), so remove the whole
    // per-extension directory; legacy flat installs (`<root>/<id>`) resolve
    // to the same top-level segment.
    const root = getExtensionsRoot();
    const resolved = path.resolve(entry.dir);
    if (resolved.startsWith(root + path.sep)) {
      const topLevel = path.relative(root, resolved).split(path.sep)[0];
      fs.rmSync(path.join(root, topLevel), { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[forge:ext] failed to remove extension dir:', (err as Error).message);
  }
  extensionRegistry.remove(id);
  return true;
}

// ── Extension host wiring ───────────────────────────────────────────────
//
// The host runs in a `utilityProcess` and never talks to the renderer
// directly (design §1.2): main owns the instance, and the workbench sees it
// through the `ext:host:*` channels.
//
// Nothing is loaded here yet — the kernel handshakes and heartbeats, and
// the loader lands in the next increment. What this wiring does own is the
// answer to "which extensions may this generation see", which is a trust
// decision and therefore belongs on this side of the boundary.

/** Extensions that are enabled AND allowed to activate under current trust.
 *  A blocked extension is not merely hidden in the UI: it never reaches the
 *  host, so no generation can load it by mistake. */
function activatableExtensions(): InstalledExtensionRecord[] {
  // Safe Mode is checked first and at the source: nothing downstream should
  // have to remember it, and no descriptor may reach a generation while it
  // is on.
  if (safeModeService.active) return [];
  const trustState = getWorkspaceTrustStatus().state;
  return extensionRegistry
    .list()
    .filter((entry) => entry.enabled && isActivatableUnderTrust(entry, trustState));
}

/** Where per-extension storage lives. Under `userData`, never inside the
 *  install directory: an upgrade replaces the latter wholesale. */
function extensionStorageRoot(): string {
  return path.join(app.getPath('userData'), 'extension-storage');
}

/** Directory names are derived here, on the trusted side: the host writes
 *  only inside the path it is handed, and the id never becomes a path
 *  segment as the manifest spelled it (design §7). */
function storageKeyFor(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '') || 'extension';
}

/** Translates a registry record into what the loader needs, and nothing
 *  more: contributions stay on this side of the boundary. */
function toHostDescriptor(entry: InstalledExtensionRecord): ExtensionHostDescriptor {
  const storageRoot = extensionStorageRoot();
  const workspace = localWorkspaceDir();
  return {
    id: entry.id,
    version: entry.version,
    dir: entry.dir,
    main: entry.main,
    globalStoragePath: path.join(storageRoot, 'global', storageKeyFor(entry.id)),
    // No workspace means no workspace-scoped storage: there is nothing to
    // scope it to, and inventing a path would leak state between projects.
    workspaceStoragePath: workspace
      ? path.join(storageRoot, 'workspace', storageKeyFor(workspace), storageKeyFor(entry.id))
      : null,
    extensionMode: app.isPackaged ? 'production' : 'development',
  };
}

function activatableDescriptors(): ExtensionHostDescriptor[] {
  return activatableExtensions().map(toHostDescriptor);
}

const extensionHost = new UtilityProcessExtensionHost({
  launcher: createUtilityProcessLauncher({
    // Emitted by tsc next to this file's output, and copied by the packer.
    entryPoint: path.join(__dirname, 'extension-host', 'bootstrap.js'),
  }),
  // Rebuilt per generation, so a restart always reflects the current
  // workspace, trust decision and enabled set.
  initialize: () => ({
    apiVersion: FORGE_VSCODE_API_VERSION,
    extensions: activatableDescriptors(),
    workspace: workspaceProvider(),
    trust: getWorkspaceTrustStatus().state === 'trusted',
    configuration: effectiveConfigurationSnapshot(),
  }),
  // Host → main requests. Only `window.showMessage` so far; everything else
  // falls through to the broker's `UNSUPPORTED_API`, which is what feeds the
  // compatibility report with real usage.
  onRequest: async (envelope) => {
    if (envelope.method === 'window.showMessage') {
      return showExtensionMessage(envelope.payload, envelope.extensionId ?? null);
    }
    if (ExtensionFileSystem.owns(envelope.method)) {
      if (!envelope.extensionId) {
        throw new RpcError('INVALID_PAYLOAD', 'La operación de archivo no declara su extensión.');
      }
      try {
        return await extensionFileSystem.handle(
          envelope.extensionId,
          ExtensionFileSystem.operationOf(envelope.method),
          envelope.payload,
        );
      } catch (err) {
        // The `FileSystemError` code travels as data so the host can rebuild
        // the class the extension catches on.
        if (err instanceof ExtensionFileSystemError) {
          throw new RpcError('INVALID_PAYLOAD', err.message, { code: err.code });
        }
        throw err;
      }
    }
    throw new RpcError(
      'UNSUPPORTED_API',
      `"${envelope.method}" no está soportado por Forge todavía.`,
    );
  },
});

/** Every declared setting with the value the ConfigurationService resolves,
 *  flattened by key. This is what `workspace.getConfiguration()` reads. */
function effectiveConfigurationSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const entry of configurationService.inspectAll()) {
    snapshot[entry.key] = entry.effectiveValue;
  }
  return snapshot;
}

// ── workspace.fs ────────────────────────────────────────────────────────
//
// The policy (what an extension may touch) is main's, and it is applied on
// the real path. The filesystem itself is a port, so a remote workspace
// goes through the same abstraction as the workbench: main injects the SSH
// bridge, and without one a remote URI fails typed instead of silently
// resolving against the local disk.

let remoteFileSystemBridge: RemoteFileSystemBridge | null = null;

/** Wires SSH support for `workspace.fs`; called once from main. */
export function configureExtensionRemoteFileSystem(bridge: RemoteFileSystemBridge | null): void {
  remoteFileSystemBridge = bridge;
}

const extensionFileSystem = new ExtensionFileSystem({
  fs: new NodeExtensionFileSystem({
    get remote() {
      return remoteFileSystemBridge;
    },
  }),
  scopesFor: (extensionId) => {
    const entry = extensionRegistry.get(extensionId);
    const descriptor = entry ? toHostDescriptor(entry) : null;
    return {
      workspace: workspaceProvider(),
      extensionDir: entry?.dir ?? '',
      storagePaths: descriptor
        ? [descriptor.globalStoragePath, descriptor.workspaceStoragePath]
        : [],
    };
  },
  onRefused: (extensionId, target, message) => {
    // A refusal is data for the compatibility report, not just a log line:
    // it is how we learn whether the policy is too strict for real
    // extensions instead of guessing.
    console.warn(`[forge:ext-host] "${extensionId}" rechazada sobre "${target}": ${message}`);
  },
});

// ── window.showMessage ──────────────────────────────────────────────────
// The host asks, the renderer shows, the user (maybe) picks. Main holds the
// promise in between: the notification is not modal, so the answer can take
// as long as the user takes — or never come, if they dismiss it.

interface PendingMessage {
  resolve: (selected: string | undefined) => void;
}

const pendingMessages = new Map<number, PendingMessage>();
let nextMessageId = 1;

async function showExtensionMessage(
  payload: unknown,
  extensionId: string | null,
): Promise<{ selected: string | undefined }> {
  const body = payload as
    | { severity?: unknown; message?: unknown; items?: unknown; modal?: unknown }
    | null;
  const message = body && typeof body.message === 'string' ? body.message : '';
  if (!message) {
    throw new RpcError('INVALID_PAYLOAD', '"window.showMessage" requiere un mensaje.');
  }
  const severity = body?.severity === 'warn' || body?.severity === 'error'
    ? body.severity
    : 'info';
  const items = Array.isArray(body?.items)
    ? body.items.filter((item): item is string => typeof item === 'string')
    : [];

  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    // Nowhere to show it. Resolving as "dismissed" keeps the extension
    // moving; hanging would be worse than not being seen.
    return { selected: undefined };
  }

  const id = nextMessageId++;
  const selected = await new Promise<string | undefined>((resolve) => {
    pendingMessages.set(id, { resolve });
    for (const win of windows) {
      win.webContents.send('ext:host:message', { id, severity, message, items, extensionId });
    }
  });
  return { selected };
}

/** Called from the renderer when the user picks an item or dismisses. */
export function resolveExtensionMessage(id: number, selection: string | null): void {
  const pending = pendingMessages.get(id);
  if (!pending) return;
  pendingMessages.delete(id);
  pending.resolve(typeof selection === 'string' ? selection : undefined);
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// Who activates and when. It owns the event index and the per-extension
// activation state, so every trigger — command, language, startup,
// workspaceContains — agrees on what is already running.
const activationService = new ExtensionActivationService({
  host: extensionHost,
  activatable: () => activatableExtensions().map((entry) => ({
    id: entry.id,
    activationEvents: entry.activationEvents ?? [],
  })),
  ensureRunning: () => startExtensionHost(),
  workspaceContains: (patterns) => scanWorkspaceForPatterns(localWorkspaceDir(), patterns),
  log: (message) => console.warn('[forge:ext-host]', message),
  onDidChange: () => broadcast('ext:host:activation', getExtensionActivationReport()),
});

// The command registry the host publishes. It listens to the host's own
// event stream rather than being pushed to, so a restart clears it without
// anyone having to remember to.
const commandDispatcher = new ExtensionCommandDispatcher({
  host: extensionHost,
  activation: activationService,
  onRegistryChanged: (commands) => broadcast('ext:host:commands', commands),
  log: (message) => console.warn('[forge:ext-host]', message),
});
extensionHost.onEvent((event) => {
  commandDispatcher.handleHostEvent(event);
  activationService.handleHostEvent(event);
});

// Settings changed under the host's feet: push the new snapshot instead of
// restarting. A restart would deactivate every extension over a value they
// may not even read.
configurationService.onDidChange(() => {
  if (extensionHost.state.status !== 'running') return;
  void extensionHost
    .request('configuration.update', { values: effectiveConfigurationSnapshot() })
    .catch((err) => console.warn('[forge:ext-host] configuración no propagada:', err.message));
});

/** Activation metrics and failures of the live generation, for the UI. */
export function getExtensionActivationReport(): {
  metrics: ActivationMetric[];
  failures: ActivationFailure[];
} {
  return { metrics: activationService.metrics(), failures: activationService.failures() };
}

/** Fires a workbench trigger (`onLanguage`, `onStartupFinished`). Never
 *  rejects: the user opening a file is not asking for an activation, and a
 *  broken extension must not surface as a failed file open. */
export async function fireExtensionActivation(
  trigger: { kind: 'startupFinished' } | { kind: 'language'; language: string },
): Promise<void> {
  try {
    if (activationService.candidatesFor(trigger).length === 0) return;
    await startExtensionHost();
    await activationService.fire(trigger);
  } catch (err) {
    console.warn('[forge:ext-host] trigger falló:', (err as Error).message);
  }
}

/** Resolves `workspaceContains:` for the open workspace. Called on startup
 *  and on every workspace switch. */
export async function fireWorkspaceContainsActivation(): Promise<void> {
  try {
    await activationService.fireWorkspaceContains();
  } catch (err) {
    console.warn('[forge:ext-host] workspaceContains falló:', (err as Error).message);
  }
}

/** Command ids the running generation can actually execute. The renderer
 *  needs this synchronously to decide whether a keystroke is consumed. */
export function getExtensionCommandRegistry(): CommandRegistration[] {
  return commandDispatcher.registered();
}

/** Runs an extension command, activating its owner on demand. */
export function executeExtensionCommand(command: string, args: unknown[] = []): Promise<unknown> {
  return commandDispatcher.execute(command, args);
}

export function getExtensionHostState(): ExtensionHostState {
  return extensionHost.state;
}

export function onExtensionHostEvent(
  listener: (event: ExtensionHostEvent) => void,
): () => void {
  return extensionHost.onEvent(listener);
}

/** Starts the host unless there is nothing it could ever run. Failure is
 *  reported, never thrown: a host that will not come up must not stop Forge
 *  from opening. */
export async function startExtensionHost(): Promise<ExtensionHostState> {
  if (activatableExtensions().length === 0) return extensionHost.state;
  try {
    return await extensionHost.start();
  } catch (err) {
    console.warn('[forge:ext-host] no arrancó:', (err as Error).message);
    return extensionHost.state;
  }
}

export function restartExtensionHost(reason = 'petición del usuario'): Promise<ExtensionHostState> {
  return extensionHost.restart(reason);
}

export function stopExtensionHost(reason = 'cierre de Forge'): Promise<void> {
  return extensionHost.stop(reason);
}

/**
 * Reacts to a change in what the host is allowed to run (trust decision,
 * workspace switch, enable/disable). Revoking trust must not leave a
 * generation alive with code already loaded, so the host stops outright
 * when nothing is activatable any more; otherwise it restarts, because the
 * handshake payload is what carries the new set and it is only sent once
 * per generation.
 */
export async function syncExtensionHost(reason: string): Promise<void> {
  // The event index is derived from the activatable set, so it is stale the
  // moment that set changes — including when the host is not running and
  // there is nothing else to do here.
  activationService.invalidate();
  const status = extensionHost.state.status;
  if (status === 'stopped' || status === 'disabled') return;
  if (activatableExtensions().length === 0) {
    await extensionHost.stop(reason);
    return;
  }
  await extensionHost.restart(reason);
}
