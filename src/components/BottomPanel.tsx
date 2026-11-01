import { useEffect } from 'react';
import { useStore } from '../store';
import { X, Terminal as TerminalIcon, AlertTriangle, FileOutput, Bug, Plus } from 'lucide-react';
import type { BottomTab, Problem, TerminalSession } from '../types';
import XTermView from './Terminal/XTermView';

interface PanelTab {
  id: BottomTab;
  label: string;
  icon: React.ReactNode;
}

const tabs: PanelTab[] = [
  { id: 'terminal', label: 'TERMINAL', icon: <TerminalIcon size={13} /> },
  { id: 'problems', label: 'PROBLEMAS', icon: <AlertTriangle size={13} /> },
  { id: 'output', label: 'SALIDA', icon: <FileOutput size={13} /> },
  { id: 'debug', label: 'CONSOLA DE DEPURACIÓN', icon: <Bug size={13} /> },
];

function relativePath(workspacePath: string | null, filePath: string): string {
  if (!workspacePath) return filePath;
  const root = workspacePath.replace(/\\/g, '/');
  const file = filePath.replace(/\\/g, '/');
  if (file.startsWith(root + '/')) return file.slice(root.length + 1);
  return filePath;
}

function severityLabel(problem: Problem): string {
  if (problem.severity === 1) return 'Error';
  if (problem.severity === 2) return 'Advertencia';
  if (problem.severity === 3) return 'Información';
  return 'Sugerencia';
}

function severityColor(problem: Problem): string {
  if (problem.severity === 1) return '#FF5370';
  if (problem.severity === 2) return '#FFCB6B';
  if (problem.severity === 3) return '#89DDFF';
  return '#A1A3AF';
}

