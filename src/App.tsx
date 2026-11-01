import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import TitleBar from './components/TitleBar';
import ActivityBar from './components/ActivityBar';
import SideBar from './components/SideBar';
import EditorArea from './components/EditorArea';
import BottomPanel, { TerminalsPanel } from './components/BottomPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import RemoteSSHModal from './components/RemoteSSHModal';
import ExtensionNotifications from './components/ExtensionNotifications';
import QuickOpen from './components/QuickOpen';
import ResizeDivider from './components/ResizeDivider';
import AIPanel from './components/AIPanel/AIPanel';
import { Bot, Eraser, Maximize2, MessageSquare, Minimize2, RotateCcw, Terminal as TerminalIcon, X } from 'lucide-react';
import type { ClaudeIdeEditorState } from './types';
import { lspClient } from './lsp/client';
import { contextKeys } from './extensions/contextKeys';
import { editorResourceContext } from './extensions/menus';
import { extensionKeybindingService } from './extensions/registry';

// ─────────────────────────────────────────────────────────────────────────
// Drag dividers
//
// The dividers are 6px thick (clearly grabbable hit area), transparent by
// default, and show a 2px accent line on hover/while dragging.
//
// We intentionally avoid relying on React state to gate pointermove updates
// because the state-update-then-render cycle creates a race window where the
// first pointermove after pointerdown can fire with a stale `dragging=false`
// closure. Using a ref for the dragging flag means the very first movement
// pixel already triggers a resize callback, and pointer capture guarantees
// move/up events keep flowing even when the cursor leaves the 6px hit area.
// ─────────────────────────────────────────────────────────────────────────

const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 500;
const BOTTOM_MIN = 100;
/** The bottom panel must always leave room for at least this many pixels
 *  of editor area above it. */
const EDITOR_MIN = 120;
/** Divider hit area thickness. Wider than the visual accent line so the user
 *  can actually grab it without pixel-perfect aim. */
const DIVIDER_HIT = 6;
/** AI sidebar (right) bounds. Larger than the left sidebar by design. */
const AI_PANEL_MIN = 280;
const AI_PANEL_MAX = 720;
const EDITOR_MIN_WIDTH = 360;

function toFileUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(normalized);
}

