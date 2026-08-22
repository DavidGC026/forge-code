import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
import { useStore } from '../store';
import {
  AlertTriangle,
  Blocks,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Command,
  FileCode2,
  Files,
  FolderOpen,
  GitBranch,
  Globe,
  Pin,
  Play,
  Save,
  Search,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
  X,
} from 'lucide-react';
import type { editor } from 'monaco-editor';
import logoUrl from '../assets/dvg-logo.jpg';
import { lspClient, getLspLanguageId } from '../lsp/client';
import {
  documentSyncService,
  editorSyncService,
  attachMonaco as attachExtensionMonaco,
  isThemeAvailable,
} from '../extensions/registry';
import { buildEditorLayout } from '../extensions/documentSync';
import ImageViewer from './ImageViewer';
import GitDiffEditor from './GitDiffEditor';
import ExtensionDetailView from './ExtensionDetailView';
import type { Tab, TreeNode } from '../types';
import { runEditorAIAction, type EditorAIActionKind } from '../ai/quickActions';

function toFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(normalized);
}

// ─────────────────────────────────────────────────────────────────────────
// Workbench home / editor chrome
// ─────────────────────────────────────────────────────────────────────────

function flattenFiles(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (items: TreeNode[]) => {
    for (const item of items) {
      if (item.type === 'file') out.push(item);
      if (item.children) walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

function relativePath(workspacePath: string | null, filePath: string): string {
  if (!workspacePath) return filePath;
  const normalizedWorkspace = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFile = filePath.replace(/\\/g, '/');
  if (!normalizedFile.startsWith(`${normalizedWorkspace}/`)) return filePath;
  return normalizedFile.slice(normalizedWorkspace.length + 1);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function WorkspaceHome() {
  const openFolder = useStore((s) => s.openFolder);
  const workspacePath = useStore((s) => s.workspacePath);
  const workspaceName = useStore((s) => s.workspaceName);
  const fileTree = useStore((s) => s.fileTree);
  const openFile = useStore((s) => s.openFile);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const setSidebarPanel = useStore((s) => s.setSidebarPanel);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);
  const runCommandInTerminal = useStore((s) => s.runCommandInTerminal);
  const gitIsRepo = useStore((s) => s.gitIsRepo);
  const gitBranch = useStore((s) => s.gitBranch);
  const gitChanges = useStore((s) => s.gitChanges);
  const problems = useStore((s) => s.problems);
  const installedExtensions = useStore((s) => s.installedExtensions);
  const liveServerActive = useStore((s) => s.liveServerActive);

  const files = useMemo(() => flattenFiles(fileTree), [fileTree]);
  const folders = useMemo(() => {
    let count = 0;
    const walk = (items: TreeNode[]) => {
      for (const item of items) {
        if (item.type === 'directory') count += 1;
        if (item.children) walk(item.children);
      }
    };
    walk(fileTree);
    return count;
  }, [fileTree]);

  const recentFiles = files
    .filter((file) => !file.path.includes('/node_modules/') && !file.path.includes('\\node_modules\\'))
    .slice(0, 7);
  const hasPackageJson = files.some((file) => file.name === 'package.json');
  const errorCount = problems.filter((p) => p.severity === 1).length;
  const warningCount = problems.filter((p) => p.severity === 2).length;

  const primaryActions = [
    {
      label: 'Quick Open',
      icon: Search,
      action: () => setQuickOpenOpen(true),
      disabled: !workspacePath,
    },
    {
      label: 'Command Palette',
      icon: Command,
      action: () => setCommandPaletteOpen(true),
      disabled: false,
    },
    {
      label: 'Source Control',
      icon: GitBranch,
      action: () => setSidebarPanel('git'),
      disabled: !workspacePath,
    },
    {
      label: 'Run & Debug',
      icon: Play,
      action: () => setSidebarPanel('debug'),
      disabled: !workspacePath,
    },
    {
      label: 'Terminal',
      icon: TerminalSquare,
      action: () => setBottomTab('terminal'),
      disabled: false,
    },
    {
      label: 'AI Panel',
      icon: Bot,
      action: () => toggleAIPanel(),
      disabled: false,
    },
  ];

  return (
    <div className="forge-home w-full h-full overflow-auto sidebar-scroll select-none">
      <div className="min-h-full max-w-[1180px] mx-auto px-8 py-8 flex flex-col gap-7">
        <section className="forge-home-hero">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-5">
              <img src={logoUrl} alt="DVG" className="w-10 h-10 object-contain" />
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-forge-accent/80">
                  DVG Workbench
                </p>
                <h1 className="text-[34px] leading-tight font-semibold text-forge-text-strong">
                  {workspaceName || 'Code without ceremony'}
                </h1>
              </div>
            </div>
            <p className="max-w-[760px] text-[14px] leading-6 text-forge-text/72">
              {workspacePath
                ? workspacePath
                : 'Open a workspace to start building with Git, terminal, LSP diagnostics, marketplace themes and integrated agents in one focused surface.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => openFolder()}
              className="forge-primary-button"
            >
              <FolderOpen size={16} />
              Open Folder
            </button>
            {hasPackageJson && (
              <button
                onClick={() => runCommandInTerminal('pnpm dev')}
                className="forge-secondary-button"
              >
                <Play size={15} />
                pnpm dev
              </button>
            )}
          </div>
        </section>

        <section className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <MetricTile icon={Files} label="Files" value={formatNumber(files.length)} />
          <MetricTile icon={Boxes} label="Folders" value={formatNumber(folders)} />
          <MetricTile
            icon={GitBranch}
            label={gitIsRepo ? gitBranch || 'Git' : 'Git'}
            value={gitIsRepo ? `${gitChanges.length} changes` : 'No repo'}
            tone={gitChanges.length > 0 ? 'warn' : 'ok'}
          />
          <MetricTile
            icon={errorCount > 0 ? AlertTriangle : CheckCircle2}
            label="Problems"
            value={`${errorCount} errors · ${warningCount} warnings`}
            tone={errorCount > 0 ? 'danger' : warningCount > 0 ? 'warn' : 'ok'}
          />
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-4 min-h-0">
          <div className="forge-panel">
            <div className="forge-panel-header">
              <div>
                <h2>Project</h2>
                <p>{workspaceName ? 'Workspace files' : 'No workspace open'}</p>
              </div>
              <button
                onClick={() => setQuickOpenOpen(true)}
                disabled={!workspacePath}
                className="forge-icon-text-button"
              >
                <Search size={14} />
                Find
              </button>
            </div>

            {workspacePath ? (
              <div className="divide-y divide-white/[0.06]">
                {recentFiles.length > 0 ? (
                  recentFiles.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => void openFile(file)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.04] transition-colors"
                    >
                      <FileCode2 size={16} className="text-forge-accent/85 flex-shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-forge-text">
                        {relativePath(workspacePath, file.path)}
                      </span>
                      <ChevronRight size={14} className="text-forge-text/32" />
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-8 text-sm text-forge-text/58">No files found.</div>
                )}
              </div>
            ) : (
              <div className="px-4 py-8 flex flex-col gap-3">
                <button onClick={() => openFolder()} className="forge-wide-action">
                  <FolderOpen size={16} />
                  Open workspace
                </button>
                <button onClick={() => setCommandPaletteOpen(true)} className="forge-wide-action">
                  <Command size={16} />
                  Command palette
                </button>
              </div>
            )}
          </div>

          <div className="forge-panel">
            <div className="forge-panel-header">
              <div>
                <h2>Control Center</h2>
                <p>{liveServerActive ? 'Live server running' : `${installedExtensions.length} extensions installed`}</p>
              </div>
              <Sparkles size={17} className="text-forge-accent" />
            </div>
            <div className="grid grid-cols-2 gap-2 p-3">
              {primaryActions.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.label}
                    onClick={item.action}
                    disabled={item.disabled}
                    className="forge-command-tile"
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
}) {
  const toneClass = {
    neutral: 'text-[#9DB5FF]',
    ok: 'text-forge-accent',
    warn: 'text-[#F3C969]',
    danger: 'text-[#FF6B6B]',
  }[tone];

  return (
    <div className="forge-metric-tile">
      <Icon size={18} className={toneClass} />
      <div className="min-w-0">
        <p className="truncate">{label}</p>
        <strong className="truncate">{value}</strong>
      </div>
    </div>
  );
}

function EditorToolbar() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const workspacePath = useStore((s) => s.workspacePath);
  const saveFile = useStore((s) => s.saveFile);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const toggleLiveServer = useStore((s) => s.toggleLiveServer);
  const problems = useStore((s) => s.problems);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  if (!activeTab || activeTab.gitDiff || activeTab.extension) return null;

  const rel = relativePath(workspacePath, activeTab.path);
  const crumbs = rel.split('/').filter(Boolean);
  const fileProblems = problems.filter((p) => p.filePath === activeTab.path);
  const errorCount = fileProblems.filter((p) => p.severity === 1).length;
  const warningCount = fileProblems.filter((p) => p.severity === 2).length;

  return (
    <div className="h-[34px] bg-forge-editor/95 border-b border-forge-border/70 flex items-center justify-between px-3 select-none">
      <div className="min-w-0 flex items-center gap-1 text-[12px] text-forge-text/60">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <span key={`${crumb}-${index}`} className="flex items-center min-w-0">
              <span className={`truncate max-w-[180px] ${isLast ? 'text-forge-text font-medium' : ''}`}>
                {crumb}
              </span>
              {!isLast && <ChevronRight size={13} className="mx-1 text-forge-text/28 flex-shrink-0" />}
            </span>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="hidden lg:flex items-center gap-1.5 text-[11px] text-forge-text/54 mr-2">
          {activeTab.isUnsaved ? 'Unsaved' : 'Saved'}
          <span className="w-1 h-1 rounded-full bg-forge-text/30" />
          {activeTab.language}
          {fileProblems.length > 0 && (
            <>
              <span className="w-1 h-1 rounded-full bg-forge-text/30" />
              <span className={errorCount > 0 ? 'text-[#FF6B6B]' : 'text-[#F3C969]'}>
                {errorCount}E {warningCount}W
              </span>
            </>
          )}
        </span>
        <button className="forge-toolbar-button" title="Save" onClick={() => void saveFile(activeTab.id)}>
          <Save size={14} />
        </button>
        <button className="forge-toolbar-button" title="Live Server" onClick={() => void toggleLiveServer(activeTab.path)}>
          <Globe size={14} />
        </button>
        <button className="forge-toolbar-button" title="Terminal" onClick={() => setBottomTab('terminal')}>
          <TerminalSquare size={14} />
        </button>
        <button className="forge-toolbar-button" title="Command Palette" onClick={() => setCommandPaletteOpen(true)}>
          <Command size={14} />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tab Bar — no icons; active text uses the brick accent
// ─────────────────────────────────────────────────────────────────────────
function relativizePath(workspacePath: string | null, fullPath: string): string {
  if (!workspacePath) return fullPath;
  const norm = fullPath.replace(/\\/g, '/');
  const ws = workspacePath.replace(/\\/g, '/');
  return norm.startsWith(ws + '/') ? norm.slice(ws.length + 1) : fullPath;
}

function TabContextMenu({
  x,
  y,
  tab,
  onClose,
}: {
  x: number;
  y: number;
  tab: Tab;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const item = (label: string, action: () => void) => (
    <div className="context-menu-item" onClick={() => { action(); onClose(); }}>
      {label}
    </div>
  );

  const { closeTab, closeOtherTabs, closeAllTabs, closeSavedTabs, togglePinTab, workspacePath } =
    useStore.getState();
  const isRealFile = !tab.gitDiff && !tab.extension;

  return (
    <div
      ref={ref}
      className="context-menu fixed z-50"
      style={{ top: y, left: x }}
      onClick={(e) => e.stopPropagation()}
    >
      {item(tab.pinned ? 'Unpin Tab' : 'Pin Tab', () => togglePinTab(tab.id))}
      <div className="context-menu-divider" />
      {item('Close', () => closeTab(tab.id))}
      {item('Close Others', () => closeOtherTabs(tab.id))}
      {item('Close Saved', () => closeSavedTabs())}
      {item('Close All', () => closeAllTabs())}
      {isRealFile && (
        <>
          <div className="context-menu-divider" />
          {item('Copy Path', () => void navigator.clipboard.writeText(tab.path))}
          {item('Copy Relative Path', () =>
            void navigator.clipboard.writeText(relativizePath(workspacePath, tab.path)),
          )}
          {item('Reveal in File Manager', () =>
            void window.electronAPI.revealInFolder(tab.path),
          )}
        </>
      )}
    </div>
  );
}

function TabBar() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const togglePinTab = useStore((s) => s.togglePinTab);
  const moveTab = useStore((s) => s.moveTab);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceIdRef = useRef<string | null>(null);

  if (openTabs.length === 0) return null;

  return (
    <div className="h-[35px] bg-forge-tabbar flex items-end overflow-x-auto select-none">
      {openTabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isDragTarget = dragOverId === tab.id && dragSourceIdRef.current !== tab.id;
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={(e) => {
              dragSourceIdRef.current = tab.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', tab.id);
            }}
            onDragOver={(e) => {
              if (!dragSourceIdRef.current) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOverId(tab.id);
            }}
            onDragLeave={() => {
              setDragOverId((id) => (id === tab.id ? null : id));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const sourceId = dragSourceIdRef.current || e.dataTransfer.getData('text/plain');
              if (sourceId) moveTab(sourceId, tab.id);
              dragSourceIdRef.current = null;
              setDragOverId(null);
            }}
            onDragEnd={() => {
              dragSourceIdRef.current = null;
              setDragOverId(null);
            }}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => {
              // Middle click closes the tab, like every browser/editor.
              if (e.button === 1) {
                e.preventDefault();
                closeTab(tab.id);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, tab });
            }}
            className={`group flex items-center h-[35px] px-3 gap-2 cursor-pointer min-w-0 max-w-[220px] border-r border-black/30 transition-colors
              ${isActive
                ? 'bg-forge-tab-active'
                : 'bg-forge-tabbar hover:bg-white/[0.03]'}
              ${isDragTarget ? 'shadow-[inset_2px_0_0_0_#E52E3D]' : ''}
            `}
          >
            {tab.isUnsaved && !tab.gitDiff && (
              <div className="w-[7px] h-[7px] rounded-full bg-forge-text/70 flex-shrink-0" />
            )}
            {tab.gitDiff && (
              <GitBranch size={12} className="text-forge-accent flex-shrink-0" />
            )}
            {tab.extension && (
              <Blocks size={12} className="text-forge-accent flex-shrink-0" />
            )}

            <span
              className="truncate text-[13px]"
              style={{ color: isActive ? '#E52E3D' : '#96969D' }}
            >
              {tab.name}
            </span>

            {tab.pinned ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePinTab(tab.id);
                }}
                title="Unpin"
                className="p-0.5 flex-shrink-0 opacity-70 hover:opacity-100"
                style={{ color: isActive ? '#E52E3D' : '#96969D' }}
              >
                <Pin size={12} />
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className={`tab-close p-0.5 flex-shrink-0
                  ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'}
                `}
                style={{ color: isActive ? '#96969D' : '#96969D' }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
      {ctxMenu && (
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          tab={ctxMenu.tab}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Custom Monaco Theme — "forge-dark"
// ─────────────────────────────────────────────────────────────────────────
function defineForgeTheme(monaco: typeof import('monaco-editor')) {
  // Forge-dark theme — brick-red primary palette.
  // Color reference:
  //   Crimson  #E52E3D — primary accent / cursor / active editor chrome
  //   Clay     #D06A55 — keywords / HTML tags / control flow
  //   Rose     #C98575 — strings / attribute values / properties
  //   Light    #ABB2BF — variables / identifiers / default text
  //   Gray     #5C6370 — comments
  //   Teal     #73C6B6 — functions / methods (cool contrast)
  //   Orange   #D19A66 — numbers / constants
  //   Yellow-2 #E5C07B — types / classes (warm contrast)
  //   White    #D0D3DA — operators / punctuation / delimiters
  monaco.editor.defineTheme('forge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Default text
      { token: '', foreground: 'ABB2BF', background: '2B2D35' },

      // Comments — gray (kept neutral for contrast)
      { token: 'comment', foreground: '5C6370', fontStyle: 'italic' },
      { token: 'comment.html', foreground: '5C6370', fontStyle: 'italic' },
      { token: 'comment.block', foreground: '5C6370', fontStyle: 'italic' },
      { token: 'comment.line', foreground: '5C6370', fontStyle: 'italic' },

      // Keywords — clay red (control flow, declarations)
      { token: 'keyword', foreground: 'D06A55' },
      { token: 'keyword.control', foreground: 'D06A55' },
      { token: 'keyword.operator', foreground: 'D0D3DA' },
      { token: 'storage', foreground: 'D06A55' },
      { token: 'storage.type', foreground: 'D06A55' },
      { token: 'storage.modifier', foreground: 'D06A55' },

      // HTML / XML / template tags — clay red
      { token: 'tag', foreground: 'D06A55' },
      { token: 'tag.html', foreground: 'D06A55' },
      { token: 'tag.xml', foreground: 'D06A55' },
      { token: 'metatag', foreground: 'D06A55' },
      { token: 'metatag.content.html', foreground: 'D06A55' },
      { token: 'metatag.html', foreground: 'D06A55' },
      { token: 'metatag.xml', foreground: 'D06A55' },

      // Attributes / properties / keys — softer rose brick
      { token: 'attribute.name', foreground: 'C98575' },
      { token: 'attribute.name.html', foreground: 'C98575' },
      { token: 'tag.attribute.name', foreground: 'C98575' },
      { token: 'attribute.name.css', foreground: 'C98575' },
      { token: 'property', foreground: 'C98575' },
      { token: 'property.json', foreground: 'C98575' },
      { token: 'key', foreground: 'C98575' },
      { token: 'key.json', foreground: 'C98575' },

      // Strings / attribute values — softer rose brick
      { token: 'string', foreground: 'C98575' },
      { token: 'string.html', foreground: 'C98575' },
      { token: 'string.value', foreground: 'C98575' },
      { token: 'string.quote', foreground: 'C98575' },
      { token: 'string.escape', foreground: 'C98575' },
      { token: 'attribute.value', foreground: 'C98575' },
      { token: 'attribute.value.html', foreground: 'C98575' },
      { token: 'attribute.value.xml', foreground: 'C98575' },
      { token: 'string.value.json', foreground: 'C98575' },
      { token: 'regexp', foreground: 'C98575' },

      // Template / delimiters — neutral white (so red tokens pop)
      // (covers Liquid/Jinja {% %} {{ }} as well as generic delimiters)
      { token: 'delimiter', foreground: 'D0D3DA' },
      { token: 'delimiter.html', foreground: 'D0D3DA' },
      { token: 'delimiter.xml', foreground: 'D0D3DA' },
      { token: 'delimiter.bracket', foreground: 'D0D3DA' },
      { token: 'delimiter.parenthesis', foreground: 'D0D3DA' },
      { token: 'delimiter.square', foreground: 'D0D3DA' },
      { token: 'delimiter.curly', foreground: 'D0D3DA' },
      { token: 'delimiter.angle', foreground: 'D0D3DA' },
      { token: 'delimiter.template', foreground: 'D06A55' },
      { token: 'meta.tag.template', foreground: 'D06A55' },
      { token: 'string.template', foreground: 'C98575' },
      { token: 'punctuation.definition.template', foreground: 'D06A55' },

      // Variables / identifiers — light (keep readable for contrast)
      { token: 'identifier', foreground: 'ABB2BF' },
      { token: 'variable', foreground: 'ABB2BF' },
      { token: 'variable.parameter', foreground: 'ABB2BF' },
      { token: 'variable.other', foreground: 'ABB2BF' },
      { token: 'variable.predefined', foreground: 'ABB2BF' },

      // Functions / methods — cool contrast against the brick palette
      { token: 'function', foreground: '73C6B6' },
      { token: 'support.function', foreground: '73C6B6' },
      { token: 'entity.name.function', foreground: '73C6B6' },
      { token: 'method', foreground: '73C6B6' },

      // Numbers — orange (warm contrast)
      { token: 'number', foreground: 'D19A66' },
      { token: 'number.hex', foreground: 'D19A66' },
      { token: 'number.float', foreground: 'D19A66' },
      { token: 'constant.numeric', foreground: 'D19A66' },
      { token: 'constant', foreground: 'D19A66' },
      { token: 'constant.language', foreground: 'D19A66' },

      // Types / classes — warm yellow (contrast against red keywords)
      { token: 'type', foreground: 'E5C07B' },
      { token: 'type.identifier', foreground: 'E5C07B' },
      { token: 'class', foreground: 'E5C07B' },
      { token: 'entity.name.class', foreground: 'E5C07B' },
      { token: 'entity.name.type', foreground: 'E5C07B' },
      { token: 'support.class', foreground: 'E5C07B' },
      { token: 'support.type', foreground: 'E5C07B' },
      { token: 'namespace', foreground: 'E5C07B' },

      // Operators — white
      { token: 'operator', foreground: 'D0D3DA' },
      { token: 'operator.sql', foreground: 'D0D3DA' },

      // CSS-specific
      { token: 'attribute.value.css', foreground: 'C98575' },
      { token: 'attribute.value.unit.css', foreground: 'D19A66' },
      { token: 'attribute.value.number.css', foreground: 'D19A66' },
      { token: 'attribute.value.hex.css', foreground: 'D19A66' },

      // Markdown
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },

      // Errors
      { token: 'invalid', foreground: 'FF5370' },
    ],
    colors: {
      // Editor surface
      'editor.background': '#2B2D35',
      'editor.foreground': '#ABB2BF',

      // Cursor & selection
      'editorCursor.foreground': '#E52E3D',
      'editor.selectionBackground': '#3E4451',
      'editor.inactiveSelectionBackground': '#3E445199',
      'editor.selectionHighlightBackground': '#3E445166',
      'editor.wordHighlightBackground': '#3E445166',
      'editor.wordHighlightStrongBackground': '#3E445188',
      'editor.findMatchBackground': '#E52E3D44',
      'editor.findMatchHighlightBackground': '#E52E3D22',

      // Line numbers / gutter
      'editorLineNumber.foreground': '#636D83',
      'editorLineNumber.activeForeground': '#ABB2BF',
      'editorGutter.background': '#2B2D35',

      // Current line
      'editor.lineHighlightBackground': '#FFFFFF08',
      'editor.lineHighlightBorder': '#00000000',

      // Whitespace / indent guides
      'editorWhitespace.foreground': '#3A3F4B',
      'editorIndentGuide.background': '#3A3F4B',
      'editorIndentGuide.activeBackground': '#E52E3D66',

      // Bracket matching
      'editorBracketMatch.background': '#E52E3D22',
      'editorBracketMatch.border': '#E52E3D88',

      // Widgets
      'editorWidget.background': '#24282E',
      'editorWidget.border': '#3A3F4B',
      'editorSuggestWidget.background': '#24282E',
      'editorSuggestWidget.border': '#3A3F4B',
      'editorSuggestWidget.selectedBackground': '#3E4451',
      'editorSuggestWidget.highlightForeground': '#E52E3D',
      'editorHoverWidget.background': '#24282E',
      'editorHoverWidget.border': '#3A3F4B',

      // Scrollbars
      'scrollbarSlider.background': '#FFFFFF14',
      'scrollbarSlider.hoverBackground': '#FFFFFF22',
      'scrollbarSlider.activeBackground': '#FFFFFF33',

      // Minimap / overview
      'minimap.background': '#2B2D35',
      'editorOverviewRuler.border': '#2B2D35',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Monaco Editor Wrapper
// ─────────────────────────────────────────────────────────────────────────
function MonacoWrapper() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const updateTabContent = useStore((s) => s.updateTabContent);
  const setCursorPosition = useStore((s) => s.setCursorPosition);
  const editorFontSize = useStore((s) => s.editorFontSize);
  const activeTheme = useStore((s) => s.activeTheme);
  const wordWrap = useStore((s) => s.wordWrap);
  const minimapEnabled = useStore((s) => s.minimapEnabled);
  const tabSize = useStore((s) => s.tabSize);
  const registerFormatActiveDocument = useStore((s) => s.registerFormatActiveDocument);
  const pendingEditorReveal = useStore((s) => s.pendingEditorReveal);
  const clearPendingEditorReveal = useStore((s) => s.clearPendingEditorReveal);
  const openFilePath = useStore((s) => s.openFilePath);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // Track which tab paths we've sent textDocument/didOpen for, so we
  // can fire didOpen exactly once per tab and didClose when the tab
  // disappears.
  const openedTabPathsRef = useRef<Set<string>>(new Set());

  // Caret per file, for `window.activeTextEditor`. A ref, not state: it
  // changes on every keystroke and nothing in React needs to re-render.
  const selectionsRef = useRef<Record<string, {
    anchorLine: number;
    anchorCharacter: number;
    activeLine: number;
    activeCharacter: number;
  }[]>>({});
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  /** Publishes the editor layout to the Extension Host. Dedup happens in
   *  the service, so calling it liberally is fine. */
  const publishEditorLayout = useCallback(() => {
    const tabs = openTabsRef.current.filter(
      (tab) => !tab.imageDataUrl && !tab.extension && !tab.gitDiff && tab.path,
    );
    const active = tabs.find((tab) => tab.id === activeTabIdRef.current);
    editorSyncService.publish(
      buildEditorLayout(tabs, active?.path ?? null, selectionsRef.current),
    );
  }, []);

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const activeTabRef = useRef(activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    defineForgeTheme(monaco);

    // Register themes/snippets contributed by installed VSIX extensions.
    // If the extension list was fetched before Monaco loaded, this replays it.
    try {
      attachExtensionMonaco(monaco);
    } catch (err) {
      console.warn('[forge] extension registry attach failed:', (err as Error)?.message);
    }

    // ── Disable Monaco's built-in TS/JS semantic diagnostics ──────────
    // Monaco ships a bundled TypeScript service that doesn't know about
    // the user's tsconfig, node_modules or types-installed packages.
    // typescript-language-server (running in the Electron main process)
    // gives us accurate, project-aware diagnostics; we plumb those in
    // via lspClient.applyDiagnostics() instead. Syntax validation is
    // kept ON because Monaco's parser also tokens cheap stuff (mismatched
    // braces, stray characters) we want to highlight regardless.
    try {
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false,
      });
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: false,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug('[forge] Monaco TS diagnostics setup skipped:', (err as Error)?.message);
    }

    // Wire the LSP client into Monaco. attachMonaco is idempotent — it
    // registers the providers and the diagnostics listener exactly once.
    try {
      lspClient.attachMonaco(monaco);
    } catch (err) {
      console.warn('[forge] LSP attach failed:', (err as Error)?.message);
    }
  }, []);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.focus();

    registerFormatActiveDocument(async () => {
      const action = editor.getAction('editor.action.formatDocument');
      if (action) await action.run();
    });

    useStore.getState().registerRunEditorAction(async (actionId: string) => {
      editor.focus();
      const action = editor.getAction(actionId);
      if (action) await action.run();
    });

    // ── AI quick actions (context menu) ───────────────────────────────
    // Operate on the selection, or the whole file when nothing is selected.
    const runAIAction = (kind: EditorAIActionKind) => {
      const tab = activeTabRef.current;
      const model = editor.getModel();
      if (!tab || tab.imageDataUrl || !model) return;

      const selection = editor.getSelection();
      const hasSelection = Boolean(selection && !selection.isEmpty());
      const code = hasSelection && selection ? model.getValueInRange(selection) : model.getValue();

      const ws = useStore.getState().workspacePath;
      const norm = tab.path.replace(/\\/g, '/');
      const wsNorm = ws ? ws.replace(/\\/g, '/') : '';
      const relPath =
        wsNorm && norm.startsWith(wsNorm + '/') ? norm.slice(wsNorm.length + 1) : tab.name;

      void runEditorAIAction(
        kind,
        {
          relPath,
          language: tab.language || 'plaintext',
          code,
          wholeFile: !hasSelection,
          startLine: selection?.startLineNumber,
          endLine: selection?.endLineNumber,
        },
        tab.path,
      );
    };

    const aiActions: { id: string; label: string; kind: EditorAIActionKind; order: number }[] = [
      { id: 'forge-ai-explain', label: 'IA: Explicar selección', kind: 'explain', order: 1 },
      { id: 'forge-ai-refactor', label: 'IA: Refactorizar selección', kind: 'refactor', order: 2 },
      { id: 'forge-ai-document', label: 'IA: Documentar selección', kind: 'document', order: 3 },
      { id: 'forge-ai-fix', label: 'IA: Corregir con diagnósticos', kind: 'fix', order: 4 },
    ];
    for (const a of aiActions) {
      editor.addAction({
        id: a.id,
        label: a.label,
        contextMenuGroupId: '0_forge_ai',
        contextMenuOrder: a.order,
        run: () => runAIAction(a.kind),
      });
    }

    editor.onDidChangeCursorPosition((e) => {
      setCursorPosition({
        line: e.position.lineNumber,
        column: e.position.column,
      });
    });

    editor.onDidChangeCursorSelection((e) => {
      const tab = activeTabRef.current;
      const model = editor.getModel();
      // Extensions read the caret too. Monaco is 1-based and the VS Code API
      // is 0-based; converting here keeps that off every consumer.
      if (tab?.path) {
        selectionsRef.current[tab.path] = editor.getSelections()?.map((sel) => ({
          anchorLine: sel.selectionStartLineNumber - 1,
          anchorCharacter: sel.selectionStartColumn - 1,
          activeLine: sel.positionLineNumber - 1,
          activeCharacter: sel.positionColumn - 1,
        })) ?? [];
        publishEditorLayout();
      }
      if (!tab || tab.imageDataUrl || !model) {
        window.electronAPI?.claudeIde?.updateSelection(null);
        return;
      }

      const selection = e.selection;
      const text = model.getValueInRange(selection);
      window.electronAPI?.claudeIde?.updateSelection({
        text,
        filePath: tab.path,
        fileUrl: toFileUri(tab.path),
        selection: {
          start: {
            line: selection.startLineNumber - 1,
            character: selection.startColumn - 1,
          },
          end: {
            line: selection.endLineNumber - 1,
            character: selection.endColumn - 1,
          },
          isEmpty: selection.isEmpty(),
        },
      });
    });
  }, [setCursorPosition, registerFormatActiveDocument]);

  useEffect(() => {
    return () => {
      registerFormatActiveDocument(null);
      useStore.getState().registerRunEditorAction(null);
    };
  }, [registerFormatActiveDocument]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: editorFontSize });
  }, [editorFontSize]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: minimapEnabled },
      tabSize,
    });
  }, [wordWrap, minimapEnabled, tabSize]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab || !pendingEditorReveal) return;
    if (activeTab.path !== pendingEditorReveal.filePath) return;
    if (pendingEditorReveal.selection) {
      editor.setSelection(pendingEditorReveal.selection);
      editor.revealRangeInCenter(pendingEditorReveal.selection);
      editor.focus();
    }
    clearPendingEditorReveal(pendingEditorReveal.id);
  }, [activeTab, pendingEditorReveal, clearPendingEditorReveal]);

  useEffect(() => {
    if (!activeTab || activeTab.imageDataUrl) {
      window.electronAPI?.claudeIde?.updateSelection(null);
    }
  }, [activeTab]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        const tab = activeTab;
        // Image tabs are read-only previews; ignore any spurious change
        // event Monaco might fire while we're mounted alongside them.
        if (tab?.imageDataUrl) return;

        // ── Agent streaming guard ─────────────────────────────────────
        // While the AI agent is streaming chunks into this file's buffer
        // (via `agentStreamAppendTab`) the React `value` prop changes on
        // every chunk. @monaco-editor/react does flag those as external
        // edits, but in practice a `controlled-component` race can still
        // make Monaco fire `onChange` with a STALE editor value just
        // after the next chunk lands in the store — which would clobber
        // the streamed content with the previous frame and ultimately
        // cause `agentStreamFinalizeTab` to persist OLD content to disk.
        //
        // We read the latest state via `getState()` so the callback's
        // dependency array stays narrow (no re-creation on every chunk).
        const streamingPaths = useStore.getState().agentStreamingPaths;
        if (tab && streamingPaths.has(tab.path)) {
          return;
        }

        updateTabContent(activeTabId, value);
        // Notify the LSP about the change (no-op for non-TS/JS files).
        if (tab && getLspLanguageId(tab.path)) {
          lspClient.changeDocument(tab.path, value);
        }
        // Extensions see every buffer, debounced by the sync service.
        if (tab?.path) documentSyncService.change(tab.path, value);
      }
    },
    [activeTabId, updateTabContent, activeTab]
  );

  // ── Manage didOpen / didClose for each tab ────────────────────────────
  // Whenever the set of open tabs changes we diff against what we last
  // sent: new tabs get didOpen, removed ones get didClose. Tabs whose
  // language LSP doesn't care about (e.g. markdown, json, images) are
  // skipped.
  useEffect(() => {
    const currentPaths = new Set(openTabs.map((t) => t.path));
    const previouslyOpened = openedTabPathsRef.current;

    // didOpen for newly opened tabs.
    for (const tab of openTabs) {
      if (previouslyOpened.has(tab.path)) continue;
      // Image and extension-detail tabs are never sent to the language server.
      if (tab.imageDataUrl || tab.extension) continue;
      if (!getLspLanguageId(tab.path)) continue;
      lspClient.openDocument(tab.path, tab.content);
      previouslyOpened.add(tab.path);
    }

    // didClose for tabs that have been closed.
    for (const oldPath of Array.from(previouslyOpened)) {
      if (!currentPaths.has(oldPath)) {
        lspClient.closeDocument(oldPath);
        previouslyOpened.delete(oldPath);
      }
    }

    // The editor layout follows the same set of tabs.
    publishEditorLayout();

    // The Extension Host mirrors every text buffer, not just the ones a
    // language server understands: an extension may care about any file.
    // One reconciliation call covers both new and closed tabs.
    documentSyncService.syncOpenDocuments(
      openTabs
        .filter((tab) => !tab.imageDataUrl && !tab.extension && !tab.gitDiff && tab.path)
        .map((tab) => ({
          path: tab.path,
          language: tab.language,
          content: tab.content,
          isUnsaved: tab.isUnsaved,
        })),
    );
  }, [openTabs, publishEditorLayout]);

  // Focus moving between tabs is an `onDidChangeActiveTextEditor` for every
  // extension listening.
  useEffect(() => {
    publishEditorLayout();
  }, [activeTabId, publishEditorLayout]);

  // `window.showTextDocument`: main relays the request and waits for the
  // answer, so the extension's promise resolves when the tab really exists.
  useEffect(() => {
    const api = window.electronAPI?.ext;
    if (!api?.onShowDocument) return;
    const subscription = api.onShowDocument((request) => {
      void (async () => {
        let shown = false;
        try {
          // `preserveFocus` decides whether the tab comes to the front: an
          // extension revealing a document in the background must not steal
          // the user's caret.
          const result = await openFilePath(request.uri, {
            makeFrontmost: !request.preserveFocus,
          });
          shown = result.success;
        } catch {
          shown = false;
        }
        api.respondShowDocument?.(request.id, shown);
      })();
    });
    return () => subscription.dispose();
  }, [openFilePath]);

  if (!activeTab) return <WorkspaceHome />;

  if (activeTab.gitDiff) {
    return <GitDiffEditor tab={activeTab} />;
  }

  // Extension-detail tabs render a marketplace page (icon, stats, README)
  // instead of a Monaco text editor.
  if (activeTab.extension) {
    return <ExtensionDetailView key={activeTab.id} extension={activeTab.extension} />;
  }

  // Image tabs are rendered as a non-editable preview instead of being
  // forced through Monaco (which would otherwise show garbled binary text
  // for PNG/JPG/etc.).
  if (activeTab.imageDataUrl) {
    return (
      <ImageViewer
        key={activeTab.id}
        fileName={activeTab.name}
        dataUrl={activeTab.imageDataUrl}
        fileSize={activeTab.fileSize}
      />
    );
  }

  return (
    <div className="w-full h-full bg-forge-editor">
      <Editor
        key={activeTab.id}
        // path becomes part of the Monaco model URI so completion / hover
        // providers can identify which file the request is for.
        path={activeTab.path}
        language={activeTab.language}
        value={activeTab.content}
        theme={isThemeAvailable(activeTheme) ? activeTheme : 'forge-dark'}
        beforeMount={handleBeforeMount}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          fontSize: editorFontSize,
          fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          minimap: { enabled: minimapEnabled },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'all',
          wordWrap: wordWrap ? 'on' : 'off',
          lineNumbers: 'on',
          glyphMargin: false,
          folding: true,
          bracketPairColorization: { enabled: true },
          automaticLayout: true,
          tabSize,
          padding: { top: 8 },
          suggest: {
            showWords: true,
            showSnippets: true,
          },
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// EditorArea root
// ─────────────────────────────────────────────────────────────────────────
export default function EditorArea() {
  return (
    <div className="w-full h-full flex flex-col bg-forge-editor">
      <TabBar />
      <EditorToolbar />
      <div className="flex-1 overflow-hidden">
        <MonacoWrapper />
      </div>
    </div>
  );
}
