import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Minus, Search, Square, X } from 'lucide-react';
import type { SidebarPanel } from '../types';
import WorkbenchHelp from './WorkbenchHelp';

type MenuId = 'file' | 'edit' | 'view' | 'help';

function MenuDropdown({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="dropdown-menu absolute top-[31px] left-0 z-50 py-1 min-w-[190px]"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function MenuItem({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-4 px-3 py-1.5 text-left text-[12px] text-forge-text-menu hover:bg-forge-accent/10 hover:text-forge-accent transition-colors"
    >
      <span>{label}</span>
      {shortcut && <span className="text-[10px] text-forge-text-dim">{shortcut}</span>}
    </button>
  );
}

function MenuDivider() {
  return <div className="h-px my-1 bg-forge-border/70" />;
}

export default function TitleBar() {
  const workspaceName = useStore((s) => s.workspaceName);
  const openFolder = useStore((s) => s.openFolder);
  const openRemoteWorkspace = useStore((s) => s.openRemoteWorkspace);
  const saveFile = useStore((s) => s.saveFile);
  const closeWorkspace = useStore((s) => s.closeWorkspace);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePanel = useStore((s) => s.togglePanel);
  const setSidebarPanel = useStore((s) => s.setSidebarPanel);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const zoomIn = useStore((s) => s.zoomIn);
  const zoomOut = useStore((s) => s.zoomOut);
  const resetZoom = useStore((s) => s.resetZoom);
  const [helpMode, setHelpMode] = useState<'about' | 'shortcuts' | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);

  const handleMinimize = () => window.electronAPI?.minimize();
  const handleMaximize = () => window.electronAPI?.maximize();
  const handleClose = () => window.electronAPI?.close();
  const closeMenu = () => setOpenMenu(null);

  const pickPanel = (panel: SidebarPanel) => {
    setSidebarPanel(panel);
    closeMenu();
  };

  const edit = window.electronAPI?.edit;

  return (
    <>
    <div className="h-[32px] bg-forge-titlebar flex items-center justify-between select-none drag-region border-b border-forge-border/40 relative">
      {/* Left: Logo + App name + Menu */}
      <div className="flex items-center h-full no-drag shrink-0">
        {/* Forge Code identity */}
        <div className="flex items-center gap-2 px-3 h-full shrink-0">
          <span className="forge-brand-mark text-forge-gold" aria-hidden="true"><span /><span /><span /></span>
          <span className="text-[12px] font-semibold text-forge-text-strong tracking-[-0.02em] whitespace-nowrap">Forge <span className="font-normal text-forge-text-dim">Code</span></span>
        </div>

        {/* Menu Items */}
        <div className="flex items-center h-full text-[12px] ml-1">
          <div className="relative h-full">
            <button
              onClick={() => setOpenMenu((cur) => cur === 'file' ? null : 'file')}
              aria-expanded={openMenu === 'file'} aria-haspopup="true"
              className="px-2 h-full text-forge-text hover:text-forge-text-strong hover:bg-white/5 transition-colors"
            >
              Archivo
            </button>
            {openMenu === 'file' && (
              <MenuDropdown onClose={closeMenu}>
                <MenuItem label="Nueva ventana" onClick={() => { window.electronAPI?.newWindow(); closeMenu(); }} />
                <MenuDivider />
                <MenuItem label="Abrir carpeta…" onClick={() => { void openFolder(); closeMenu(); }} />
                <MenuItem label="Conectar por SSH…" onClick={() => { void openRemoteWorkspace(); closeMenu(); }} />
                <MenuItem label="Buscar archivo…" shortcut="Ctrl+P" onClick={() => { setQuickOpenOpen(true); closeMenu(); }} />
                <MenuItem label="Guardar" shortcut="Ctrl+S" onClick={() => { void saveFile(); closeMenu(); }} />
                <MenuDivider />
                <MenuItem label="Cerrar carpeta" onClick={() => { closeWorkspace(); closeMenu(); }} />
              </MenuDropdown>
            )}
          </div>
          <div className="relative h-full">
            <button
              onClick={() => setOpenMenu((cur) => cur === 'edit' ? null : 'edit')}
              aria-expanded={openMenu === 'edit'} aria-haspopup="true"
              className="px-2 h-full text-forge-text hover:text-forge-text-strong hover:bg-white/5 transition-colors"
            >
              Editar
            </button>
            {openMenu === 'edit' && (
              <MenuDropdown onClose={closeMenu}>
                <MenuItem label="Deshacer" shortcut="Ctrl+Z" onClick={() => { edit?.undo(); closeMenu(); }} />
                <MenuItem label="Rehacer" shortcut="Ctrl+Y" onClick={() => { edit?.redo(); closeMenu(); }} />
                <MenuDivider />
                <MenuItem label="Cortar" shortcut="Ctrl+X" onClick={() => { edit?.cut(); closeMenu(); }} />
                <MenuItem label="Copiar" shortcut="Ctrl+C" onClick={() => { edit?.copy(); closeMenu(); }} />
                <MenuItem label="Pegar" shortcut="Ctrl+V" onClick={() => { edit?.paste(); closeMenu(); }} />
                <MenuDivider />
                <MenuItem label="Seleccionar todo" shortcut="Ctrl+A" onClick={() => { edit?.selectAll(); closeMenu(); }} />
              </MenuDropdown>
            )}
          </div>
          <div className="relative h-full">
            <button
              onClick={() => setOpenMenu((cur) => cur === 'view' ? null : 'view')}
              aria-expanded={openMenu === 'view'} aria-haspopup="true"
              className="px-2 h-full text-forge-text hover:text-forge-text-strong hover:bg-white/5 transition-colors"
            >
              Ver
            </button>
            {openMenu === 'view' && (
              <MenuDropdown onClose={closeMenu}>
                <MenuItem label="Explorador" onClick={() => pickPanel('explorer')} />
                <MenuItem label="Búsqueda" onClick={() => pickPanel('search')} />
                <MenuItem label="Control de versiones" onClick={() => pickPanel('git')} />
                <MenuItem label="Ejecutar" onClick={() => pickPanel('debug')} />
                <MenuItem label="Extensiones" onClick={() => pickPanel('extensions')} />
                <MenuDivider />
                <MenuItem label="Mostrar u ocultar barra lateral" shortcut="Ctrl+B" onClick={() => { toggleSidebar(); closeMenu(); }} />
                <MenuItem label="Mostrar u ocultar panel" shortcut="Ctrl+`" onClick={() => { togglePanel(); closeMenu(); }} />
                <MenuItem label="Terminal" onClick={() => { setBottomTab('terminal'); closeMenu(); }} />
                <MenuItem label="Problemas" onClick={() => { setBottomTab('problems'); closeMenu(); }} />
                <MenuItem label="Asistente IA" onClick={() => { toggleAIPanel(); closeMenu(); }} />
                <MenuDivider />
                <MenuItem label="Aumentar fuente" shortcut="Ctrl+=" onClick={() => { zoomIn(); closeMenu(); }} />
                <MenuItem label="Reducir fuente" shortcut="Ctrl+-" onClick={() => { zoomOut(); closeMenu(); }} />
                <MenuItem label="Restablecer fuente" shortcut="Ctrl+0" onClick={() => { resetZoom(); closeMenu(); }} />
              </MenuDropdown>
            )}
          </div>
          <div className="relative h-full">
            <button
              onClick={() => setOpenMenu((cur) => cur === 'help' ? null : 'help')}
              aria-expanded={openMenu === 'help'} aria-haspopup="true" data-help-menu
              className="px-2 h-full text-forge-text hover:text-forge-text-strong hover:bg-white/5 transition-colors"
            >
              Ayuda
            </button>
            {openMenu === 'help' && (
              <MenuDropdown onClose={closeMenu}>
                <MenuItem
                  label="Paleta de comandos"
                  shortcut="Ctrl+Shift+P"
                  onClick={() => { setCommandPaletteOpen(true); closeMenu(); }}
                />
                <MenuItem
                  label="Atajos de teclado"
                  onClick={() => {
                    setHelpMode('shortcuts');
                    closeMenu();
                  }}
                />
                <MenuDivider />
                <MenuItem label="Ver problemas" onClick={() => { setBottomTab('problems'); closeMenu(); }} />
                <MenuItem label="Ver salida" onClick={() => { setBottomTab('output'); closeMenu(); }} />
                <MenuDivider />
                <MenuItem
                  label="Acerca de Forge Code"
                  onClick={() => {
                    setHelpMode('about');
                    closeMenu();
                  }}
                />
              </MenuDropdown>
            )}
          </div>
        </div>
      </div>

      <button
        className="no-drag hidden xl:flex absolute left-1/2 -translate-x-1/2 items-center justify-between gap-5 w-[min(30vw,380px)] h-[23px] px-2 rounded border border-forge-border bg-white/[0.025] text-[11px] text-forge-text-dim hover:bg-white/[0.05]"
        onClick={() => setCommandPaletteOpen(true)} title="Paleta de comandos (Ctrl+Shift+P)" aria-label="Abrir paleta de comandos"
      >
        <span className="flex items-center gap-2 min-w-0"><Search size={12} className="shrink-0" /><span className="truncate">{workspaceName || 'Buscar un comando…'}</span></span><span className="shrink-0 text-[9px]">Ctrl+Shift+P</span>
      </button>

      {/* Right: Window Controls */}
      <div className="flex items-center h-full no-drag shrink-0">
        <button
          onClick={handleMinimize} aria-label="Minimizar ventana"
          className="w-[38px] h-full flex items-center justify-center hover:bg-white/10 transition-colors"
        >
          <Minus size={16} className="text-forge-text" />
        </button>
        <button
          onClick={handleMaximize} aria-label="Maximizar o restaurar ventana"
          className="w-[38px] h-full flex items-center justify-center hover:bg-white/10 transition-colors"
        >
          <Square size={12} className="text-forge-text" />
        </button>
        <button
          onClick={handleClose} aria-label="Cerrar ventana"
          className="w-[38px] h-full flex items-center justify-center hover:bg-[#e81123] hover:text-white transition-colors"
        >
          <X size={16} className="text-forge-text" />
        </button>
      </div>
    </div>
    {helpMode && <WorkbenchHelp mode={helpMode} onClose={() => { setHelpMode(null); document.querySelector<HTMLButtonElement>('[data-help-menu]')?.focus(); }} />}
    </>
  );
}
