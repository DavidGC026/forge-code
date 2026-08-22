import { StateCreator } from 'zustand';
import type {
  ExtensionActivationReport,
  ExtensionConfigurationValue,
  ExtensionHostState,
  SafeModeStatus,
  InstalledExtension,
  MarketplaceSearchResult,
  SidebarPanel,
  WorkspaceTrustStatus,
} from '../../types';
import {
  applyExtensions,
  isThemeAvailable,
  setHostCommandRunner,
  setHostCommands,
} from '../../extensions/registry';
import { findIconTheme } from '../../extensions/iconTheme';
import { cleanIpcError } from '../utils/ipcError';

/** State the extension slice needs from the rest of the store. */
export interface ExtensionDependencies {
  activeSidebarPanel: SidebarPanel;
  sidebarVisible: boolean;
}

export interface ExtensionSlice {
  /** Extensions installed from VSIX/Open VSX. Forge activates supported
   *  declarative contributions and keeps the rest as package metadata. */
  installedExtensions: InstalledExtension[];
  /** Monaco theme id currently applied to the editor. */
  activeTheme: string;
  activeIconTheme: string | null;
  /** True while a VSIX is being installed (file picker or Open VSX). */
  extBusy: boolean;
  /** Last install error, shown in the Extensions panel. */
  extError: string | null;
  /** Marketplace search state backed by Open VSX. */
  marketplaceResults: MarketplaceSearchResult;
  marketplaceBusy: boolean;
  marketplaceError: string | null;
  /** id → latest catalog version, for installed extensions with an update. */
  extensionUpdates: Record<string, string>;
  /** Settings contributed by installed extensions, resolved per scope. */
  extensionConfiguration: ExtensionConfigurationValue[];
  /** Trust of the open workspace. Restricted Mode is the default: nothing
   *  is assumed trusted until the user says so. */
  workspaceTrust: WorkspaceTrustStatus;
  /** Last trust error (e.g. granting trust to a remote workspace). */
  workspaceTrustError: string | null;
  /** Extension host state, mirrored from main. `null` outside Electron. */
  extensionHostState: ExtensionHostState | null;
  /** Activation timings and failures of the live generation. */
  extensionActivation: ExtensionActivationReport | null;
  /** Safe Mode: Forge running with every extension inert. */
  safeMode: SafeModeStatus;
  /** Last Safe Mode error (trying to leave while the flag holds it on). */
  safeModeError: string | null;

  /** Subscribes to host state and keeps `extensionHostState` in step.
   *  Returns the unsubscribe so the app can drop it on teardown. */
  watchExtensionHost: () => () => void;
  /** Asks main for a fresh host generation (safe when it is disabled). */
  restartExtensionHost: () => Promise<void>;
  /** Enters or leaves Safe Mode. Resolves with an error message, or null. */
  setSafeMode: (enabled: boolean, reason?: string) => Promise<string | null>;

