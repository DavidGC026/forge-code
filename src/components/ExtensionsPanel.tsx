import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import {
  AlertTriangle,
  Blocks,
  Check,
  Code2,
  Download,
  FileArchive,
  Globe,
  History,
  Loader2,
  PackageCheck,
  Palette,
  Play,
  Power,
  Search,
  ShieldCheck,
  Star,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentTerminalId, InstalledExtension, MarketplaceExtension } from '../types';
import WorkspaceTrustBanner from './WorkspaceTrustBanner';
import ExtensionHostStatus from './ExtensionHostStatus';

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function extensionInitial(ext: MarketplaceExtension): string {
  return (ext.displayName || ext.name || '?').trim().charAt(0).toUpperCase();
}

// Claude Code and Codex are deliberately NOT mapped here: they run as terminal
// agents (AgentsPanel) and will land as independent extensions once the
// Extension Host exists.
function agentCommandForExtension(ext: MarketplaceExtension): string | null {
  const normalized = ext.id.toLowerCase();
  const haystack = `${ext.id} ${ext.displayName} ${ext.description}`.toLowerCase();
  if (haystack.includes('cursor agent') || normalized.includes('cursor-agent')) {
    return 'cursor-agent';
  }
  if (haystack.includes('antigravity') || normalized.includes('antigravity') || normalized.includes('agy')) {
    return 'agy';
  }
  return null;
}

/** Detect agent CLI command for installed extensions (mirrors marketplace helper). */
function agentCommandForInstalledExtension(ext: InstalledExtension): string | null {
  const normalized = ext.id.toLowerCase();
  const haystack = `${ext.id} ${ext.displayName} ${ext.description}`.toLowerCase();
  if (haystack.includes('cursor agent') || normalized.includes('cursor-agent')) return 'cursor-agent';
  if (haystack.includes('antigravity') || normalized.includes('antigravity') || normalized.includes('agy')) return 'agy';
  return null;
}

/** Detect formatter extensions and return a suggested CLI command. */
function formatterCliCommand(ext: InstalledExtension): string | null {
  const normalized = ext.id.toLowerCase();
  const cats = ext.categories.map((c) => c.toLowerCase());
  if (normalized === 'esbenp.prettier-vscode' || normalized.includes('prettier')) return 'npx prettier --write .';
  if (normalized === 'dbaeumer.vscode-eslint' || normalized.includes('eslint')) return 'npx eslint --fix .';
  if (cats.includes('formatters') || cats.includes('formatter')) {
    const name = ext.displayName.toLowerCase();
    if (name.includes('prettier')) return 'npx prettier --write .';
    if (name.includes('eslint')) return 'npx eslint --fix .';
    if (name.includes('biome')) return 'npx @biomejs/biome check --write .';
    return null; // formatter but no known CLI mapping
  }
  return null;
}

/** Runtime label derived from the main-process compatibility report. */
function extensionRuntimeLabel(ext: InstalledExtension): { label: string; tone: string } {
  const agentCmd = agentCommandForInstalledExtension(ext);
  const report = ext.compatibility;

  if (ext.enabled === false) {
    return {
      label: 'Disabled',
      tone: 'border-forge-border/70 bg-forge-input/70 text-forge-text/45',
    };
  }
  if (agentCmd) {
    return {
      label: 'Terminal Agent',
      tone: 'border-blue-400/30 bg-blue-400/10 text-blue-300',
    };
  }
  // Trust outranks the compatibility report: an extension the workspace
  // cannot activate is not "Active", whatever it contributes.
  if (ext.trust?.activation === 'blocked') {
    return {
      label: 'Restricted',
      tone: 'border-amber-400/25 bg-amber-400/10 text-amber-200/90',
    };
  }
  const needsHost = report.blockers.some((b) => b.kind === 'requires-extension-host');
  switch (report.level) {
    case 'full':
      return {
        label: 'Active',
        tone: 'border-forge-accent/25 bg-forge-accent/10 text-forge-accent',
      };
    case 'partial':
      return {
        label: 'Partial',
        tone: 'border-amber-400/25 bg-amber-400/10 text-amber-200/90',
      };
    default:
      return {
        label: needsHost ? 'Extension Host required' : 'Metadata only',
        tone: 'border-forge-border/70 bg-forge-input/70 text-forge-text/55',
      };
  }
}

