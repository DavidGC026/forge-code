import { useMemo } from 'react';
import { ArrowRight, Blocks, Bot, ChevronRight, Command, FileCode2, FolderOpen, GitBranch, Search, Settings2, TerminalSquare, Workflow } from 'lucide-react';
import { useStore } from '../store';
import type { TreeNode } from '../types';

function projectFiles(nodes: TreeNode[]): TreeNode[] {
  const files: TreeNode[] = [];
  for (const node of nodes) {
    if (node.name === 'node_modules' || node.name === '.git') continue;
    if (node.type === 'file') files.push(node);
    if (node.children) files.push(...projectFiles(node.children));
    if (files.length >= 7) break;
  }
  return files.slice(0, 7);
}

function relativePath(root: string | null, path: string): string {
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = path.replace(/\\/g, '/');
  return base && normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : path;
}

export default function WelcomeScreen() {
  const workspacePath = useStore((s) => s.workspacePath);
  const workspaceName = useStore((s) => s.workspaceName);
  const fileTree = useStore((s) => s.fileTree);
  const openFile = useStore((s) => s.openFile);
  const openFolder = useStore((s) => s.openFolder);
  const openRemoteWorkspace = useStore((s) => s.openRemoteWorkspace);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const setSidebarPanel = useStore((s) => s.setSidebarPanel);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);
  const files = useMemo(() => projectFiles(fileTree), [fileTree]);

  const tools = [
    { label: 'Buscar archivos', detail: 'Ctrl+P', icon: Search, action: () => setQuickOpenOpen(true), disabled: !workspacePath },
    { label: 'Control de versiones', detail: 'Git', icon: GitBranch, action: () => setSidebarPanel('git'), disabled: !workspacePath },
    { label: 'Terminal integrada', detail: 'Shell', icon: TerminalSquare, action: () => setBottomTab('terminal') },
    { label: 'Asistente IA', detail: 'Chat', icon: Bot, action: toggleAIPanel },
  ];

  return (
    <main className="forge-home h-full overflow-y-auto sidebar-scroll" aria-label="Inicio de Forge Code">
      <div className="forge-welcome mx-auto w-full max-w-[1000px] px-6 py-9 sm:px-10 lg:py-12">
        <header className="mb-9">
          <div className="mb-7 flex items-center gap-2.5 text-forge-gold">
            <span className="forge-brand-mark" aria-hidden="true"><span /> <span /> <span /></span>
            <span className="text-[11px] font-semibold tracking-[0.18em] uppercase">Tu espacio de trabajo</span>
          </div>
          <h1 className="text-[35px] leading-tight font-semibold tracking-[-0.045em] text-forge-text-strong sm:text-[43px]">Forge <span className="font-normal text-forge-text-dim">Code</span><span className="text-forge-accent">.</span></h1>
          <p className="mt-3 max-w-[560px] text-[14px] leading-6 text-forge-text-dim">
            {workspacePath ? 'Todo listo para continuar con tu proyecto.' : 'Un espacio para tu código, tus herramientas y tu siguiente idea.'}
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <button className="forge-primary-button" onClick={() => void openFolder()}><FolderOpen size={15} /> Abrir carpeta <ArrowRight size={14} className="ml-2" /></button>
            <button className="forge-secondary-button" onClick={() => void openRemoteWorkspace()}><Workflow size={15} /> Conectar por SSH</button>
          </div>
        </header>

        <div className="forge-welcome-columns grid gap-9">
          <section className="min-w-0" aria-labelledby="welcome-project">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 id="welcome-project" className="forge-section-label">{workspacePath ? 'Archivos del proyecto' : 'Comenzar'}</h2>
              {workspacePath && <button className="text-[11px] text-forge-text-dim hover:text-forge-text-strong" onClick={() => setSidebarPanel('explorer')}>Explorar <ChevronRight size={12} className="inline" /></button>}
            </div>
            {workspacePath ? (
              <div className="rounded-lg border border-forge-border bg-forge-sidebar/50 overflow-hidden">
                <div className="px-4 py-3 border-b border-forge-border">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-forge-text-strong"><FolderOpen size={15} className="text-forge-gold" /><span className="truncate">{workspaceName}</span></p>
                  <p className="mt-1 truncate text-[11px] text-forge-text-dim" title={workspacePath}>{workspacePath}</p>
                </div>
                {files.length ? files.map((file) => (
                  <button key={file.path} onClick={() => void openFile(file)} className="forge-project-file group" title={file.path}>
                    <FileCode2 size={15} className="shrink-0 text-forge-text-dim" />
                    <span className="min-w-0 flex-1 truncate">{relativePath(workspacePath, file.path)}</span>
                    <ArrowRight size={13} className="text-forge-text-dim opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                  </button>
                )) : <p className="px-4 py-6 text-[12px] leading-5 text-forge-text-dim">Esta carpeta está vacía. Agrega archivos desde el explorador para empezar.</p>}
              </div>
            ) : (
              <div className="rounded-lg border border-forge-border px-5 py-5 bg-forge-sidebar/40">
                <FolderOpen size={24} strokeWidth={1.4} className="mb-4 text-forge-gold" />
                <h3 className="text-[14px] font-medium text-forge-text-strong">Empieza con una carpeta</h3>
                <p className="mt-2 text-[12px] leading-5 text-forge-text-dim">Abre un proyecto local o conéctate a un equipo remoto. Tus archivos aparecerán aquí.</p>
                <button className="mt-5 inline-flex items-center gap-2 text-[12px] font-medium text-forge-text hover:text-forge-text-strong" onClick={() => void openFolder()}>Elegir carpeta <ArrowRight size={14} /></button>
              </div>
            )}
          </section>

          <section className="min-w-0" aria-labelledby="welcome-tools">
            <h2 id="welcome-tools" className="forge-section-label mb-3">A mano</h2>
            <div className="space-y-1">
              {tools.map(({ label, detail, icon: Icon, action, disabled }) => (
                <button key={label} className="forge-home-action" onClick={action} disabled={disabled}>
                  <Icon size={16} strokeWidth={1.6} className="shrink-0 text-forge-text-dim" /><span className="flex-1 text-left">{label}</span><span className="text-[10px] text-forge-text-dim">{detail}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 border-t border-forge-border pt-4 flex flex-wrap gap-x-5 gap-y-3 text-[11px] text-forge-text-dim">
              <button className="inline-flex items-center gap-1.5 hover:text-forge-text-strong" onClick={() => setSidebarPanel('extensions')}><Blocks size={13} /> Extensiones</button>
              <button className="inline-flex items-center gap-1.5 hover:text-forge-text-strong" onClick={() => setSidebarPanel('settings')}><Settings2 size={13} /> Preferencias</button>
            </div>
          </section>
        </div>

        <footer className="mt-9 flex items-center gap-2 border-t border-forge-border pt-5 text-[11px] text-forge-text-dim">
          <Command size={13} className="shrink-0" /><button className="text-left hover:text-forge-text-strong" onClick={() => setCommandPaletteOpen(true)}>Todas las acciones en la paleta de comandos <kbd className="forge-kbd ml-1.5">Ctrl+Shift+P</kbd></button>
        </footer>
      </div>
    </main>
  );
}
