import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../../store';
import { lspClient } from '../../lsp/client';
import { isHtmlFile, type GitChange, type Tab, type TreeNode } from '../../types';
import { gitStatusLabel } from '../../utils/gitHelpers';
import { fileIconUrl, findIconTheme, folderIconUrl } from '../../extensions/iconTheme';
import { buildMenuItems, explorerResourceContext, filterMenuItems, type ResolvedMenuItem } from '../../extensions/menus';
import { contextKeys } from '../../extensions/contextKeys';
import { extensionCommandService } from '../../extensions/registry';
import { Loader2, GitCommit, ChevronRight, ChevronDown, File, Folder, FolderOpen, Plus, Search, GitBranch, Bug, Blocks, ListTree, History, Globe, RefreshCw, Pencil, Trash2, XCircle } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns the set of folder paths that lie on the directory chain of the
 * currently active editor file. Used to highlight ancestors of the open file.
 */
function getActiveFolderPaths(activeFilePath: string | null): Set<string> {
  const result = new Set<string>();
  if (!activeFilePath) return result;

  const sep =
    activeFilePath.includes('\\') && !activeFilePath.includes('/')
      ? '\\'
      : '/';

  let cur = activeFilePath;
  while (cur.includes(sep)) {
    cur = cur.substring(0, cur.lastIndexOf(sep));
    if (cur) result.add(cur);
  }
  return result;
}

function joinPath(parent: string, child: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.endsWith(sep) ? `${parent}${child}` : `${parent}${sep}${child}`;
}


function gitStatusTitle(change: GitChange): string {
  const code = gitStatusLabel(change);
  const labels: Record<string, string> = {
    M: 'Modificado',
    A: 'Agregado',
    D: 'Eliminado',
    R: 'Renombrado',
    C: 'Copiado',
    U: 'Sin seguimiento',
  };
  return labels[code] || code;
}

function isStaged(change: GitChange): boolean {
  return change.x !== ' ' && change.x !== '?' && change.x !== '';
}

function isUnstaged(change: GitChange): boolean {
  return change.y !== ' ' && change.y !== '';
}

function toWorkspaceRelPath(workspacePath: string | null, filePath: string): string {
  if (!workspacePath) return filePath.replace(/\\/g, '/');
  const root = workspacePath.replace(/\\/g, '/');
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized;
}

function changeForPath(changes: GitChange[], workspacePath: string | null, filePath: string): GitChange | null {
  const rel = toWorkspaceRelPath(workspacePath, filePath);
  return changes.find((change) => change.relPath === rel) || null;
}

function folderHasChanges(changes: GitChange[], workspacePath: string | null, folderPath: string): boolean {
  const rel = toWorkspaceRelPath(workspacePath, folderPath);
  const prefix = rel ? `${rel}/` : '';
  return changes.some((change) => change.relPath.startsWith(prefix));
}

function gitBadgeClass(change: GitChange): string {
  const label = gitStatusLabel(change);
  if (label === 'D') return 'text-red-400';
  if (label === 'U' || label === 'A') return 'text-forge-accent';
  return 'text-[#FFCB6B]';
}


// ─────────────────────────────────────────────────────────────────────────
// Context Menu
// ─────────────────────────────────────────────────────────────────────────
interface CtxMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

