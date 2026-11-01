import { useStore } from '../store';
import { AlertCircle, AlertTriangle, GitBranch, Globe, Save, TerminalSquare } from 'lucide-react';

export default function StatusBar() {
  const cursorPosition = useStore((s) => s.cursorPosition);
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const workspacePath = useStore((s) => s.workspacePath);
  const liveServerActive = useStore((s) => s.liveServerActive);
  const liveServerPort = useStore((s) => s.liveServerPort);
  const liveServerUrl = useStore((s) => s.liveServerUrl);
  const toggleLiveServer = useStore((s) => s.toggleLiveServer);
  const gitIsRepo = useStore((s) => s.gitIsRepo);
  const gitBranch = useStore((s) => s.gitBranch);
  const gitChanges = useStore((s) => s.gitChanges);
  const setSidebarPanel = useStore((s) => s.setSidebarPanel);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const problems = useStore((s) => s.problems);
  const autoSave = useStore((s) => s.autoSave);
  const setAutoSave = useStore((s) => s.setAutoSave);
  const tabSize = useStore((s) => s.tabSize);
  const activeTab = openTabs.find((tab) => tab.id === activeTabId);
  const isTextFile = activeTab && !activeTab.extension && !activeTab.imageDataUrl && !activeTab.gitDiff;
  const errorCount = problems.filter((problem) => problem.severity === 1).length;
  const warningCount = problems.filter((problem) => problem.severity === 2).length;
  const buttonClass = 'inline-flex h-full shrink-0 items-center gap-1.5 px-2 hover:bg-white/[0.06] hover:text-forge-text-strong transition-colors';

  return (
    <footer aria-label="Estado del editor" className="h-[22px] flex items-center justify-between border-t border-forge-border/70 bg-forge-statusbar text-forge-text-dim text-[10px] select-none overflow-hidden">
      <div className="flex items-center h-full min-w-0">
        <button className={`${buttonClass} text-forge-gold`} title="Abrir terminal" aria-label="Abrir terminal" onClick={() => setBottomTab('terminal')}><TerminalSquare size={12} /></button>
        {workspacePath && gitIsRepo && <button onClick={() => setSidebarPanel('git')} title={`${gitChanges.length} cambios en Git`} className={`${buttonClass} max-w-[180px]`}><GitBranch size={11} /><span className="truncate">{gitBranch || 'HEAD'}</span>{gitChanges.length > 0 && <span className="text-forge-gold">*{gitChanges.length}</span>}</button>}
        <button onClick={() => setBottomTab('problems')} title={`${errorCount} errores, ${warningCount} advertencias`} aria-label={`Ver problemas: ${errorCount} errores y ${warningCount} advertencias`} className={buttonClass}><AlertCircle size={11} /><span>{errorCount}</span><AlertTriangle size={11} className="ml-1" /><span>{warningCount}</span></button>
        <button onClick={() => void toggleLiveServer()} title={liveServerActive ? `Detener Live Server · ${liveServerUrl || `http://localhost:${liveServerPort}`}` : 'Iniciar Live Server con un archivo HTML'} className={`${buttonClass} ${liveServerActive ? 'text-forge-gold' : ''}`}><Globe size={11} /><span className="hidden sm:inline">{liveServerActive ? `Puerto ${liveServerPort}` : 'Live Server'}</span></button>
      </div>
      <div className="flex items-center h-full min-w-0">
        <button onClick={() => setAutoSave(!autoSave)} title={autoSave ? 'Desactivar guardado automático' : 'Activar guardado automático'} aria-pressed={autoSave} className={`${buttonClass} ${autoSave ? 'text-forge-gold' : ''}`}><Save size={11} /><span className="hidden md:inline">{autoSave ? 'Autoguardado' : 'Guardado manual'}</span></button>
        {isTextFile && <><span className="shrink-0 px-2">Ln {cursorPosition.line}, Col {cursorPosition.column}</span><span className="hidden lg:inline px-2">Espacios: {tabSize}</span><span className="hidden lg:inline px-2">UTF-8</span><span className="hidden xl:inline px-2">LF</span><span className="hidden sm:inline px-2 truncate max-w-[110px]">{activeTab.language}</span></>}
      </div>
    </footer>
  );
}