function lineCount(content: string): number {
  if (!content) return 1;
  return content.split(/\r\n|\r|\n/).length;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function buildClaudeEditorState(): ClaudeIdeEditorState {
  const state = useStore.getState();
  return {
    workspacePath: state.workspacePath,
    workspaceName: state.workspaceName,
    openEditors: state.openTabs
      .filter((tab) => !tab.imageDataUrl)
      .map((tab) => ({
        uri: toFileUri(tab.path),
        filePath: tab.path,
        isActive: tab.id === state.activeTabId,
        label: tab.name,
        languageId: tab.language,
        isDirty: tab.isUnsaved,
        lineCount: lineCount(tab.content),
      })),
  };
}

function publishClaudeEditorState(): void {
  try {
    window.electronAPI?.claudeIde?.updateEditorState(buildClaudeEditorState());
  } catch {
    /* noop outside Electron */
  }
}

function RightWorkspace() {
  const terminalSessions = useStore((s) => s.terminalSessions);
  const activeTerminalSessionId = useStore((s) => s.activeTerminalSessionId);
  const setActiveTerminalSession = useStore((s) => s.setActiveTerminalSession);
  const closeTerminalSession = useStore((s) => s.closeTerminalSession);
  const runAgentInTerminal = useStore((s) => s.runAgentInTerminal);
  const runCommandInTerminalSession = useStore((s) => s.runCommandInTerminalSession);
  const rightPanelMaximized = useStore((s) => s.rightPanelMaximized);
  const setRightPanelMaximized = useStore((s) => s.setRightPanelMaximized);
  const aiPanelVisible = useStore((s) => s.aiPanelVisible);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);

  const agentSessions = terminalSessions.filter((session) => session.agentId);
  const [localTab, setLocalTab] = useState<'chat' | string>(
    activeTerminalSessionId && agentSessions.some((s) => s.id === activeTerminalSessionId)
      ? activeTerminalSessionId
      : 'chat',
  );

  useEffect(() => {
    if (activeTerminalSessionId && agentSessions.some((s) => s.id === activeTerminalSessionId)) {
      setLocalTab(activeTerminalSessionId);
      return;
    }
    if (localTab !== 'chat' && !agentSessions.some((s) => s.id === localTab)) {
      setLocalTab(agentSessions[0]?.id ?? 'chat');
    }
  }, [activeTerminalSessionId, agentSessions, localTab]);

  const selectedAgent = localTab === 'chat'
    ? null
    : agentSessions.find((session) => session.id === localTab) ?? null;

  return (
    <div className="w-full h-full bg-forge-sidebar border-l border-forge-border/40 flex flex-col overflow-hidden">
      <div className="h-[34px] flex items-center justify-between border-b border-forge-border/50 bg-forge-titlebar select-none">
        <div className="flex items-center min-w-0 overflow-x-auto sidebar-scroll">
          <button
            onClick={() => setLocalTab('chat')}
            className={`h-[34px] px-3 flex items-center gap-1.5 border-b-2 text-[12px] flex-shrink-0 ${
              localTab === 'chat'
                ? 'border-forge-accent text-forge-text-strong'
                : 'border-transparent text-forge-text/65 hover:text-forge-text'
            }`}
          >
            <MessageSquare size={13} />
            Chat
          </button>
          {agentSessions.map((session) => (
            <button
              key={session.id}
              onClick={() => {
                setLocalTab(session.id);
                setActiveTerminalSession(session.id);
              }}
              className={`group h-[34px] px-3 flex items-center gap-1.5 border-b-2 text-[12px] max-w-[160px] flex-shrink-0 ${
                localTab === session.id
                  ? 'border-forge-accent text-forge-accent'
                  : 'border-transparent text-forge-text/65 hover:text-forge-text'
              }`}
              title={session.label}
            >
              <TerminalIcon size={13} />
              <span className="truncate">{session.label}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminalSession(session.id);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  closeTerminalSession(session.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-forge-text-strong"
                title="Close agent terminal"
              >
                <X size={11} />
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 px-2 flex-shrink-0">
          {selectedAgent && (
            <>
              <button
                onClick={() => runCommandInTerminalSession(selectedAgent.id, 'clear')}
                title="Clear terminal"
                className="h-7 w-7 rounded flex items-center justify-center text-forge-text/70 hover:text-forge-accent hover:bg-white/5"
              >
                <Eraser size={14} />
              </button>
              <button
                onClick={() => {
                  const agentId = selectedAgent.agentId;
                  closeTerminalSession(selectedAgent.id);
                  if (agentId) window.setTimeout(() => runAgentInTerminal(agentId), 0);
                }}
                title="Restart agent"
                className="h-7 w-7 rounded flex items-center justify-center text-forge-text/70 hover:text-forge-accent hover:bg-white/5"
              >
                <RotateCcw size={14} />
              </button>
            </>
          )}
          <button
            onClick={() => setRightPanelMaximized(!rightPanelMaximized)}
            title={rightPanelMaximized ? 'Restore panel width' : 'Maximize right panel'}
            className="h-7 w-7 rounded flex items-center justify-center text-forge-text/70 hover:text-forge-accent hover:bg-white/5"
          >
            {rightPanelMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            onClick={() => {
              if (localTab === 'chat') toggleAIPanel();
              else if (selectedAgent) closeTerminalSession(selectedAgent.id);
            }}
            title={localTab === 'chat' ? 'Hide chat' : 'Close agent terminal'}
            className="h-7 w-7 rounded flex items-center justify-center text-forge-text/70 hover:text-forge-accent hover:bg-white/5"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {localTab === 'chat' ? (
          aiPanelVisible ? (
            <AIPanel compact />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-forge-text/50 text-[12px]">
              <Bot size={28} />
              <p>AI chat is hidden.</p>
              <button
                onClick={toggleAIPanel}
                className="px-3 py-1.5 rounded bg-forge-accent/15 text-forge-accent hover:bg-forge-accent/25"
              >
                Show Chat
              </button>
            </div>
          )
        ) : selectedAgent ? (
          <TerminalsPanel
            visible
            kind="agents"
            sessionId={selectedAgent.id}
            hideTabs
            showNew={false}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-forge-text/50 text-[12px]">
            No agent terminal selected.
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const bottomPanelVisible = useStore((s) => s.bottomPanelVisible);
  const bottomPanelHeight = useStore((s) => s.bottomPanelHeight);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePanel = useStore((s) => s.togglePanel);
  const saveFile = useStore((s) => s.saveFile);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const quickOpenOpen = useStore((s) => s.quickOpenOpen);
  const zoomIn = useStore((s) => s.zoomIn);
  const zoomOut = useStore((s) => s.zoomOut);
  const resetZoom = useStore((s) => s.resetZoom);
  const subscribeToFsChanges = useStore((s) => s.subscribeToFsChanges);
  const openFolder = useStore((s) => s.openFolder);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const setBottomPanelHeight = useStore((s) => s.setBottomPanelHeight);
  const aiPanelVisible = useStore((s) => s.aiPanelVisible);
  const aiPanelWidth = useStore((s) => s.aiPanelWidth);
  const setAIPanelWidth = useStore((s) => s.setAIPanelWidth);
  const agentTerminalDock = useStore((s) => s.agentTerminalDock);
  const hasAgentTerminal = useStore((s) => s.terminalSessions.some((session) => session.agentId));
  const rightPanelMaximized = useStore((s) => s.rightPanelMaximized);
  const refreshAIConfig = useStore((s) => s.refreshAIConfig);
  const refreshExtensions = useStore((s) => s.refreshExtensions);
  const refreshLiveServerStatus = useStore((s) => s.refreshLiveServerStatus);
  const _setLiveServerStatus = useStore((s) => s._setLiveServerStatus);

  // Ref to the editor+terminal container so we can clamp the terminal height
  // against the actually-available vertical space when dragging.
  const editorColumnRef = useRef<HTMLDivElement>(null);

  // Subscribe to workspace file system change notifications once on mount.
  // The subscription itself is cheap; refreshes only happen when the main
  // process emits an event for the currently-watched workspace.
  useEffect(() => {
    const unsubscribe = subscribeToFsChanges();
    return unsubscribe;
  }, [subscribeToFsChanges]);

  // Load AI configuration (configured providers / active provider) from disk.
  useEffect(() => {
    void refreshAIConfig();
  }, [refreshAIConfig]);

  // Mirror LSP diagnostics into the global store so the Problems panel can
  // render them independently from Monaco markers.
  useEffect(() => {
    lspClient.setProblemsHandler((filePath, problems) => {
      const state = useStore.getState();
      if (!filePath) state.clearProblems();
      else state.updateProblemsForFile(filePath, problems);
    });
    return () => lspClient.setProblemsHandler(null);
  }, []);

  // Load installed VSIX/Open VSX extensions from disk.
  useEffect(() => {
    void refreshExtensions();
  }, [refreshExtensions]);

  // Mirror the extension host's state. Observation only — commands travel
  // through main, which is the sole broker of the host (design §1.2).
  useEffect(() => useStore.getState().watchExtensionHost(), []);

  // Extension settings can change from the main process (workspace switch,
  // another window's write): re-resolve the configuration on every push.
  useEffect(() => {
    const subscription = window.electronAPI?.ext?.onConfigurationChanged?.(() => {
      void useStore.getState().refreshExtensionConfiguration();
    });
    return () => subscription?.dispose();
  }, []);

  // Workspace Trust also changes from the main process (workspace switch,
  // a decision taken in another window): follow the push, and re-list the
  // extensions because their activation policy depends on it.
  useEffect(() => {
    void useStore.getState().refreshWorkspaceTrust();
    const subscription = window.electronAPI?.ext?.onTrustChanged?.((status) => {
      useStore.getState().applyWorkspaceTrust(status);
      void useStore.getState().refreshExtensions();
    });
    return () => subscription?.dispose();
  }, []);

  // Publish the workbench context keys that extension when-clauses read
  // (`workspaceOpen`, `editorLangId`, …). Mirrored from the store so a
  // clause like "editorLangId == python" tracks the active tab live.
  useEffect(() => {
    const publish = (state: ReturnType<typeof useStore.getState>) => {
      const activeTab = state.openTabs.find((tab) => tab.id === state.activeTabId);
      contextKeys.set('workspaceOpen', Boolean(state.workspacePath));
      contextKeys.set('editorIsOpen', Boolean(activeTab));
      contextKeys.set('editorLangId', activeTab?.language);
      contextKeys.set('sidebarVisible', state.sidebarVisible);
      contextKeys.set('panelVisible', state.bottomPanelVisible);
      contextKeys.set('gitOpenRepositoryCount', state.gitIsRepo ? 1 : 0);
      // `resource*` keys for the file in the active editor — what
      // `editor/context` items gate on (`resourceExtname == '.md'`).
      for (const [key, value] of Object.entries(editorResourceContext(activeTab ?? null))) {
        contextKeys.set(key, value);
      }
    };
    publish(useStore.getState());
    return useStore.subscribe(publish);
  }, []);

  // Keep Claude Code's IDE bridge informed about the current workspace and
  // open text editors. The main process owns the WebSocket server; the
  // renderer owns editor state, so this is the mirror between them.
  useEffect(() => {
    publishClaudeEditorState();
    const unsubscribe = useStore.subscribe((state, prev) => {
      if (
        state.workspacePath === prev.workspacePath &&
        state.workspaceName === prev.workspaceName &&
        state.openTabs === prev.openTabs &&
        state.activeTabId === prev.activeTabId
      ) {
        return;
      }
      publishClaudeEditorState();
    });
    return unsubscribe;
  }, []);

  // Main asks the renderer to perform editor actions for Claude MCP tools.
  useEffect(() => {
    if (!window.electronAPI?.claudeIde) return;
    const disposable = window.electronAPI.claudeIde.onCommand(async (command, args) => {
      const state = useStore.getState();
      if (command === 'openFile') {
        return state.openFilePath(String(args?.filePath || ''), {
          startText: typeof args?.startText === 'string' ? args.startText : undefined,
          endText: typeof args?.endText === 'string' ? args.endText : undefined,
          selectToEndOfLine: Boolean(args?.selectToEndOfLine),
          makeFrontmost: args?.makeFrontmost !== false,
        });
      }
      if (command === 'saveDocument') {
        const filePath = String(args?.filePath || '');
        const tab = state.openTabs.find((t) => (
          t.path === filePath ||
          toFileUri(t.path) === filePath ||
          t.name === filePath ||
          basename(t.path) === filePath
        ));
        if (!tab) {
          return { success: false, saved: false, message: `Document not open: ${filePath}` };
        }
        await state.saveFile(tab.id);
        return { success: true, saved: true, filePath: tab.path };
      }
      if (command === 'closeTab') {
        const tabName = String(args?.tabName || '');
        const tab = state.openTabs.find((t) => (
          t.name === tabName ||
          t.path === tabName ||
          basename(t.path) === tabName
        ));
        if (!tab) return { closed: false };
        state.closeTab(tab.id);
        return { closed: true };
      }
      return { success: false, message: `Unknown renderer command: ${command}` };
    });
    return () => disposable.dispose();
  }, []);

  // Subscribe to Live Server status changes emitted by the main process and
  // hydrate the initial status on mount. The main process is the source of
  // truth for the running HTTP server, so the renderer mirrors its state.
  useEffect(() => {
    if (!window.electronAPI?.liveServer) return;
    void refreshLiveServerStatus();
    const dispose = window.electronAPI.liveServer.onStatusChange((status) => {
      _setLiveServerStatus(status);
    });
    return () => dispose.dispose();
  }, [refreshLiveServerStatus, _setLiveServerStatus]);

  // Auto-restore the last workspace when the main process emits it.
  useEffect(() => {
    if (!window.electronAPI?.onWorkspaceRestore) return;

    const disposable = window.electronAPI.onWorkspaceRestore((workspacePath) => {
      void openFolder(workspacePath);
    });

    return () => disposable.dispose();
  }, [openFolder]);

  // Persist the AI conversation to `.forge/history.json` on every change,
  // debounced so quick stream updates don't thrash the disk. The store
  // action no-ops when the workspace hasn't been /init-ed yet.
  useEffect(() => {
    const unsubscribe = useStore.subscribe((state, prev) => {
      if (
        state.aiMessages === prev.aiMessages &&
        state.workspacePath === prev.workspacePath &&
        state.aiInitDone === prev.aiInitDone
      ) {
        return;
      }
      if (!state.aiInitDone || !state.workspacePath) return;

      // Debounce per-workspace.
      const w = window as unknown as {
        __forgeHistorySaveTimer?: ReturnType<typeof setTimeout>;
      };
      if (w.__forgeHistorySaveTimer) {
        clearTimeout(w.__forgeHistorySaveTimer);
      }
      w.__forgeHistorySaveTimer = setTimeout(() => {
        void useStore.getState().saveProjectHistory();
      }, 800);
    });
    return unsubscribe;
  }, []);

  // Global keyboard shortcuts.
  //
  // We normalize `e.key` to lowercase so the shortcuts keep working when Caps
  // Lock is on, and accept either Ctrl (Win/Linux) or Meta/Cmd (macOS) as the
  // primary modifier so the same combos feel native everywhere.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && !e.shiftKey && key === 's') {
        e.preventDefault();
        saveFile();
        return;
      }
      if (mod && !e.shiftKey && key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (mod && !e.shiftKey && key === '`') {
        e.preventDefault();
        togglePanel();
        return;
      }
      if (mod && e.shiftKey && key === 'p') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
        return;
      }
      if (mod && !e.shiftKey && key === 'p') {
        e.preventDefault();
        setQuickOpenOpen(!quickOpenOpen);
        return;
      }
      // Tab management: Ctrl+W closes the active tab; Ctrl+Tab /
      // Ctrl+Shift+Tab cycle through open tabs.
      if (mod && !e.shiftKey && key === 'w') {
        e.preventDefault();
        const s = useStore.getState();
        if (s.activeTabId) s.closeTab(s.activeTabId);
        return;
      }
      if (mod && key === 'tab') {
        e.preventDefault();
        useStore.getState().cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      // Zoom: Ctrl+= / Ctrl++ / Ctrl+NumpadAdd zoom in; Ctrl+- zoom out;
      // Ctrl+0 reset. Accept either Ctrl (Win/Linux) or Meta (macOS).
      if (mod && !e.altKey) {
        const zoomInKey =
          key === '+' ||
          (!e.shiftKey && key === '=') ||
          e.code === 'NumpadAdd';
        const zoomOutKey =
          key === '-' ||
          key === '_' ||
          e.code === 'NumpadSubtract';
        const resetZoomKey =
          !e.shiftKey && (key === '0' || e.code === 'Numpad0');

        if (zoomInKey) {
          e.preventDefault();
          zoomIn();
          return;
        }
        if (zoomOutKey) {
          e.preventDefault();
          zoomOut();
          return;
        }
        if (resetZoomKey) {
          e.preventDefault();
          resetZoom();
          return;
        }
      }
      if (e.key === 'Escape' && commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
      if (e.key === 'Escape' && quickOpenOpen) {
        setQuickOpenOpen(false);
      }

      // Extension keybindings run after every native shortcut, so a VSIX
      // can never shadow Forge's own keys. The event is consumed only when
      // a command handler actually ran.
      if (extensionKeybindingService.dispatch(e)) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    saveFile,
    toggleSidebar,
    togglePanel,
    setCommandPaletteOpen,
    commandPaletteOpen,
    setQuickOpenOpen,
    quickOpenOpen,
    zoomIn,
    zoomOut,
    resetZoom,
  ]);

  // Ctrl/Cmd + mouse wheel zoom (editor font size).
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else if (e.deltaY > 0) {
        zoomOut();
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [zoomIn, zoomOut]);

  // ── Sidebar drag handler ─────────────────────────────────────────────
  const handleSidebarDrag = (clientX: number) => {
    // The sidebar starts at column 1 (left edge), so clientX *is* the new
    // width. Clamp to [SIDEBAR_MIN, SIDEBAR_MAX].
    const width = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, clientX));
    setSidebarWidth(width);
  };

  // ── Bottom panel drag handler ────────────────────────────────────────
  const handleBottomDrag = (clientY: number) => {
    const container = editorColumnRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // Distance from the divider to the bottom of the available column
    // becomes the new terminal height.
    const proposed = rect.bottom - clientY;
    const maxAllowed = Math.max(BOTTOM_MIN, rect.height - EDITOR_MIN);
    const clamped = Math.max(BOTTOM_MIN, Math.min(maxAllowed, proposed));
    setBottomPanelHeight(clamped);
  };

  // ── AI panel (right) drag handler ────────────────────────────────────
  const handleAIPanelDrag = (clientX: number) => {
    // The AI panel sits flush against the right edge of the viewport, so its
    // width is the distance from the cursor to the right edge.
    const proposed = window.innerWidth - clientX;
    const clamped = Math.max(AI_PANEL_MIN, Math.min(AI_PANEL_MAX, proposed));
    setAIPanelWidth(clamped);
  };

  // CSS Grid:
  //   Row 1: TitleBar 32px
  //   Row 2: ActivityBar 40px
  //   Row 3: Sidebar | leftDivider | Editor (1fr) | rightDivider | AIPanel
  //   Row 4: StatusBar 22px
  const sidebarOverlay = sidebarVisible && viewportWidth < 720;
  const effectiveSidebarWidth = Math.min(sidebarWidth, Math.max(SIDEBAR_MIN, viewportWidth - EDITOR_MIN_WIDTH));
  const rightAgentPanelVisible = agentTerminalDock === 'right' && hasAgentTerminal;
  const rightPanelVisible = aiPanelVisible || rightAgentPanelVisible;
  const requestedRightWidth = rightPanelMaximized ? Math.max(520, viewportWidth * 0.58) : aiPanelWidth;
  const availableWidth = viewportWidth - (sidebarVisible && !sidebarOverlay ? effectiveSidebarWidth + DIVIDER_HIT : 0);
  // An overlay preserves the editor width without overwriting saved panel sizes.
  const rightPanelOverlay = rightPanelVisible && availableWidth - requestedRightWidth < EDITOR_MIN_WIDTH;
  const effectiveRightWidth = Math.min(requestedRightWidth, viewportWidth - 24);
  const sidebarPart = sidebarVisible && !sidebarOverlay
    ? `${effectiveSidebarWidth}px ${DIVIDER_HIT}px`
    : '0px 0px';
  const aiPart = rightPanelVisible && !rightPanelOverlay
    ? `${DIVIDER_HIT}px ${effectiveRightWidth}px`
    : '0px 0px';
  const gridTemplateColumns = `${sidebarPart} minmax(0, 1fr) ${aiPart}`;

  return (
    <div
      className="relative w-screen h-screen grid overflow-hidden bg-forge-bg text-forge-text text-[13px]"
      style={{
        gridTemplateRows: '32px 40px minmax(0, 1fr) 22px',
        gridTemplateColumns,
      }}
    >
      {/* Row 1: TitleBar (full width) */}
      <div style={{ gridColumn: '1 / -1', gridRow: '1' }}>
        <TitleBar />
      </div>

      {/* Row 2: ActivityBar (full width, horizontal) */}
      <div style={{ gridColumn: '1 / -1', gridRow: '2' }}>
        <ActivityBar />
      </div>

      {/* Row 3 - Col 1: SideBar */}
      <div
        className={sidebarOverlay ? 'absolute left-0 top-[72px] bottom-[22px] z-20 overflow-hidden border-r border-forge-border shadow-2xl' : 'min-h-0 overflow-hidden'}
        style={sidebarOverlay ? { width: Math.min(sidebarWidth, viewportWidth - 48) } : { gridColumn: '1', gridRow: '3' }}
      >
        {sidebarVisible && <SideBar />}
      </div>

      {/* Row 3 - Col 2: vertical drag divider.
          The wrapper is explicitly sized so the divider's `height: 100%`
          resolves against a known box. */}
      {sidebarVisible && !sidebarOverlay && (
        <div
          style={{
            gridColumn: '2',
            gridRow: '3',
            width: '100%',
            height: '100%',
            position: 'relative',
            overflow: 'visible',
          }}
        >
          <ResizeDivider orientation="vertical" label="Ancho del explorador" value={effectiveSidebarWidth} onDrag={handleSidebarDrag} />
        </div>
      )}

      {/* Row 3 - Col 3: Editor + Bottom panel */}
      <div
        ref={editorColumnRef}
        className="min-w-0 min-h-0 flex flex-col overflow-hidden"
        style={{ gridColumn: '3', gridRow: '3' }}
      >
        <div className="flex-1 overflow-hidden min-h-0">
          <EditorArea />
        </div>
        {bottomPanelVisible && (
          <>
            <ResizeDivider orientation="horizontal" label="Altura de la terminal" value={bottomPanelHeight} onDrag={handleBottomDrag} />
            <BottomPanel />
          </>
        )}
      </div>

      {/* Row 3 - Col 4: right vertical drag divider */}
      {rightPanelVisible && !rightPanelOverlay && (
        <div
          style={{
            gridColumn: '4',
            gridRow: '3',
            width: '100%',
            height: '100%',
            position: 'relative',
            overflow: 'visible',
          }}
        >
          <ResizeDivider orientation="vertical" label="Ancho del asistente" value={effectiveRightWidth} onDrag={handleAIPanelDrag} />
        </div>
      )}

      {/* Row 3 - Col 5: AI workspace */}
      <div
        className={rightPanelOverlay ? 'absolute right-0 top-[72px] bottom-[22px] z-30 overflow-hidden border-l border-forge-border shadow-2xl' : 'min-h-0 overflow-hidden'}
        style={rightPanelOverlay ? { width: effectiveRightWidth } : { gridColumn: '5', gridRow: '3' }}
      >
        {rightPanelVisible && <RightWorkspace />}
      </div>

      {/* Row 4: StatusBar (full width) */}
      <div style={{ gridColumn: '1 / -1', gridRow: '4' }}>
        <StatusBar />
      </div>

      {/* Command Palette overlay */}
      {commandPaletteOpen && <CommandPalette />}
      {quickOpenOpen && <QuickOpen />}
      <RemoteSSHModal />
      <ExtensionNotifications />
    </div>
  );
}