/** Human-readable reason a pending contribution is not active yet. */
function pendingContributionReason(ext: InstalledExtension, contribution: string): string {
  const blocker = ext.compatibility.blockers.find(
    (b) => 'contribution' in b && b.contribution === contribution,
  );
  switch (blocker?.kind) {
    case 'integration-pending':
      return 'loaded, workbench integration pending';
    case 'contribution-load-failed':
      return 'failed to load from the package';
    case 'unsupported-contribution':
    default:
      return 'requires Extension Host';
  }
}

export default function ExtensionsPanel() {
  const installedExtensions = useStore((s) => s.installedExtensions);
  const activeTheme = useStore((s) => s.activeTheme);
  const activeIconTheme = useStore((s) => s.activeIconTheme);
  const extBusy = useStore((s) => s.extBusy);
  const extError = useStore((s) => s.extError);
  const marketplaceResults = useStore((s) => s.marketplaceResults);
  const marketplaceBusy = useStore((s) => s.marketplaceBusy);
  const marketplaceError = useStore((s) => s.marketplaceError);
  const searchMarketplace = useStore((s) => s.searchMarketplace);
  const installVsixExtension = useStore((s) => s.installVsixExtension);
  const installExtensionById = useStore((s) => s.installExtensionById);
  const uninstallExtension = useStore((s) => s.uninstallExtension);
  const setExtensionEnabled = useStore((s) => s.setExtensionEnabled);
  const rollbackExtension = useStore((s) => s.rollbackExtension);
  const extensionUpdates = useStore((s) => s.extensionUpdates);
  const checkExtensionUpdates = useStore((s) => s.checkExtensionUpdates);
  const updateExtension = useStore((s) => s.updateExtension);
  const setColorTheme = useStore((s) => s.setColorTheme);
  const setIconTheme = useStore((s) => s.setIconTheme);
  const runAgentInTerminal = useStore((s) => s.runAgentInTerminal);
  const openExtensionDetail = useStore((s) => s.openExtensionDetail);

  const [query, setQuery] = useState('');
  const [imageErrors, setImageErrors] = useState<Set<string>>(() => new Set());

  const installedIds = useMemo(
    () => new Set(installedExtensions.map((ext) => ext.id.toLowerCase())),
    [installedExtensions],
  );

  // Disabled extensions keep their metadata but stop offering their themes.
  const enabledExtensions = installedExtensions.filter((ext) => ext.enabled !== false);

  const themeOptions: { id: string; label: string; source: string }[] = [
    { id: 'forge-dark', label: 'Forge Dark', source: 'built-in' },
    ...enabledExtensions.flatMap((ext) =>
      ext.themes.map((t) => ({ id: t.id, label: t.label, source: ext.displayName })),
    ),
  ];

  const iconThemeOptions: { id: string; label: string; source: string }[] = [
    { id: 'none', label: 'None', source: 'built-in' },
    ...enabledExtensions.flatMap((ext) =>
      (ext.iconThemes || []).map((t) => ({ id: t.id, label: t.label, source: ext.displayName })),
    ),
  ];

  useEffect(() => {
    void checkExtensionUpdates();
  }, [checkExtensionUpdates]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void searchMarketplace(query.trim(), 24);
    }, query.trim() ? 260 : 0);
    return () => window.clearTimeout(timer);
  }, [query, searchMarketplace]);

  const handleInstall = async (id: string) => {
    await installExtensionById(id);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden select-none">
      <div className="h-[35px] flex items-center justify-between px-4 text-[11px] uppercase tracking-wide text-forge-text/70 flex-shrink-0">
        <span>Extensions</span>
        {(extBusy || marketplaceBusy) && <Loader2 size={12} className="animate-spin text-forge-accent" />}
      </div>

      <div className="px-3 pb-2 flex-shrink-0">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-forge-text/45"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Marketplace"
            className="w-full bg-forge-input text-forge-text text-[12px] pl-7 pr-7 py-1.5 rounded outline-none border border-transparent focus:border-forge-accent/60"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              title="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-forge-text/50 hover:text-forge-text"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <button
          onClick={() => void installVsixExtension()}
          disabled={extBusy}
          className="mt-1.5 w-full flex items-center justify-center gap-2 bg-forge-accent/15 hover:bg-forge-accent/25 text-forge-accent text-[12px] rounded px-2 py-1.5 transition-colors disabled:opacity-50"
        >
          {extBusy ? <Loader2 size={13} className="animate-spin" /> : <FileArchive size={13} />}
          Install from VSIX...
        </button>

        <WorkspaceTrustBanner />
        <ExtensionHostStatus />

        {(extError || marketplaceError) && (
          <p className="mt-2 text-[11px] leading-snug text-red-400/90">
            {extError || marketplaceError}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto sidebar-scroll">
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-forge-text/50">
              <Globe size={11} />
              Marketplace
            </div>
            {marketplaceResults.total > 0 && (
              <span className="text-[10px] text-forge-text/35">
                {formatCount(marketplaceResults.total)}
              </span>
            )}
          </div>

          {marketplaceBusy && marketplaceResults.extensions.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-forge-text/50">
              <Loader2 size={15} className="animate-spin" />
              Searching
            </div>
          ) : marketplaceResults.extensions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-forge-text/40">
              <Blocks size={28} />
              <p className="text-[11px]">No extensions found</p>
            </div>
          ) : (
            <div className="space-y-1">
              {marketplaceResults.extensions.map((ext) => {
                const isInstalled = installedIds.has(ext.id);
                const agentCommand = agentCommandForExtension(ext);
                const showImage = ext.iconUrl && !imageErrors.has(ext.id);
                return (
                  <div
                    key={ext.id}
                    onClick={() => openExtensionDetail(ext)}
                    title="Show extension details"
                    className="group flex gap-2 rounded px-2 py-2 hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    <div className="w-8 h-8 rounded bg-forge-input border border-forge-border/60 flex items-center justify-center overflow-hidden flex-shrink-0 text-[13px] text-forge-text/60">
                      {showImage ? (
                        <img
                          src={ext.iconUrl ?? undefined}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={() => {
                            setImageErrors((prev) => new Set(prev).add(ext.id));
                          }}
                        />
                      ) : (
                        extensionInitial(ext)
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] text-forge-text-strong truncate">
                              {ext.displayName}
                            </span>
                            {ext.verified && (
                              <ShieldCheck
                                size={11}
                                className="text-forge-accent flex-shrink-0"
                              />
                            )}
                          </div>
                          <div className="text-[10px] text-forge-text/45 truncate">
                            {ext.namespace}.{ext.name}
                          </div>
                        </div>
                        {agentCommand ? (
                          <button
                            title={`Run ${agentCommand}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              runAgentInTerminal(agentCommand as import('../types').AgentTerminalId);
                            }}
                            className="w-7 h-6 flex items-center justify-center rounded text-forge-accent bg-forge-accent/10 hover:bg-forge-accent/20 flex-shrink-0"
                          >
                            <Terminal size={13} />
                          </button>
                        ) : isInstalled ? (
                          <button
                            title="Installed"
                            disabled
                            className="w-7 h-6 flex items-center justify-center rounded text-forge-accent bg-forge-accent/10 flex-shrink-0"
                          >
                            <PackageCheck size={13} />
                          </button>
                        ) : (
                          <button
                            title="Install"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleInstall(ext.id);
                            }}
                            disabled={extBusy || ext.deprecated}
                            className="w-7 h-6 flex items-center justify-center rounded text-forge-accent bg-forge-accent/10 hover:bg-forge-accent/20 disabled:opacity-40 flex-shrink-0"
                          >
                            {extBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                          </button>
                        )}
                      </div>

                      {ext.description && (
                        <p className="mt-1 text-[11px] leading-snug text-forge-text/60 line-clamp-2">
                          {ext.description}
                        </p>
                      )}
                      {agentCommand && (
                        <p className="mt-1 text-[10px] leading-snug text-forge-accent/80">
                          Runs through Forge terminal agents while extension-host support is built out.
                        </p>
                      )}

                      <div className="mt-1 flex items-center gap-2 text-[10px] text-forge-text/40">
                        <span>v{ext.version}</span>
                        <span>{formatCount(ext.downloadCount)} downloads</span>
                        {ext.averageRating !== null && (
                          <span className="flex items-center gap-0.5">
                            <Star size={10} />
                            {ext.averageRating.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-3 pt-2 pb-3 border-t border-forge-border/40">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-forge-text/50 mb-1.5">
            <Palette size={11} />
            Color Theme
          </div>
          {themeOptions.map((opt) => {
            const isActive = opt.id === activeTheme;
            return (
              <button
                key={opt.id}
                onClick={() => void setColorTheme(opt.id)}
                className={`w-full flex items-center justify-between px-2 py-1 rounded text-[12px] transition-colors
                  ${isActive ? 'bg-forge-accent/15 text-forge-accent' : 'text-forge-text hover:bg-white/5'}`}
              >
                <span className="truncate">{opt.label}</span>
                <span className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                  <span className="text-[10px] text-forge-text/40">{opt.source}</span>
                  {isActive && <Check size={12} />}
                </span>
              </button>
            );
          })}
        </div>

        {iconThemeOptions.length > 1 && (
          <div className="px-3 pt-2 pb-3 border-t border-forge-border/40">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-forge-text/50 mb-1.5">
              <Blocks size={11} />
              Icon Theme
            </div>
            {iconThemeOptions.map((opt) => {
              const isActive = opt.id === (activeIconTheme || 'none');
              return (
                <button
                  key={opt.id}
                  onClick={() => void setIconTheme(opt.id === 'none' ? null : opt.id)}
                  className={`w-full flex items-center justify-between px-2 py-1 rounded text-[12px] transition-colors
                    ${isActive ? 'bg-forge-accent/15 text-forge-accent' : 'text-forge-text hover:bg-white/5'}`}
                >
                  <span className="truncate">{opt.label}</span>
                  <span className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                    <span className="text-[10px] text-forge-text/40">{opt.source}</span>
                    {isActive && <Check size={12} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="px-3 pt-2 pb-4 border-t border-forge-border/40">
          <div className="text-[11px] uppercase tracking-wide text-forge-text/50 mb-1.5">
            Installed ({installedExtensions.length})
          </div>

          {installedExtensions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-forge-text/40">
              <Blocks size={28} />
              <p className="text-[11px]">No extensions installed</p>
            </div>
          ) : (
            installedExtensions.map((ext) => {
              const { label: runtimeLabel, tone: runtimeTone } = extensionRuntimeLabel(ext);
              const activeCaps = ext.compatibility.supportedContributions;
              const pendingCaps = ext.compatibility.pendingContributions;
              const agentCmd = agentCommandForInstalledExtension(ext);
              const fmtCmd = formatterCliCommand(ext);
              const latestVersion = extensionUpdates[ext.id];

              return (
                <div
                  key={ext.id}
                  className="group rounded px-2 py-1.5 hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-forge-text-strong truncate">
                      {ext.displayName}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* Agent terminal launch button */}
                      {agentCmd && (
                        <button
                          title={`Launch ${agentCmd} in terminal`}
                          onClick={() => runAgentInTerminal(agentCmd as AgentTerminalId)}
                          className="w-6 h-6 flex items-center justify-center rounded text-blue-300 bg-blue-400/10 hover:bg-blue-400/20 transition-colors"
                        >
                          <Terminal size={13} />
                        </button>
                      )}
                      {/* Formatter run button */}
                      {fmtCmd && !agentCmd && (
                        <button
                          title={`Run: ${fmtCmd}`}
                          onClick={() => runAgentInTerminal(null as unknown as AgentTerminalId)}
                          className="w-6 h-6 flex items-center justify-center rounded text-emerald-300 bg-emerald-400/10 hover:bg-emerald-400/20 transition-colors"
                        >
                          <Play size={12} />
                        </button>
                      )}
                      {latestVersion && (
                        <button
                          title={`Update to v${latestVersion}`}
                          onClick={() => void updateExtension(ext.id)}
                          disabled={extBusy}
                          className="w-6 h-6 flex items-center justify-center rounded text-amber-300 bg-amber-400/10 hover:bg-amber-400/20 transition-colors flex-shrink-0 disabled:opacity-30"
                        >
                          <Download size={13} />
                        </button>
                      )}
                      {ext.previousVersion && (
                        <button
                          title={`Roll back to v${ext.previousVersion}`}
                          onClick={() => void rollbackExtension(ext.id)}
                          disabled={extBusy}
                          className="opacity-0 group-hover:opacity-70 hover:!opacity-100 w-6 h-6 flex items-center justify-center rounded text-forge-text hover:bg-white/10 transition-colors flex-shrink-0 disabled:opacity-30"
                        >
                          <History size={13} />
                        </button>
                      )}
                      <button
                        title={ext.enabled === false ? 'Enable extension' : 'Disable extension'}
                        onClick={() => void setExtensionEnabled(ext.id, ext.enabled === false)}
                        className={`w-6 h-6 flex items-center justify-center rounded transition-colors flex-shrink-0 ${
                          ext.enabled === false
                            ? 'text-forge-text/40 hover:text-forge-accent hover:bg-forge-accent/10'
                            : 'opacity-0 group-hover:opacity-70 hover:!opacity-100 text-forge-text'
                        }`}
                      >
                        <Power size={13} />
                      </button>
                      <button
                        title="Uninstall"
                        onClick={() => void uninstallExtension(ext.id)}
                        className="opacity-0 group-hover:opacity-70 hover:!opacity-100 text-forge-text flex-shrink-0"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Runtime label + publisher info */}
                  <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide flex-shrink-0 ${runtimeTone}`}>
                      {runtimeLabel}
                    </span>
                    <span className="text-[10px] text-forge-text/45 truncate">
                      {ext.publisher} · v{ext.version}
                    </span>
                  </div>

                  {/* Agent hint */}
                  {agentCmd && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-blue-300/80">
                      <Terminal size={10} className="flex-shrink-0" />
                      <span>Launch <code className="px-1 py-0.5 rounded bg-blue-400/10 font-mono text-[9px]">{agentCmd}</code> in Forge terminal</span>
                    </div>
                  )}

                  {/* Formatter hint */}
                  {fmtCmd && !agentCmd && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-emerald-300/70">
                      <Code2 size={10} className="flex-shrink-0" />
                      <span>CLI: <code className="px-1 py-0.5 rounded bg-emerald-400/10 font-mono text-[9px]">{fmtCmd}</code></span>
                    </div>
                  )}

                  {/* Contribution badges — active vs pending */}
                  {(activeCaps.length > 0 || pendingCaps.length > 0) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {activeCaps.map((cap) => (
                        <span
                          key={cap}
                          title={`${cap} — active`}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-forge-accent/10 text-forge-accent border border-forge-accent/20"
                        >
                          <Check size={8} className="flex-shrink-0" />
                          {cap}
                        </span>
                      ))}
                      {pendingCaps.map((cap) => (
                        <span
                          key={cap}
                          title={`${cap} — ${pendingContributionReason(ext, cap)}`}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-forge-input/60 text-forge-text/40 border border-forge-border/40"
                        >
                          <AlertTriangle size={8} className="flex-shrink-0" />
                          {cap}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Activation / entry-point details (collapsed) */}
                  {(ext.main || ext.browser || ext.activationEvents.length > 0) && (
                    <div className="mt-0.5 text-[10px] text-forge-text/35 truncate">
                      {ext.main && `main: ${ext.main}`}
                      {ext.browser && `${ext.main ? ' · ' : ''}browser: ${ext.browser}`}
                      {ext.activationEvents.length > 0 &&
                        `${ext.main || ext.browser ? ' · ' : ''}${ext.activationEvents.length} activation event${ext.activationEvents.length === 1 ? '' : 's'}`}
                    </div>
                  )}
                </div>
              );
            })

          )}
        </div>
      </div>
    </div>
  );
}