function ProblemsView() {
  const problems = useStore((s) => s.problems);
  const workspacePath = useStore((s) => s.workspacePath);
  const openFilePath = useStore((s) => s.openFilePath);

  if (problems.length === 0) {
    return (
      <div className="h-full flex items-center px-3 font-mono text-[13px] text-forge-text/70">
        No se detectaron problemas en el proyecto.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto sidebar-scroll p-2 font-mono text-[12px] text-forge-text">
      {problems.map((problem, index) => (
        <button
          key={`${problem.filePath}:${problem.startLine}:${problem.startColumn}:${index}`}
          onClick={() => void openFilePath(problem.filePath, { line: problem.startLine })}
          className="w-full flex items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-white/5 transition-colors"
        >
          <AlertTriangle
            size={13}
            className="mt-0.5 flex-shrink-0"
            style={{ color: severityColor(problem) }}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{problem.message}</span>
            <span className="block text-[11px] text-forge-text/45 truncate">
              {relativePath(workspacePath, problem.filePath)}:{problem.startLine}:{problem.startColumn}
              {' · '}
              {severityLabel(problem)}
              {problem.code ? ` · ${problem.code}` : ''}
              {problem.source ? ` · ${problem.source}` : ''}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TerminalSessionTabs({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onNew,
  showNew = true,
}: {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  showNew?: boolean;
}) {
  return (
    <div className="h-[28px] flex items-center gap-0.5 px-1 border-b border-forge-border/30 bg-[#1A1B20] overflow-x-auto sidebar-scroll flex-shrink-0">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId;
        return (
          <div
            key={session.id}
            className={`group flex items-center gap-1 h-[24px] px-2 rounded text-[11px] cursor-pointer flex-shrink-0 transition-colors
              ${isActive
                ? 'bg-forge-accent/15 text-forge-accent'
                : 'text-forge-text/60 hover:bg-white/5 hover:text-forge-text'}
            `}
            onClick={() => onSelect(session.id)}
          >
            <TerminalIcon size={11} />
            <span className="truncate max-w-[120px]">{session.label}</span>
            {sessions.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(session.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-forge-text-strong"
                title="Cerrar terminal"
              >
                <X size={11} />
              </button>
            )}
          </div>
        );
      })}
      {showNew && (
        <button
          onClick={onNew}
          title="Nueva terminal"
          className="h-[24px] w-[24px] flex items-center justify-center rounded text-forge-text/50 hover:text-forge-accent hover:bg-white/5 flex-shrink-0"
        >
          <Plus size={13} />
        </button>
      )}
    </div>
  );
}

export function TerminalsPanel({
  visible,
  kind = 'all',
  showNew = true,
  hideTabs = false,
  sessionId,
  empty,
}: {
  visible: boolean;
  kind?: 'all' | 'normal' | 'agents';
  showNew?: boolean;
  hideTabs?: boolean;
  sessionId?: string | null;
  empty?: React.ReactNode;
}) {
  const terminalSessions = useStore((s) => s.terminalSessions);
  const activeTerminalSessionId = useStore((s) => s.activeTerminalSessionId);
  const ensureTerminalSession = useStore((s) => s.ensureTerminalSession);
  const createTerminalSession = useStore((s) => s.createTerminalSession);
  const closeTerminalSession = useStore((s) => s.closeTerminalSession);
  const setActiveTerminalSession = useStore((s) => s.setActiveTerminalSession);

  useEffect(() => {
    if ((kind === 'all' || kind === 'normal') && terminalSessions.filter((s) => kind === 'all' || !s.agentId).length === 0) {
      ensureTerminalSession();
    }
  }, [terminalSessions, ensureTerminalSession, kind]);

  const sessions = terminalSessions.filter((session) => {
    if (sessionId && session.id !== sessionId) return false;
    if (kind === 'agents') return Boolean(session.agentId);
    if (kind === 'normal') return !session.agentId;
    return true;
  });
  const activeSessionId = sessions.some((session) => session.id === activeTerminalSessionId)
    ? activeTerminalSessionId
    : sessions[0]?.id ?? null;
  if (sessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-forge-text/50 text-[12px]">
        {empty ?? 'Iniciando terminal…'}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {!hideTabs && (
        <TerminalSessionTabs
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={setActiveTerminalSession}
          onClose={closeTerminalSession}
          onNew={() => createTerminalSession()}
          showNew={showNew}
        />
      )}
      <div className="flex-1 min-h-0 relative">
        {sessions.map((session) => (
          <div
            key={session.id}
            className="absolute inset-0"
            style={{
              display:
                visible && session.id === activeSessionId ? 'block' : 'none',
            }}
          >
            <XTermView
              sessionId={session.id}
              visible={visible && session.id === activeSessionId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BottomPanel() {
  const activeBottomTab = useStore((s) => s.activeBottomTab);
  const setBottomTab = useStore((s) => s.setBottomTab);
  const togglePanel = useStore((s) => s.togglePanel);
  const bottomPanelHeight = useStore((s) => s.bottomPanelHeight);
  const agentTerminalDock = useStore((s) => s.agentTerminalDock);

  return (
    <div
      className="min-h-[100px] max-h-[calc(100%_-_126px)] flex-shrink-0 border-t border-forge-border/50 bg-forge-terminal flex flex-col"
      style={{ height: `${bottomPanelHeight}px` }}
    >
      <div className="h-[32px] flex items-center justify-between px-2 bg-forge-titlebar border-b border-forge-border/40 select-none">
        <div className="flex items-center gap-0">
          {tabs.map((tab) => {
            const isActive = tab.id === activeBottomTab;
            return (
              <button
                key={tab.id}
                onClick={() => setBottomTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 h-[32px] text-[11px] uppercase tracking-wider border-b-2 transition-colors
                  ${isActive
                    ? 'text-forge-text-strong border-forge-accent'
                    : 'text-forge-text border-transparent hover:text-forge-text-strong'}
                `}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={togglePanel}
          className="p-1 hover:bg-white/10 rounded transition-colors"
          title="Cerrar panel"
        >
          <X size={15} className="text-forge-text" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div
          className="absolute inset-0 flex flex-col"
          style={{ display: activeBottomTab === 'terminal' ? 'flex' : 'none' }}
        >
          <TerminalsPanel
            visible={activeBottomTab === 'terminal'}
            kind={agentTerminalDock === 'bottom' ? 'all' : 'normal'}
          />
        </div>

        {activeBottomTab === 'problems' && (
          <div className="absolute inset-0">
            <ProblemsView />
          </div>
        )}
        {activeBottomTab === 'output' && (
          <div className="absolute inset-0 p-3 font-mono text-[13px] text-forge-text">
            El canal de salida está vacío.
          </div>
        )}
        {activeBottomTab === 'debug' && (
          <div className="absolute inset-0 p-3 font-mono text-[13px] text-forge-text">
            La consola de depuración está lista.
          </div>
        )}
      </div>
    </div>
  );
}