  /** Load the installed-extension list from the main process and wire
   *  supported contributions into Monaco. Called once on startup. */
  refreshExtensions: () => Promise<void>;
  setTheme: (theme: string) => void;
  setIconTheme: (theme: string | null) => void;
  setColorTheme: (themeId: string) => Promise<void>;
  searchMarketplace: (query: string, size?: number) => Promise<void>;
  /** Open the VSIX picker and install. Resolves with an error message to
   *  show, or null on success/cancel. */
  installVsixExtension: () => Promise<string | null>;
  /** Download `publisher.name` from Open VSX and install it. Shows the
   *  Extensions panel so progress/errors are visible. */
  installExtensionById: (extensionId: string) => Promise<string | null>;
  uninstallExtension: (id: string) => Promise<void>;
  /** Enables/disables an installed extension; contributions follow suit. */
  setExtensionEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Returns an extension to its retained previous version. Resolves with an
   *  error message to show, or null on success. */
  rollbackExtension: (id: string) => Promise<string | null>;
  /** Refreshes `extensionUpdates` against the catalog. Best-effort. */
  checkExtensionUpdates: () => Promise<void>;
  /** Re-installs `id` from the catalog to pick up its latest version. */
  updateExtension: (id: string) => Promise<string | null>;
  /** Reloads `extensionConfiguration` from the main process. */
  refreshExtensionConfiguration: () => Promise<void>;
  /** Reloads the workspace trust status from the main process. */
  refreshWorkspaceTrust: () => Promise<void>;
  /** Applies a trust status pushed by main (`ext:trust:changed`). */
  applyWorkspaceTrust: (status: WorkspaceTrustStatus) => void;
  /** Trusts (or, with `false`, restricts again) the open workspace.
   *  Resolves with an error message to show, or null on success. */
  setWorkspaceTrusted: (trusted: boolean) => Promise<string | null>;
  /** Writes (`undefined` clears) a setting value in `scope` (default:
   *  user). Resolves with an error message to show, or null on success. */
  setExtensionSetting: (
    key: string,
    value: unknown,
    scope?: 'user' | 'workspace',
  ) => Promise<string | null>;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeMarketplaceExtension(raw: any) {
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

/** Browser fallback used when Forge runs outside Electron (plain Vite dev). */
async function searchOpenVsxFromRenderer(
  query: string,
  size: number,
): Promise<MarketplaceSearchResult> {
  const url = new URL('https://open-vsx.org/api/-/search');
  const cleanQuery = query.trim();
  if (cleanQuery) url.searchParams.set('query', cleanQuery);
  url.searchParams.set('size', String(Math.max(1, Math.min(50, Math.round(size)))));
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('sortOrder', 'desc');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open VSX respondió ${res.status} al buscar extensiones.`);
  }
  const data = await res.json();
  const extensions = Array.isArray(data?.extensions)
    ? data.extensions
        .map(normalizeMarketplaceExtension)
        .filter((
          ext: ReturnType<typeof normalizeMarketplaceExtension>,
        ): ext is NonNullable<ReturnType<typeof normalizeMarketplaceExtension>> => Boolean(ext))
    : [];

  return {
    total: asNumber(data?.totalSize, extensions.length),
    extensions,
  };
}

export const createExtensionSlice: StateCreator<
  ExtensionSlice & ExtensionDependencies,
  [],
  [],
  ExtensionSlice
> = (set, get) => ({
  installedExtensions: [],
  activeTheme: 'forge-dark',
  activeIconTheme: null,
  extBusy: false,
  extError: null,
  marketplaceResults: { total: 0, extensions: [] },
  marketplaceBusy: false,
  marketplaceError: null,
  extensionUpdates: {},
  extensionConfiguration: [],
  workspaceTrust: {
    workspace: null,
    state: 'restricted',
    decided: false,
    remote: false,
    canGrant: false,
  },
  workspaceTrustError: null,
  extensionHostState: null,
  extensionActivation: null,
  safeMode: { active: false, source: 'off', canDisable: true, reason: null },
  safeModeError: null,

  watchExtensionHost: () => {
    const api = window.electronAPI?.ext;
    if (!api?.onHostEvent) return () => {};
    void api.hostState().then((state) => set({ extensionHostState: state }));
    // Only `state` events change what the workbench shows; logs and dropped
    // notices belong to diagnostics, which lands with the host UI (3.6).
    const subscription = api.onHostEvent((event) => {
      if (event.type === 'state') set({ extensionHostState: event.state });
    });

    // Which commands the host can run, and how to run them. Both are wired
    // here so the workbench has a single place that connects the registry
    // to IPC; `registry.ts` itself stays free of `window`.
    if (api.executeCommand) {
      setHostCommandRunner(async (command, args) => {
        const answer = await api.executeCommand!(command, args);
        if (!answer?.ok) {
          throw new Error(answer?.error?.message ?? `"${command}" falló en el Extension Host`);
        }
        return answer.result;
      });
    }
    let commandSubscription: { dispose: () => void } | null = null;
    if (api.hostCommands && api.onHostCommandsChanged) {
      void api.hostCommands().then(setHostCommands).catch(() => setHostCommands([]));
      commandSubscription = api.onHostCommandsChanged(setHostCommands);
    }

    // Activation timings and failures, and Safe Mode. Both are pushed by
    // main, so the panel never polls: the first read seeds the state and
    // the subscription keeps it in step.
    let activationSubscription: { dispose: () => void } | null = null;
    if (api.activationReport && api.onActivationChanged) {
      void api.activationReport()
        .then((report) => set({ extensionActivation: report }))
        .catch(() => undefined);
      activationSubscription = api.onActivationChanged(
        (report) => set({ extensionActivation: report }),
      );
    }

    let safeModeSubscription: { dispose: () => void } | null = null;
    if (api.safeModeStatus && api.onSafeModeChanged) {
      void api.safeModeStatus()
        .then((status) => set({ safeMode: status }))
        .catch(() => undefined);
      safeModeSubscription = api.onSafeModeChanged((status) => set({ safeMode: status }));
    }

    return () => {
      subscription.dispose();
      commandSubscription?.dispose();
      activationSubscription?.dispose();
      safeModeSubscription?.dispose();
      setHostCommandRunner(null);
      setHostCommands([]);
    };
  },

  restartExtensionHost: async () => {
    const api = window.electronAPI?.ext;
    if (!api?.restartHost) return;
    try {
      set({ extensionHostState: await api.restartHost() });
    } catch (err) {
      console.error('Failed to restart the extension host:', err);
    }
  },

  setSafeMode: async (enabled: boolean, reason?: string) => {
    const api = window.electronAPI?.ext;
    if (!api?.setSafeMode) return null;
    try {
      const answer = await api.setSafeMode(enabled, reason);
      set({ safeMode: answer.status, safeModeError: answer.ok ? null : answer.error });
      // Extensions stop or start contributing wholesale, so the inventory
      // is re-read rather than patched: their payloads carry the trust and
      // activation state main resolved.
      await get().refreshExtensions();
      return answer.ok ? null : answer.error;
    } catch (err) {
      const message = cleanIpcError((err as Error).message);
      set({ safeModeError: message });
      return message;
    }
  },

  refreshExtensions: async () => {
    try {
      const { extensions, activeTheme, activeIconTheme, workspaceTrust } =
        await window.electronAPI.ext.list();
      applyExtensions(extensions);
      set({
        installedExtensions: extensions,
        // The list is produced against the trust state main resolved, so it
        // travels with it: the panel never shows extensions and trust from
        // two different moments.
        ...(workspaceTrust ? { workspaceTrust } : {}),
        activeTheme:
          activeTheme &&
          extensions.some(
            (e) => e.enabled !== false && e.themes.some((t) => t.id === activeTheme),
          )
            ? activeTheme
            : 'forge-dark',
        // Drop the persisted icon theme when its extension is gone.
        activeIconTheme: findIconTheme(extensions, activeIconTheme ?? null)
          ? activeIconTheme
          : null,
      });
      // Settings follow the installed/enabled set, so refresh them together.
      await get().refreshExtensionConfiguration();
    } catch (err) {
      console.error('Failed to refresh extensions:', err);
    }
  },

  setTheme: (theme: string) => {
    set({ activeTheme: theme });
    applyExtensions(get().installedExtensions);
  },

  setIconTheme: (theme: string | null) => {
    const safeId = findIconTheme(get().installedExtensions, theme) ? theme : null;
    set({ activeIconTheme: safeId });
    void window.electronAPI?.ext?.setActiveIconTheme?.(safeId)?.catch(() => {
      /* persisting the choice is best-effort */
    });
  },

  setColorTheme: async (themeId: string) => {
    const safeId = isThemeAvailable(themeId) ? themeId : 'forge-dark';
    set({ activeTheme: safeId });
    try {
      await window.electronAPI.ext.setActiveTheme(safeId === 'forge-dark' ? null : safeId);
    } catch {
      /* persisting the choice is best-effort */
    }
  },

  installVsixExtension: async () => {
    set({ extBusy: true, extError: null });
    try {
      if (!window.electronAPI?.ext?.installVsix) {
        throw new Error('La instalación de VSIX requiere abrir Forge como app de Electron.');
      }
      const installed = await window.electronAPI.ext.installVsix();
      if (!installed) return null; // dialog cancelled
      await get().refreshExtensions();
      // Convenience: if the extension ships themes, apply the first one so
      // the user sees the result immediately.
      const firstTheme = installed.themes[0];
      if (firstTheme) {
        await get().setColorTheme(firstTheme.id);
      }
      return null;
    } catch (err) {
      const message = cleanIpcError((err as Error).message || 'No se pudo instalar la extensión.');
      set({ extError: message });
      return message;
    } finally {
      set({ extBusy: false });
    }
  },

  installExtensionById: async (extensionId: string) => {
    // Make the Extensions panel visible so the spinner / error has a home —
    // this action is usually triggered from the command palette.
    set({
      activeSidebarPanel: 'extensions',
      sidebarVisible: true,
      extBusy: true,
      extError: null,
    });
    try {
      if (!window.electronAPI?.ext?.installFromOpenVsx) {
        throw new Error('La instalación desde Marketplace requiere abrir Forge como app de Electron.');
      }
      const installed = await window.electronAPI.ext.installFromOpenVsx(extensionId);
      await get().refreshExtensions();
      const firstTheme = installed.themes[0];
      if (firstTheme) {
        await get().setColorTheme(firstTheme.id);
      }
      return null;
    } catch (err) {
      const message = cleanIpcError((err as Error).message || 'No se pudo instalar la extensión.');
      set({ extError: message });
      return message;
    } finally {
      set({ extBusy: false });
    }
  },

  uninstallExtension: async (id: string) => {
    try {
      await window.electronAPI.ext.uninstall(id);
    } catch (err) {
      console.warn('[forge] uninstallExtension failed:', (err as Error).message);
    }
    await get().refreshExtensions();
  },

  setExtensionEnabled: async (id: string, enabled: boolean) => {
    try {
      await window.electronAPI.ext.setEnabled(id, enabled);
    } catch (err) {
      console.warn('[forge] setExtensionEnabled failed:', (err as Error).message);
    }
    // Re-list so themes/snippets/icon themes apply or retire immediately;
    // the refresh also falls back when the active theme came from `id`.
    await get().refreshExtensions();
  },

  rollbackExtension: async (id: string) => {
    set({ extBusy: true, extError: null });
    try {
      await window.electronAPI.ext.rollback(id);
      await get().refreshExtensions();
      return null;
    } catch (err) {
      const message = cleanIpcError(
        (err as Error).message || 'No se pudo volver a la versión anterior.',
      );
      set({ extError: message });
      return message;
    } finally {
      set({ extBusy: false });
    }
  },

  checkExtensionUpdates: async () => {
    if (!window.electronAPI?.ext?.checkUpdates) return;
    try {
      const updates = await window.electronAPI.ext.checkUpdates();
      set({
        extensionUpdates: Object.fromEntries(
          updates.map((u) => [u.id, u.latestVersion]),
        ),
      });
    } catch (err) {
      // An offline marketplace must not surface as an extensions error.
      console.warn('[forge] checkExtensionUpdates failed:', (err as Error).message);
    }
  },

  updateExtension: async (id: string) => {
    const message = await get().installExtensionById(id);
    if (message === null) {
      set((state) => {
        const { [id]: _updated, ...rest } = state.extensionUpdates;
        return { extensionUpdates: rest };
      });
    }
    return message;
  },

  refreshExtensionConfiguration: async () => {
    if (!window.electronAPI?.ext?.listConfiguration) return;
    try {
      set({ extensionConfiguration: await window.electronAPI.ext.listConfiguration() });
    } catch (err) {
      console.warn('[forge] refreshExtensionConfiguration failed:', (err as Error).message);
    }
  },

  refreshWorkspaceTrust: async () => {
    if (!window.electronAPI?.ext?.trustStatus) return;
    try {
      set({ workspaceTrust: await window.electronAPI.ext.trustStatus() });
    } catch (err) {
      console.warn('[forge] refreshWorkspaceTrust failed:', (err as Error).message);
    }
  },

  applyWorkspaceTrust: (status: WorkspaceTrustStatus) => {
    set({ workspaceTrust: status, workspaceTrustError: null });
  },

  setWorkspaceTrusted: async (trusted: boolean) => {
    set({ workspaceTrustError: null });
    try {
      const api = window.electronAPI?.ext;
      if (!api?.grantWorkspaceTrust || !api?.revokeWorkspaceTrust) {
        throw new Error('Workspace Trust requiere abrir Forge como app de Electron.');
      }
      set({
        workspaceTrust: trusted
          ? await api.grantWorkspaceTrust()
          : await api.revokeWorkspaceTrust(),
      });
      // Activation policy follows trust, so the payloads must be re-read.
      await get().refreshExtensions();
      return null;
    } catch (err) {
      const message = cleanIpcError(
        (err as Error).message || 'No se pudo cambiar la confianza del workspace.',
      );
      set({ workspaceTrustError: message });
      return message;
    }
  },

  setExtensionSetting: async (key: string, value: unknown, scope = 'user') => {
    try {
      await window.electronAPI.ext.setConfigurationValue(key, value, scope);
      // The main process also broadcasts ext:config:changed; refreshing here
      // keeps the write path responsive without waiting for the event.
      await get().refreshExtensionConfiguration();
      return null;
    } catch (err) {
      return cleanIpcError((err as Error).message || 'No se pudo guardar el setting.');
    }
  },

  searchMarketplace: async (query: string, size = 20) => {
    set({ marketplaceBusy: true, marketplaceError: null, extError: null });
    try {
      const results = window.electronAPI?.ext?.searchOpenVsx
        ? await window.electronAPI.ext.searchOpenVsx(query, size)
        : await searchOpenVsxFromRenderer(query, size);
      set({ marketplaceResults: results });
    } catch (err) {
      set({
        marketplaceError: cleanIpcError((err as Error).message || 'No se pudo buscar en Open VSX.'),
        marketplaceResults: { total: 0, extensions: [] },
      });
    } finally {
      set({ marketplaceBusy: false });
    }
  },
});