function ContextMenu({
  state,
  extensionItems,
  onRunExtensionItem,
  onClose,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onCopyRelativePath,
  onRevealInFolder,
  onLiveServerToggle,
  liveServerActive,
  liveServerHtmlPath,
}: {
  state: CtxMenuState;
  /** `explorer/context` items from extensions, already when-filtered. */
  extensionItems: ResolvedMenuItem[];
  onRunExtensionItem: (item: ResolvedMenuItem) => void;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onRevealInFolder: () => void;
  /** Optional handler that toggles the live server on this HTML file. */
  onLiveServerToggle: () => void;
  /** Current live-server state — used to decide between "Iniciar" / "Detener". */
  liveServerActive: boolean;
  /** Absolute path of the HTML file that the live server is currently
   *  rooted on (for "Detener" — null when no server is running). */
  liveServerHtmlPath: string | null;
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

  // Show the Live Server entry on HTML files. Wording:
  //   - "Iniciar Live Server" when no server is running, OR a server is
  //     running on a different file (we'll restart it on this file).
  //   - "Detener Live Server" when the server is rooted on THIS file's
  //     directory and serving THIS file.
  const isHtml = state.node.type === 'file' && isHtmlFile(state.node.path);
  const isServingThisFile =
    liveServerActive &&
    liveServerHtmlPath !== null &&
    liveServerHtmlPath === state.node.path;
  const liveServerLabel = isServingThisFile
    ? 'Detener Live Server'
    : 'Iniciar Live Server';

  return (
    <div
      ref={ref}
      className="context-menu fixed"
      style={{ top: state.y, left: state.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {isHtml && (
        <>
          <div
            className="context-menu-item flex items-center gap-2"
            onClick={() => {
              onLiveServerToggle();
              onClose();
            }}
          >
            <Globe
              size={13}
              className={isServingThisFile ? 'text-forge-accent' : 'text-forge-text/70'}
            />
            <span>{liveServerLabel}</span>
          </div>
          <div className="context-menu-divider" />
        </>
      )}
      <div className="context-menu-item" onClick={() => { onNewFile(); onClose(); }}>Nuevo archivo</div>
      <div className="context-menu-item" onClick={() => { onNewFolder(); onClose(); }}>Nueva carpeta</div>
      <div className="context-menu-divider" />
      <div className="context-menu-item" onClick={() => { onCopyPath(); onClose(); }}>Copiar ruta</div>
      <div className="context-menu-item" onClick={() => { onCopyRelativePath(); onClose(); }}>Copiar ruta relativa</div>
      <div className="context-menu-item" onClick={() => { onRevealInFolder(); onClose(); }}>Mostrar en administrador de archivos</div>
      <div className="context-menu-divider" />
      <div className="context-menu-item" onClick={() => { onRename(); onClose(); }}>Renombrar</div>
      <div className="context-menu-item" onClick={() => { onDelete(); onClose(); }}>Eliminar</div>
      {extensionItems.length > 0 && (
        <>
          <div className="context-menu-divider" />
          {extensionItems.map((item) => (
            <div
              key={`${item.ownerId}:${item.command}`}
              className="context-menu-item"
              title={item.command}
              onClick={() => { onRunExtensionItem(item); onClose(); }}
            >
              {item.title}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// File Tree Item
// ─────────────────────────────────────────────────────────────────────────
interface InlineCreate {
  parentPath: string;
  type: 'file' | 'folder';
}

function TreeItem({
  node,
  depth,
  activeFolderPaths,
  onContextMenu,
  inlineCreate,
  setInlineCreate,
  renameNodeId,
  setRenameNodeId,
}: {
  node: TreeNode;
  depth: number;
  activeFolderPaths: Set<string>;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  inlineCreate: InlineCreate | null;
  setInlineCreate: (i: InlineCreate | null) => void;
  renameNodeId: string | null;
  setRenameNodeId: (id: string | null) => void;
}) {
  const expandedFolders = useStore((s) => s.expandedFolders);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const openFile = useStore((s) => s.openFile);
  const activeTabId = useStore((s) => s.activeTabId);
  const openTabs = useStore((s) => s.openTabs);
  const workspacePath = useStore((s) => s.workspacePath);
  const gitChanges = useStore((s) => s.gitChanges);
  const selectedPath = useStore((s) => s.selectedPath);
  const setSelectedPath = useStore((s) => s.setSelectedPath);
  const createNewFile = useStore((s) => s.createNewFile);
  const createNewDirectory = useStore((s) => s.createNewDirectory);
  const renameItem = useStore((s) => s.renameItem);

  const installedExtensions = useStore((s) => s.installedExtensions);
  const activeIconTheme = useStore((s) => s.activeIconTheme);

  const isExpanded = expandedFolders.has(node.id);
  const isDirectory = node.type === 'directory';

  // Active extension icon theme, when one is selected. `null` falls back to
  // the built-in lucide icons below.
  const themedIconUrl = useMemo(() => {
    const theme = findIconTheme(installedExtensions, activeIconTheme);
    if (!theme) return null;
    return isDirectory
      ? folderIconUrl(theme, node.name, isExpanded)
      : fileIconUrl(theme, node.name);
  }, [installedExtensions, activeIconTheme, isDirectory, node.name, isExpanded]);
  const isActiveFile = activeTabId === node.path;
  const isActiveFolder = isDirectory && activeFolderPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const gitChange = !isDirectory ? changeForPath(gitChanges, workspacePath, node.path) : null;
  const hasNestedGitChange = isDirectory && folderHasChanges(gitChanges, workspacePath, node.path);
  const hasUnsavedFile = !isDirectory && openTabs.some((tab) => tab.path === node.path && tab.isUnsaved);
  const hasNestedUnsavedFile = isDirectory && openTabs.some((tab) => (
    tab.isUnsaved &&
    toWorkspaceRelPath(workspacePath, tab.path).startsWith(`${toWorkspaceRelPath(workspacePath, node.path)}/`)
  ));

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Always update sidebar selection.
    setSelectedPath({ path: node.path, kind: isDirectory ? 'directory' : 'file' });
    if (isDirectory) {
      toggleFolder(node.id);
    } else {
      openFile(node);
    }
  };

  // Color logic
  let textColor = '#D0D3DA';
  if (isDirectory && isActiveFolder) textColor = '#E52E3D';
  else if (!isDirectory && isActiveFile) textColor = '#FFFFFF';

  const isRenaming = renameNodeId === node.id;
  const showInlineCreate = inlineCreate && inlineCreate.parentPath === node.path && isDirectory && isExpanded;

  return (
    <>
      {!isRenaming && (
        <div
          onClick={handleClick}
          onContextMenu={(e) => {
            // Right-click also selects
            setSelectedPath({ path: node.path, kind: isDirectory ? 'directory' : 'file' });
            onContextMenu(e, node);
          }}
          className="tree-item flex items-center cursor-pointer h-[24px] pr-2 transition-colors"
          style={{
            paddingLeft: `${depth * 14 + 8}px`,
            color: textColor,
            backgroundColor: isSelected ? 'rgba(229, 46, 61, 0.1)' : 'transparent',
          }}
        >
          {isDirectory ? (
            <span className="mr-0.5 flex-shrink-0">
              {isExpanded ? (
                <ChevronDown size={14} style={{ color: textColor }} />
              ) : (
                <ChevronRight size={14} style={{ color: textColor }} />
              )}
            </span>
          ) : (
            <span className="w-[14px] mr-0.5 flex-shrink-0" />
          )}

          <span className="mr-1.5 flex-shrink-0 inline-flex items-center">
            {themedIconUrl ? (
              <img
                src={themedIconUrl}
                alt=""
                className="w-[15px] h-[15px] object-contain"
                draggable={false}
              />
            ) : isDirectory ? (
              isExpanded ? (
                <FolderOpen size={15} style={{ color: textColor }} />
              ) : (
                <Folder size={15} style={{ color: textColor }} />
              )
            ) : (
              <File size={14} style={{ color: textColor }} />
            )}
          </span>

          <span className="truncate text-[13px]" style={{ color: textColor }}>
            {node.name}
          </span>
          <span className="ml-auto flex items-center gap-1 pl-2 flex-shrink-0">
            {(hasUnsavedFile || hasNestedUnsavedFile) && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-forge-text/70"
                title="Cambios sin guardar"
              />
            )}
            {gitChange && (
              <span
                className={`text-[10px] font-semibold ${gitBadgeClass(gitChange)}`}
                title={gitStatusTitle(gitChange)}
              >
                {gitStatusLabel(gitChange)}
              </span>
            )}
            {!gitChange && hasNestedGitChange && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-forge-accent/80"
                title="La carpeta contiene cambios en Git"
              />
            )}
          </span>
        </div>
      )}

      {isRenaming && (
        <RenameInput
          initial={node.name}
          depth={depth}
          onSubmit={async (name) => {
            const trimmed = name.trim();
            if (trimmed && trimmed !== node.name) {
              await renameItem(node.path, trimmed);
            }
            setRenameNodeId(null);
          }}
          onCancel={() => setRenameNodeId(null)}
        />
      )}

      {isDirectory && isExpanded && node.children && (
        <div>
          {showInlineCreate && (
            <NewItemInput
              type={inlineCreate!.type}
              depth={depth + 1}
              onSubmit={async (name) => {
                const trimmed = name.trim();
                if (trimmed) {
                  if (inlineCreate!.type === 'file') {
                    await createNewFile(node.path, trimmed);
                  } else {
                    await createNewDirectory(node.path, trimmed);
                  }
                }
                setInlineCreate(null);
              }}
              onCancel={() => setInlineCreate(null)}
            />
          )}
          {node.children.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              activeFolderPaths={activeFolderPaths}
              onContextMenu={onContextMenu}
              inlineCreate={inlineCreate}
              setInlineCreate={setInlineCreate}
              renameNodeId={renameNodeId}
              setRenameNodeId={setRenameNodeId}
            />
          ))}
        </div>
      )}
    </>
  );
}

// Inline input for creating a new file/folder under a folder.
//
// Focus handling notes:
//  • We focus on mount via a `setTimeout(0)` so that any in-flight re-renders
//    (e.g. from the dropdown closing or `expandFolder` updating the
//    `expandedFolders` Set) settle before we ask the input to take focus.
//  • Click / mousedown propagation is stopped on both the wrapper and the
//    input so the explorer's `onClick={handleEmptyClick}` (which clears the
//    sidebar selection and triggers a re-render) doesn't fight us.
//  • A `submittedRef` guards against double-submission caused by Enter
//    triggering `onBlur` immediately after `onSubmit`.
//  • Key events are also stopped from bubbling so the global Ctrl+S / Esc
//    handlers in App.tsx don't intercept what the user is typing.
function NewItemInput({
  type,
  depth,
  onSubmit,
  onCancel,
}: {
  type: 'file' | 'folder';
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    // Defer focus to the next tick so any concurrent re-renders settle first.
    const id = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      // Keep the cursor at the end if the field already has a value.
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* noop */ }
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const submit = (name: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(name);
  };

  const cancel = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onCancel();
  };

  return (
    <div
      className="flex items-center h-[26px] pr-2"
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="w-[14px] mr-0.5 flex-shrink-0" />
      <span className="mr-1.5 flex-shrink-0 inline-flex items-center">
        {type === 'folder' ? (
          <Folder size={15} className="text-forge-accent" />
        ) : (
          <File size={14} className="text-forge-accent" />
        )}
      </span>
      <input
        ref={ref}
        className="flex-1 bg-forge-input text-forge-text text-[13px] px-1.5 py-0.5 border border-forge-accent outline-none rounded-sm"
        placeholder={type === 'file' ? 'nombre.ext' : 'nombre de carpeta'}
        value={val}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setVal(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(e) => {
          // Don't let global shortcuts hijack typing.
          e.stopPropagation();
          if (composingRef.current) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            submit(val);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => submit(val)}
      />
    </div>
  );
}

function RenameInput({
  initial,
  depth,
  onSubmit,
  onCancel,
}: {
  initial: string;
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      try { el.select(); } catch { /* noop */ }
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const submit = (name: string) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(name);
  };

  const cancel = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onCancel();
  };

  return (
    <div
      className="flex items-center h-[26px] pr-2"
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="w-[14px] mr-0.5 flex-shrink-0" />
      <span className="mr-1.5 flex-shrink-0 inline-flex items-center">
        <File size={14} className="text-forge-accent" />
      </span>
      <input
        ref={ref}
        className="flex-1 bg-forge-input text-forge-text text-[13px] px-1.5 py-0.5 border border-forge-accent outline-none rounded-sm"
        value={val}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setVal(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (composingRef.current) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            submit(val);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => submit(val)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Add (+) Dropdown
// ─────────────────────────────────────────────────────────────────────────
function AddDropdown({
  onPick,
  onClose,
}: {
  onPick: (type: 'file' | 'folder') => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<'file' | 'folder' | null>(null);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="dropdown-menu absolute right-2 top-9 z-30 py-1 min-w-[140px]"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="block w-full text-left px-3 py-1.5 text-[13px] transition-colors"
        style={{ color: hover === 'file' ? '#E52E3D' : '#D3D5DE' }}
        onMouseEnter={() => setHover('file')}
        onMouseLeave={() => setHover(null)}
        onClick={() => onPick('file')}
      >
        Nuevo archivo
      </button>
      <button
        className="block w-full text-left px-3 py-1.5 text-[13px] transition-colors"
        style={{ color: hover === 'folder' ? '#E52E3D' : '#D3D5DE' }}
        onMouseEnter={() => setHover('folder')}
        onMouseLeave={() => setHover(null)}
        onClick={() => onPick('folder')}
      >
        Nueva carpeta
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Header Context Menu ("Close Folder")
// ─────────────────────────────────────────────────────────────────────────
interface HeaderCtxMenuState {
  x: number;
  y: number;
}

function HeaderContextMenu({
  state,
  onClose,
  onCloseFolder,
}: {
  state: HeaderCtxMenuState;
  onClose: () => void;
  onCloseFolder: () => void;
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

  return (
    <div
      ref={ref}
      className="context-menu fixed"
      style={{ top: state.y, left: state.x }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="context-menu-item"
        onClick={() => {
          onCloseFolder();
          onClose();
        }}
      >
        Cerrar carpeta
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Explorer Panel (file tree)
// ─────────────────────────────────────────────────────────────────────────
export default function ExplorerPanel() {
  const fileTree = useStore((s) => s.fileTree);
  const workspacePath = useStore((s) => s.workspacePath);
  const workspaceName = useStore((s) => s.workspaceName);
  const openFolder = useStore((s) => s.openFolder);
  const openRemoteWorkspace = useStore((s) => s.openRemoteWorkspace);
  const closeWorkspace = useStore((s) => s.closeWorkspace);
  const activeTabId = useStore((s) => s.activeTabId);
  const createNewFile = useStore((s) => s.createNewFile);
  const createNewDirectory = useStore((s) => s.createNewDirectory);
  const deleteItem = useStore((s) => s.deleteItem);
  const expandFolder = useStore((s) => s.expandFolder);
  const setSelectedPath = useStore((s) => s.setSelectedPath);
  const resolveCreateParent = useStore((s) => s.resolveCreateParent);
  // Live server state — used by the per-file context menu.
  const liveServerActive = useStore((s) => s.liveServerActive);
  const liveServerRoot = useStore((s) => s.liveServerRoot);
  const liveServerHtmlFile = useStore((s) => s.liveServerHtmlFile);
  const startLiveServer = useStore((s) => s.startLiveServer);
  const stopLiveServer = useStore((s) => s.stopLiveServer);
  const installedExtensions = useStore((s) => s.installedExtensions);

  // `contributes.menus` entries for the explorer, derived on demand from
  // the installed payloads — nothing to retire when an extension leaves.
  const explorerMenuItems = useMemo(
    () => buildMenuItems(installedExtensions, 'explorer/context'),
    [installedExtensions],
  );

  // Compute the full absolute path of the HTML file currently being served,
  // joining root + basename with the OS-appropriate separator. We don't have
  // `path.join` in the renderer, so reuse whichever separator is already in
  // use in the root path string.
  const liveServerHtmlPath = useMemo<string | null>(() => {
    if (!liveServerActive || !liveServerRoot || !liveServerHtmlFile) return null;
    const sep =
      liveServerRoot.includes('\\') && !liveServerRoot.includes('/') ? '\\' : '/';
    return liveServerRoot.endsWith(sep)
      ? `${liveServerRoot}${liveServerHtmlFile}`
      : `${liveServerRoot}${sep}${liveServerHtmlFile}`;
  }, [liveServerActive, liveServerRoot, liveServerHtmlFile]);

  // Always derive the display name from the workspace path so it is just the
  // last path segment (folder name), even on Windows back-slash paths.
  const folderDisplayName = useMemo(() => {
    if (workspaceName) return workspaceName;
    if (!workspacePath) return '';
    const segments = workspacePath.split(/[\\/]/).filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : workspacePath;
  }, [workspaceName, workspacePath]);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [inlineCreate, setInlineCreate] = useState<InlineCreate | null>(null);
  const [renameNodeId, setRenameNodeId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [headerCtxMenu, setHeaderCtxMenu] = useState<HeaderCtxMenuState | null>(null);

  // Folder-highlight chain — derived from the active tab's file path.
  // Re-computed on every activeTabId change so tab switches update the tree.
  const activeFolderPaths = useMemo(
    () => getActiveFolderPaths(activeTabId),
    [activeTabId]
  );

  // Smart "+" — uses the current sidebar selection to choose the parent.
  const handleAddPick = useCallback(
    (type: 'file' | 'folder') => {
      setDropdownOpen(false);
      const parent = resolveCreateParent();
      if (!parent) return;
      // If the parent is a folder we can drill into, expand it so the inline
      // input shows up where the new item will live.
      if (parent !== workspacePath) {
        // Find the matching node id (id === path in our tree)
        expandFolder(parent);
      }
      setInlineCreate({ parentPath: parent, type });
    },
    [resolveCreateParent, workspacePath, expandFolder]
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleCtxNewFile = useCallback(() => {
    if (!ctxMenu) return;
    const parentPath = ctxMenu.node.type === 'directory'
      ? ctxMenu.node.path
      : (ctxMenu.node.path.includes('/')
          ? ctxMenu.node.path.substring(0, ctxMenu.node.path.lastIndexOf('/'))
          : ctxMenu.node.path.substring(0, ctxMenu.node.path.lastIndexOf('\\')));
    if (ctxMenu.node.type === 'directory') expandFolder(ctxMenu.node.id);
    setInlineCreate({ parentPath, type: 'file' });
  }, [ctxMenu, expandFolder]);

  const handleCtxNewFolder = useCallback(() => {
    if (!ctxMenu) return;
    const parentPath = ctxMenu.node.type === 'directory'
      ? ctxMenu.node.path
      : (ctxMenu.node.path.includes('/')
          ? ctxMenu.node.path.substring(0, ctxMenu.node.path.lastIndexOf('/'))
          : ctxMenu.node.path.substring(0, ctxMenu.node.path.lastIndexOf('\\')));
    if (ctxMenu.node.type === 'directory') expandFolder(ctxMenu.node.id);
    setInlineCreate({ parentPath, type: 'folder' });
  }, [ctxMenu, expandFolder]);

  const handleCtxRename = useCallback(() => {
    if (!ctxMenu) return;
    setRenameNodeId(ctxMenu.node.id);
  }, [ctxMenu]);

  const handleCtxCopyPath = useCallback(() => {
    if (!ctxMenu) return;
    void navigator.clipboard.writeText(ctxMenu.node.path);
  }, [ctxMenu]);

  const handleCtxCopyRelativePath = useCallback(() => {
    if (!ctxMenu || !workspacePath) return;
    const norm = ctxMenu.node.path.replace(/\\/g, '/');
    const ws = workspacePath.replace(/\\/g, '/');
    const rel = norm.startsWith(ws + '/') ? norm.slice(ws.length + 1) : ctxMenu.node.path;
    void navigator.clipboard.writeText(rel);
  }, [ctxMenu, workspacePath]);

  const handleCtxRevealInFolder = useCallback(() => {
    if (!ctxMenu) return;
    void window.electronAPI.revealInFolder(ctxMenu.node.path);
  }, [ctxMenu]);

  const handleCtxDelete = useCallback(async () => {
    if (!ctxMenu) return;
    if (confirm(`¿Eliminar "${ctxMenu.node.name}"?`)) {
      await deleteItem(ctxMenu.node.path);
    }
  }, [ctxMenu, deleteItem]);

  // Toggle the live server for the right-clicked HTML file. When the server
  // is already serving THIS file, stop it; otherwise start (or restart) on
  // the new file.
  const handleCtxLiveServerToggle = useCallback(async () => {
    if (!ctxMenu) return;
    if (ctxMenu.node.type !== 'file') return;
    if (!isHtmlFile(ctxMenu.node.path)) return;

    if (liveServerActive && liveServerHtmlPath === ctxMenu.node.path) {
      await stopLiveServer();
    } else {
      await startLiveServer(ctxMenu.node.path);
    }
  }, [ctxMenu, liveServerActive, liveServerHtmlPath, startLiveServer, stopLiveServer]);

  // Click on empty area inside the explorer clears the sidebar selection so
  // that the next "+" creates at the workspace root.
  const handleEmptyClick = useCallback(() => {
    setSelectedPath(null);
  }, [setSelectedPath]);

  if (!workspacePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-forge-text">
        <p className="text-sm text-center">No hay una carpeta abierta</p>
        <button
          onClick={() => openFolder()}
          className="px-4 py-1.5 bg-forge-accent text-[#1F2025] text-sm font-semibold rounded hover:opacity-90 transition-opacity"
        >
          Abrir carpeta
        </button>
        <button
          onClick={() => openRemoteWorkspace()}
          className="px-4 py-1.5 border border-forge-border text-forge-text text-sm font-semibold rounded hover:bg-white/5 transition-colors"
        >
          Conectar por SSH
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full relative">
      {/* Top bar: folder name + add button */}
      <div className="flex items-center justify-between h-[36px] px-3 border-b border-forge-border/40">
        <button
          title={workspacePath ?? undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setHeaderCtxMenu({ x: e.clientX, y: e.clientY });
          }}
          className="flex items-center gap-1 text-forge-accent text-[13px] font-semibold uppercase tracking-wide truncate"
        >
          <span className="truncate">{folderDisplayName}</span>
          <ChevronDown size={14} className="flex-shrink-0" />
        </button>

        <button
          onClick={() => setDropdownOpen((v) => !v)}
          title="Nuevo…"
          className="p-1 rounded hover:bg-white/5 transition-colors"
        >
          <Plus size={16} className="text-forge-accent" />
        </button>

        {dropdownOpen && (
          <AddDropdown onPick={handleAddPick} onClose={() => setDropdownOpen(false)} />
        )}
      </div>

      {/* Inline create at root */}
      {inlineCreate && inlineCreate.parentPath === workspacePath && (
        <NewItemInput
          type={inlineCreate.type}
          depth={0}
          onSubmit={async (name) => {
            const trimmed = name.trim();
            if (trimmed) {
              if (inlineCreate.type === 'file') {
                await createNewFile(workspacePath, trimmed);
              } else {
                await createNewDirectory(workspacePath, trimmed);
              }
            }
            setInlineCreate(null);
          }}
          onCancel={() => setInlineCreate(null)}
        />
      )}

      {/* File Tree */}
      <div
        className="flex-1 overflow-y-auto sidebar-scroll py-1"
        onClick={handleEmptyClick}
      >
        {fileTree.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            activeFolderPaths={activeFolderPaths}
            onContextMenu={handleContextMenu}
            inlineCreate={inlineCreate}
            setInlineCreate={setInlineCreate}
            renameNodeId={renameNodeId}
            setRenameNodeId={setRenameNodeId}
          />
        ))}
      </div>

      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          extensionItems={filterMenuItems(explorerMenuItems, (when) =>
            contextKeys.match(when, explorerResourceContext(ctxMenu.node)),
          )}
          onRunExtensionItem={(item) => {
            // Handlers arrive with the Extension Host; without one this is
            // a well-reported no-op. The resource path travels as the
            // argument, matching VS Code's contract for explorer commands.
            extensionCommandService.execute(item.command, ctxMenu.node.path);
          }}
          onClose={() => setCtxMenu(null)}
          onRename={handleCtxRename}
          onDelete={handleCtxDelete}
          onNewFile={handleCtxNewFile}
          onNewFolder={handleCtxNewFolder}
          onCopyPath={handleCtxCopyPath}
          onCopyRelativePath={handleCtxCopyRelativePath}
          onRevealInFolder={handleCtxRevealInFolder}
          onLiveServerToggle={handleCtxLiveServerToggle}
          liveServerActive={liveServerActive}
          liveServerHtmlPath={liveServerHtmlPath}
        />
      )}

      {headerCtxMenu && (
        <HeaderContextMenu
          state={headerCtxMenu}
          onClose={() => setHeaderCtxMenu(null)}
          onCloseFolder={closeWorkspace}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Bottom Section: Outline + Timeline (collapsible)
// ─────────────────────────────────────────────────────────────────────────
function CollapsibleSection({
  title,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-forge-border/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-3 h-[28px] text-[11px] font-semibold uppercase tracking-wider text-forge-text hover:text-forge-text-strong transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="ml-1 inline-flex items-center gap-1.5">
          {icon}
          {title}
        </span>
      </button>
      {open && (
        <div className="px-3 py-2 text-[12px] text-forge-text/60 max-h-[140px] overflow-y-auto sidebar-scroll">
          {children}
        </div>
      )}
    </div>
  );
}

export function BottomSections() {
  return (
    <div className="flex-shrink-0">
      <OutlineSection />
      <TimelineSection />
    </div>
  );
}

function activeEditorFilePath(
  workspacePath: string | null,
  openTabs: Tab[],
  activeTabId: string | null,
): string | null {
  const tab = openTabs.find((t) => t.id === activeTabId);
  if (!tab || tab.imageDataUrl || !workspacePath) return null;
  if (tab.gitDiff) return tab.gitDiff.relPath;
  const rel = toWorkspaceRelPath(workspacePath, tab.path);
  return rel || null;
}

function symbolKindLabel(kind: number): string {
  const labels: Record<number, string> = {
    5: 'class', 6: 'method', 12: 'func', 11: 'func', 10: 'prop', 13: 'var',
    22: 'const', 4: 'field', 8: 'interface', 9: 'module', 3: 'ctor',
  };
  return labels[kind] ?? 'sym';
}

function OutlineSection() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openFilePath = useStore((s) => s.openFilePath);

  const tab = openTabs.find((t) => t.id === activeTabId);
  const filePath = tab && !tab.imageDataUrl && !tab.gitDiff ? tab.path : null;

  const [symbols, setSymbols] = useState<import('../../lsp/client').OutlineSymbol[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setSymbols([]);
      return;
    }
    setBusy(true);
    void lspClient.fetchDocumentSymbols(filePath).then((result) => {
      if (!cancelled) {
        setSymbols(result);
        setBusy(false);
      }
    });
    return () => { cancelled = true; };
  }, [filePath, tab?.content]);

  const jumpTo = (line: number) => {
    if (!filePath) return;
    void openFilePath(filePath, { line });
  };

  return (
    <CollapsibleSection title="Símbolos" icon={<ListTree size={12} />} defaultOpen>
      {!filePath ? (
        <p className="italic">No hay un archivo activo.</p>
      ) : busy ? (
        <p className="italic flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Cargando símbolos…
        </p>
      ) : symbols.length === 0 ? (
        <p className="italic">No se encontraron símbolos en el archivo activo.</p>
      ) : (
        <div className="space-y-0.5">
          {symbols.map((sym, i) => (
            <button
              key={`${sym.name}-${sym.startLine}-${i}`}
              onClick={() => jumpTo(sym.startLine)}
              className="w-full flex items-center gap-1.5 text-left hover:text-forge-accent transition-colors truncate"
              style={{ paddingLeft: `${sym.depth * 10}px` }}
              title={`${sym.name} · línea ${sym.startLine}`}
            >
              <span className="text-[9px] uppercase text-forge-text/35 flex-shrink-0 w-8">
                {symbolKindLabel(sym.kind)}
              </span>
              <span className="truncate">{sym.name}</span>
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

function TimelineSection() {
  const workspacePath = useStore((s) => s.workspacePath);
  const gitIsRepo = useStore((s) => s.gitIsRepo);
  const openTabs = useStore((s) => s.openTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openGitCommitDiff = useStore((s) => s.openGitCommitDiff);

  const relPath = activeEditorFilePath(workspacePath, openTabs, activeTabId);
  const [entries, setEntries] = useState<import('../../types').GitLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspacePath || !gitIsRepo || !relPath) {
      setEntries([]);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    window.electronAPI.git
      .log(workspacePath, relPath, 20)
      .then((log) => {
        if (!cancelled) {
          setEntries(log);
          setBusy(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setEntries([]);
          setError((err as Error).message || 'No se pudo cargar el historial.');
          setBusy(false);
        }
      });
    return () => { cancelled = true; };
  }, [workspacePath, gitIsRepo, relPath]);

  return (
    <CollapsibleSection title="Historial" icon={<History size={12} />}>
      {!workspacePath || !gitIsRepo ? (
        <p className="italic">No es un repositorio Git.</p>
      ) : !relPath ? (
        <p className="italic">Abre un archivo para ver su historial.</p>
      ) : busy ? (
        <p className="italic flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Cargando commits…
        </p>
      ) : error ? (
        <p className="text-red-400/80">{error}</p>
      ) : entries.length === 0 ? (
        <p className="italic">Este archivo aún no tiene commits.</p>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => (
            <button
              key={entry.hash}
              onClick={() => void openGitCommitDiff(relPath, entry)}
              className="w-full text-left rounded px-1 py-1 hover:bg-white/5 hover:text-forge-accent transition-colors"
              title={`${entry.author} · ${entry.date}\n${entry.hash}`}
            >
              <div className="flex items-center gap-1.5">
                <GitCommit size={11} className="text-forge-accent/80 flex-shrink-0" />
                <span className="font-mono text-[10px] text-forge-accent/90">{entry.shortHash}</span>
                <span className="text-[10px] text-forge-text/40">{entry.date}</span>
              </div>
              <div className="truncate text-[11px] mt-0.5">{entry.subject}</div>
              <div className="truncate text-[10px] text-forge-text/40">{entry.author}</div>
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

