import { useEffect, useRef, useState } from 'react';
import { Blocks, ChevronRight, Command, FileCode2, GitBranch, Globe, Pin, Save, TerminalSquare, X } from 'lucide-react';
import { useStore } from '../../store';
import type { Tab } from '../../types';

export function EditorToolbar() {
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

  const rel = relativizePath(workspacePath, activeTab.path);
  const crumbs = rel.split('/').filter(Boolean);
  const fileProblems = problems.filter((p) => p.filePath === activeTab.path);
  const errorCount = fileProblems.filter((p) => p.severity === 1).length;
  const warningCount = fileProblems.filter((p) => p.severity === 2).length;

  return (
    <div className="h-[30px] shrink-0 bg-forge-editor/95 border-b border-forge-border/70 flex items-center justify-between px-3 select-none">
      <div className="min-w-0 flex items-center gap-1 text-[12px] text-forge-text-dim">
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
        <span className="hidden 2xl:flex items-center gap-1.5 text-[11px] text-forge-text-dim mr-2">
          {activeTab.isUnsaved ? 'Sin guardar' : 'Guardado'}
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
        <button className="forge-toolbar-button" title="Guardar" aria-label="Guardar" onClick={() => void saveFile(activeTab.id)}>
          <Save size={14} />
        </button>
        <button className="forge-toolbar-button" title="Live Server" aria-label="Live Server" onClick={() => void toggleLiveServer(activeTab.path)}>
          <Globe size={14} />
        </button>
        <button className="forge-toolbar-button" title="Abrir terminal" aria-label="Abrir terminal" onClick={() => setBottomTab('terminal')}>
          <TerminalSquare size={14} />
        </button>
        <button className="forge-toolbar-button" title="Paleta de comandos" aria-label="Paleta de comandos" onClick={() => setCommandPaletteOpen(true)}>
          <Command size={14} />
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tabs retain drag, pin and close actions; selection has a visible border.
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
    ref.current?.querySelector('button')?.focus();
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const item = (label: string, action: () => void) => (
    <button className="context-menu-item w-full text-left" onClick={() => { action(); onClose(); }}>
      {label}
    </button>
  );

  const { closeTab, closeOtherTabs, closeAllTabs, closeSavedTabs, togglePinTab, workspacePath } =
    useStore.getState();
  const isRealFile = !tab.gitDiff && !tab.extension;

  return (
    <div
      ref={ref}
      className="context-menu fixed z-50"
      aria-label="Acciones de pestaña"
      style={{ top: Math.max(4, Math.min(y, window.innerHeight - 330)), left: Math.max(4, Math.min(x, window.innerWidth - 240)) }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {item(tab.pinned ? 'Desanclar pestaña' : 'Anclar pestaña', () => togglePinTab(tab.id))}
      <div className="context-menu-divider" />
      {item('Cerrar', () => closeTab(tab.id))}
      {item('Cerrar otras', () => closeOtherTabs(tab.id))}
      {item('Cerrar guardadas', () => closeSavedTabs())}
      {item('Cerrar todas', () => closeAllTabs())}
      {isRealFile && (
        <>
          <div className="context-menu-divider" />
          {item('Copiar ruta', () => void navigator.clipboard.writeText(tab.path))}
          {item('Copiar ruta relativa', () =>
            void navigator.clipboard.writeText(relativizePath(workspacePath, tab.path)),
          )}
          {item('Mostrar en administrador de archivos', () =>
            void window.electronAPI.revealInFolder(tab.path),
          )}
        </>
      )}
    </div>
  );
}

export function TabBar() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const togglePinTab = useStore((s) => s.togglePinTab);
  const moveTab = useStore((s) => s.moveTab);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceIdRef = useRef<string | null>(null);

  const hasActiveTab = openTabs.some((tab) => tab.id === activeTabId);
  if (openTabs.length === 0) return null;

  return (
    <div role="tablist" aria-label="Archivos abiertos" className="h-[36px] shrink-0 bg-forge-tabbar border-b border-forge-border/70 flex items-end overflow-x-auto sidebar-scroll select-none">
      {openTabs.map((tab, index) => {
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
            className={`group flex shrink-0 items-center h-[35px] pl-3 pr-2 gap-2 cursor-pointer min-w-[110px] max-w-[220px] border-r border-forge-border/70 border-t-2 transition-colors
              ${isActive
                ? 'bg-forge-tab-active border-t-forge-accent text-forge-text-strong'
                : 'border-t-transparent bg-forge-tabbar text-forge-text-tab hover:bg-white/[0.03]'}
              ${isDragTarget ? 'shadow-[inset_2px_0_0_0_#E05A68]' : ''}
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

            <button
              role="tab" aria-selected={isActive} tabIndex={isActive || (!hasActiveTab && index === 0) ? 0 : -1}
              title={`${tab.path}${tab.isUnsaved ? ' · Sin guardar' : ''}`}
              className="min-w-0 flex-1 truncate text-left text-[12px] h-full"
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const current = openTabs.findIndex((entry) => entry.id === tab.id);
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? openTabs.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + openTabs.length) % openTabs.length;
                setActiveTab(openTabs[next].id);
                const buttons = e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                buttons?.[next]?.focus();
              }}
            >
              {tab.name}
            </button>

            {tab.pinned ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePinTab(tab.id);
                }}
                title="Desanclar" aria-label={`Desanclar ${tab.name}`}
                className="p-0.5 flex-shrink-0 opacity-70 hover:opacity-100"
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
                  ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 group-focus-within:opacity-70 focus-visible:opacity-100 hover:!opacity-100'}
                `}
                title={`Cerrar ${tab.name}`} aria-label={`Cerrar ${tab.name}`}
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

