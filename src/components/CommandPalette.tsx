import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';
import type { Command } from '../types';
import { buildCommands, categoryOrder } from '../commandRegistry';
import { contextKeys } from '../extensions/contextKeys';
import { extensionCommandService } from '../extensions/registry';
import { fuzzyMatchCommand } from '../utils/fuzzy';
import { loadRecentCommandIds, recordRecentCommand } from '../utils/recentCommands';
import {
  Bot,
  Boxes,
  Clock,
  Command as CommandIcon,
  FileSearch,
  GitBranch,
  Package,
  PanelBottom,
  Play,
  Search,
  Settings,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';

interface DisplayGroup {
  category: string;
  commands: Command[];
}

function iconForCategory(category: string): LucideIcon {
  switch (category) {
    case 'Recently Used': return Clock;
    case 'File': return Search;
    case 'View': return PanelBottom;
    case 'Git': return GitBranch;
    case 'Terminal': return TerminalSquare;
    case 'Run': return Package;
    case 'Live Server': return Play;
    case 'AI': return Sparkles;
    case 'Agent': return Bot;
    case 'Extensions': return Boxes;
    case 'Preferences': return Settings;
    default: return CommandIcon;
  }
}

export default function CommandPalette() {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePanel = useStore((s) => s.togglePanel);
  const openFolder = useStore((s) => s.openFolder);
  const saveFile = useStore((s) => s.saveFile);
  const setSidebarPanel = useStore((s) => s.setSidebarPanel);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);
  const runCommandInTerminal = useStore((s) => s.runCommandInTerminal);
  const runAgentInTerminal = useStore((s) => s.runAgentInTerminal);
  const installVsixExtension = useStore((s) => s.installVsixExtension);
  const installExtensionById = useStore((s) => s.installExtensionById);
  const setColorTheme = useStore((s) => s.setColorTheme);
  const installedExtensions = useStore((s) => s.installedExtensions);
  const hostState = useStore((s) => s.extensionHostState);
  const safeMode = useStore((s) => s.safeMode);
  const restartExtensionHost = useStore((s) => s.restartExtensionHost);
  const setSafeMode = useStore((s) => s.setSafeMode);
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const workspacePath = useStore((s) => s.workspacePath);
  const gitChanges = useStore((s) => s.gitChanges);
  const gitIsRepo = useStore((s) => s.gitIsRepo);
  const toggleLiveServer = useStore((s) => s.toggleLiveServer);
  const autoSave = useStore((s) => s.autoSave);
  const setAutoSave = useStore((s) => s.setAutoSave);
  const formatOnSave = useStore((s) => s.formatOnSave);
  const setFormatOnSave = useStore((s) => s.setFormatOnSave);
  const wordWrap = useStore((s) => s.wordWrap);
  const setWordWrap = useStore((s) => s.setWordWrap);
  const minimapEnabled = useStore((s) => s.minimapEnabled);
  const setMinimapEnabled = useStore((s) => s.setMinimapEnabled);
  const toggleActiveGitDiffMode = useStore((s) => s.toggleActiveGitDiffMode);
  const openGitDiff = useStore((s) => s.openGitDiff);

  const activeTab = openTabs.find((tab) => tab.id === activeTabId);

  const close = useCallback(() => setCommandPaletteOpen(false), [setCommandPaletteOpen]);

  const themeCommands: Command[] = useMemo(
    () =>
      installedExtensions.flatMap((ext) =>
        ext.themes.map((t) => ({
          id: `theme-${t.id}`,
          label: `Color Theme — ${t.label}`,
          category: 'Preferences',
          keywords: ['theme', t.label],
          action: () => {
            void setColorTheme(t.id);
            close();
          },
        })),
      ),
    [installedExtensions, setColorTheme, close],
  );

  const allCommands = useMemo(
    () =>
      buildCommands({
        activeTab,
        workspacePath,
        gitChanges,
        gitIsRepo,
        installedExtensionThemeCount: themeCommands.length,
        autoSave,
        formatOnSave,
        wordWrap,
        minimapEnabled,
        close,
        openFolder,
        saveFile,
        setQuickOpenOpen,
        toggleSidebar,
        togglePanel,
        setSidebarPanel,
        setBottomTab,
        toggleAIPanel,
        runCommandInTerminal,
        installVsixExtension,
        installExtensionById,
        setColorTheme,
        toggleLiveServer,
        toggleActiveGitDiffMode,
        runAgentInTerminal,
        openGitDiff,
        setAutoSave,
        setFormatOnSave,
        setWordWrap,
        setMinimapEnabled,
        themeCommands,
      }),
    [
      activeTab,
      workspacePath,
      gitChanges,
      gitIsRepo,
      autoSave,
      formatOnSave,
      wordWrap,
      minimapEnabled,
      themeCommands,
      close,
      openFolder,
      saveFile,
      setQuickOpenOpen,
      toggleSidebar,
      togglePanel,
      setSidebarPanel,
      setBottomTab,
      toggleAIPanel,
      runCommandInTerminal,
      installVsixExtension,
      installExtensionById,
      setColorTheme,
      toggleLiveServer,
      toggleActiveGitDiffMode,
      runAgentInTerminal,
      setAutoSave,
      setFormatOnSave,
      setWordWrap,
      setMinimapEnabled,
    ],
  );

  // Declarative commands from enabled extensions, gated by their
  // `enablement` when-clauses. Running one reaches the Extension Host,
  // which activates the owning extension on demand; a command nobody
  // registers or declares `onCommand:` for is still a reported no-op.
  const extensionCommandEntries: Command[] = useMemo(
    () =>
      installedExtensions
        .filter((ext) => ext.enabled !== false)
        .flatMap((ext) =>
          (ext.commands ?? [])
            .filter((cmd) => contextKeys.match(cmd.enablement))
            .map((cmd) => ({
              id: `ext-cmd-${cmd.command}`,
              label: cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title,
              category: 'Extensions',
              keywords: [cmd.command, ext.displayName],
              action: () => {
                extensionCommandService.execute(cmd.command);
                close();
              },
            })),
        ),
    [installedExtensions, close],
  );

  // Extension Host controls. They live here, not in `buildCommands`,
  // because they only make sense while there is a host to talk to — and
  // Safe Mode must stay reachable from the palette precisely when the
  // panel is the thing an extension broke.
  const hostCommandEntries: Command[] = useMemo(() => {
    if (!hostState) return [];
    const entries: Command[] = [{
      id: 'ext-host-restart',
      label: 'Extensions: Restart Extension Host',
      category: 'Extensions',
      keywords: ['host', 'reiniciar', 'restart'],
      action: () => {
        void restartExtensionHost();
        close();
      },
    }];

    if (safeMode.active) {
      if (safeMode.canDisable) {
        entries.push({
          id: 'ext-host-safe-mode-off',
          label: 'Extensions: Exit Safe Mode',
          category: 'Extensions',
          keywords: ['safe', 'seguro', 'extensiones'],
          action: () => {
            void setSafeMode(false);
            close();
          },
        });
      }
    } else {
      entries.push({
        id: 'ext-host-safe-mode-on',
        label: 'Extensions: Start With Extensions Disabled (Safe Mode)',
        category: 'Extensions',
        keywords: ['safe', 'seguro', 'disable', 'deshabilitar'],
        action: () => {
          void setSafeMode(true, 'Activado desde la paleta de comandos.');
          close();
        },
      });
    }
    return entries;
  }, [hostState, safeMode, restartExtensionHost, setSafeMode, close]);

  const paletteCommands = useMemo(
    () => [...allCommands, ...extensionCommandEntries, ...hostCommandEntries],
    [allCommands, extensionCommandEntries, hostCommandEntries],
  );

  const commandMap = useMemo(
    () => new Map(paletteCommands.map((cmd) => [cmd.id, cmd])),
    [paletteCommands],
  );

  const groups: DisplayGroup[] = useMemo(() => {
    const extInstall = query.trim().match(/^ext\s+install(?:\s+(\S*))?$/i);
    if (extInstall) {
      const id = extInstall[1] ?? '';
      return [{
        category: 'Extensions',
        commands: [{
          id: 'ext-install-openvsx',
          label: id
            ? `Install '${id}' from Open VSX`
            : 'Install from Open VSX — escribe publisher.nombre',
          category: 'Extensions',
          action: () => {
            if (!id) return;
            void installExtensionById(id);
            close();
          },
        }],
      }];
    }

    const trimmed = query.trim();
    if (!trimmed) {
      const recentIds = loadRecentCommandIds();
      const recent = recentIds
        .map((id) => commandMap.get(id))
        .filter((cmd): cmd is Command => Boolean(cmd));

      const contextualIds = new Set([
        'ctx-git-diff',
        'ctx-live-server',
        'ctx-save-active',
        'git-toggle-diff',
      ]);
      const contextual = paletteCommands.filter((cmd) => contextualIds.has(cmd.id));
      const contextualSet = new Set(contextual.map((c) => c.id));

      const byCategory = new Map<string, Command[]>();
      for (const cmd of contextual) {
        const cat = cmd.category || 'Contextual';
        const list = byCategory.get(cat) ?? [];
        list.push(cmd);
        byCategory.set(cat, list);
      }
      for (const cmd of paletteCommands) {
        if (contextualSet.has(cmd.id)) continue;
        if (recent.some((r) => r.id === cmd.id)) continue;
        const cat = cmd.category || 'Other';
        const list = byCategory.get(cat) ?? [];
        list.push(cmd);
        byCategory.set(cat, list);
      }

      const result: DisplayGroup[] = [];
      if (recent.length > 0) result.push({ category: 'Recently Used', commands: recent });
      for (const [category, commands] of [...byCategory.entries()].sort(
        (a, b) => categoryOrder(a[0]) - categoryOrder(b[0]),
      )) {
        result.push({ category, commands });
      }
      return result;
    }

    const scored = paletteCommands
      .map((cmd) => ({
        cmd,
        score: fuzzyMatchCommand(cmd.label, trimmed, [
          ...(cmd.keywords ?? []),
          cmd.category ?? '',
        ]),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return [{ category: 'Results', commands: scored.map((s) => s.cmd) }];
  }, [query, paletteCommands, commandMap, installExtensionById, close]);

  const flatCommands = useMemo(
    () => groups.flatMap((g) => g.commands),
    [groups],
  );

  useEffect(() => { setSelectedIndex(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const runCommand = (cmd: Command) => {
    recordRecentCommand(cmd.id);
    cmd.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, flatCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flatCommands[selectedIndex]) runCommand(flatCommands[selectedIndex]);
    }
  };

  let flatIndex = 0;

  return (
    <div
      className="command-palette-overlay fixed inset-0 z-50 flex justify-center pt-[72px]"
      onClick={close}
    >
      <div
        className="w-[720px] max-w-[calc(100vw-32px)] max-h-[560px] bg-forge-sidebar border border-white/10 rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-white/[0.07] bg-white/[0.025]">
          <input
            ref={inputRef}
            type="text"
            className="w-full bg-forge-input text-forge-text text-[14px] px-3 py-2 rounded-md outline-none border border-forge-accent/45 focus:border-forge-accent"
            placeholder="Search commands… (try: git, save, theme, ext install publisher.name)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="flex-1 overflow-y-auto sidebar-scroll py-1">
          {flatCommands.length === 0 ? (
            <div className="px-4 py-6 text-center text-forge-text/60 text-sm">
              No matching commands
            </div>
          ) : (
            groups.map((group) => {
              const CategoryIcon = iconForCategory(group.category);
              return (
                <div key={group.category} className="mb-1">
                  <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-forge-text/40 flex items-center gap-1.5 sticky top-0 bg-forge-sidebar/95 backdrop-blur-sm z-10">
                    <CategoryIcon size={11} />
                    {group.category}
                  </div>
                  {group.commands.map((cmd) => {
                    const idx = flatIndex++;
                    const Icon = iconForCategory(cmd.category || 'Other');
                    return (
                      <div
                        key={cmd.id}
                        onClick={() => runCommand(cmd)}
                        className={`flex items-center justify-between px-4 py-2 cursor-pointer text-[13px] transition-colors mx-1 rounded-md
                          ${idx === selectedIndex
                            ? 'bg-forge-accent/15 text-forge-accent'
                            : 'text-forge-text hover:bg-white/5'}
                        `}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Icon size={15} className="flex-shrink-0 opacity-85" />
                          <span className="truncate">{cmd.label}</span>
                        </div>
                        {cmd.shortcut && (
                          <span className="text-forge-text/50 text-[11px] ml-4 flex-shrink-0 font-mono">
                            {cmd.shortcut}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
