# Arquitectura del editor Forge Code

Estado: **mapa del producto**, no de la plataforma de extensiones.
Extensiones: [extensions-architecture.md](./extensions-architecture.md).

## Tres procesos

```
┌─────────────────────┐   IPC tipado    ┌──────────────────────┐
│  Renderer (React)   │ ◄────────────► │  Preload            │
│  src/               │  contextBridge  │  electron/preload.ts │
└─────────────────────┘                 └──────────┬───────────┘
                                                   │ ipcMain
                                        ┌──────────▼───────────┐
                                        │  Main (Node)         │
                                        │  electron/main.ts    │
                                        └──────────┬───────────┘
                                                   │
                    ┌──────────────┬───────────────┼────────────┐
                    ▼              ▼               ▼            ▼
              PTY / SSH      git CLI        LLM HTTP      utilityProcess
              node-pty       OpenSSH        ai-providers  Extension Host
```

Reglas que ya se cumplen y no hay que romper:

- El renderer no habla con red, disco privilegiado ni con el Extension
  Host. Todo pasa por `window.electronAPI`.
- Main es el broker. El host de extensiones corre en un `utilityProcess`
  y el renderer solo observa estado.
- En el renderer de Electron no se usa `window.prompt()` /
  `window.alert()`. Ver [remote-ssh-modal.md](./remote-ssh-modal.md).

## Dónde vive cada dominio

| Dominio | Main | Renderer | Doc |
| --- | --- | --- | --- |
| FS, watcher, ventanas, Live Server | `electron/main.ts` | `store.ts`, Explorer, StatusBar | este archivo |
| Workspace remoto | `main.ts` (`ssh://`) | `remoteSlice.ts` | [remote-workspaces.md](./remote-workspaces.md) |
| Terminal / PTY | `main.ts` | `terminalSlice.ts`, `TerminalSessionManager` | [terminal-session-persistence.md](./terminal-session-persistence.md) |
| Git + GitHub | `git.ts`, `github-auth.ts` | `gitSlice.ts`, SourceControl | [git-and-scm.md](./git-and-scm.md) |
| IA nativa y tools | `ai-providers.ts`, `agent-tools.ts` | `src/ai/`, AIPanel | [ai-and-agents.md](./ai-and-agents.md) |
| Claude Code IDE | `claude-ide.ts` | `App.tsx` | [ai-and-agents.md](./ai-and-agents.md) |
| LSP (TS/JS nativo) | `lsp-manager.ts` | `src/lsp/client.ts` | [lsp.md](./lsp.md) |
| Extensiones | `electron/extensions/` | `src/extensions/`, `extensionSlice.ts` | [extensions-architecture.md](./extensions-architecture.md) |

`electron/extensions.ts` es facade temporal del subsistema de
extensiones, no el composition root de Forge Code.

## Estado global

Zustand combina slices en `src/store.ts`. Extraídos:

- `layoutSlice` — visibilidad, anchos, dock de agentes, `localStorage`
  (`forge.layout.v1`)
- `terminalSlice` — sesiones PTY y agentes de terminal
- `gitSlice` — SCM
- `remoteSlice` — modal y conexión SSH
- `extensionSlice` — inventario, tienda, trust, host

Siguen en el monolito (~1 750 líneas): workspace, árbol, tabs, editor,
IA, Live Server, problems, command palette y Quick Open. El TODO vigente
está en [REFACTORING_PROGRESS.md](./REFACTORING_PROGRESS.md):
`editorSlice`, `aiSlice` y un `store/index.ts` unificado.

Las slices se cruzan con `get()`. No hay combinador aparte todavía.

## Superficie IPC

El contrato vive en `electron/preload.ts`. Namespaces:

| Namespace | Para qué |
| --- | --- |
| (raíz) | diálogo abrir carpeta, FS, watcher, ventana, clipboard, shell |
| `remote` | `connect` / `browse` de workspaces `ssh://` |
| `terminal*` | crear, escribir, resize, matar, eventos PTY |
| `github` | device flow OAuth |
| `claudeIde` | bridge MCP ↔ renderer |
| `liveServer` | preview HTTP en `:5500` |
| `lsp` | start/stop + JSON-RPC al language server |
| `ai` | providers, keys, streaming |
| `agent` | tools de filesystem del agente (y del Search panel) |
| `git` | status, stage, commit, push/pull, diff, ramas |
| `forge` | historial de chat en `.forge/` |
| `ext` | tienda, config, trust, host — lo más tipado |

`ext:*` tiene DTOs versionados. `lsp`, `ai` y `claudeIde` todavía
cargan `any` en varios payloads.

## Workbench

- **Activity Bar:** Explorer, Search, Git, Run, Agents, Extensions,
  Settings.
- **Explorer:** árbol, DnD, menús (incl. `explorer/context` de
  extensiones), Outline (símbolos LSP) y Timeline (log de Git por
  archivo).
- **Search:** find/replace de proyecto. Reutiliza `agent-tools`, no un
  motor aparte.
- **Run:** lista de comandos del usuario (`localStorage`
  `forge.runCommands.v1`) más scripts de `package.json`. Los lanza en
  la terminal integrada. **No hay debugger** — las pestañas Output y
  Debug Console del panel inferior son placeholders.
- **Command palette / Quick Open:** `commandRegistry.ts` + fuzzy. Atajos
  nativos habituales (`Ctrl+P`, `Ctrl+S`, `Ctrl+B`, `` Ctrl+` ``, etc.).
- **Live Server:** HTTP estático desde el workspace, puerto base 5500.
  Toggle en la status bar y acciones por archivo HTML.
- **Settings:** fuente, wrap, tab size, autosave, formato al guardar,
  modo de diff, resumen del proveedor IA, dock de agentes. Los settings
  de una extensión viven en su vista de detalle.

Persistencia de layout: `localStorage`. Persistencia de producto:
`forge-config.json` en `userData` (reemplazó a `electron-store`; la
dependencia en `package.json` ya no se usa).

`electron/app-identity.ts` se carga primero en main y conserva los perfiles
históricos `forge` / `Forge`, incluido el almacenamiento de Chromium.
Ver [brand-and-rename.md](./brand-and-rename.md).

El último workspace se restaura con `workspace:restore`. Preload escucha
desde su inicio y conserva el evento hasta que React se suscribe; la entrega
se difiere a una microtarea para que el montaje de StrictMode no duplique la
apertura ni consuma el evento con una suscripción que ya se desmontó.

## Metadatos por workspace (`.forge/`)

| Archivo | Dueño |
| --- | --- |
| `settings.json` | scope workspace del `ConfigurationService` de extensiones |
| `history.json` | historial del chat del agente nativo |
| `PROJECT.md` | resumen que genera `/init` para el agente |

En workspaces remotos el scope workspace de extensiones está
desactivado. El agente nativo tampoco corre tools contra `ssh://`.

## Convenciones

- UI y prompts del agente: español.
- Estilos: Tailwind. Límites de tamaño y anti-monolitos:
  [CODING_GUIDELINES.md](./CODING_GUIDELINES.md).
- Un cambio de producto grande actualiza un doc de esta carpeta y el
  índice.
