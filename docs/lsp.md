# LSP nativo (TypeScript / JavaScript)

Forge Code trae un language server **propio** para TS/JS. No es el bridge
de extensiones del Milestone 5: una extensión que lance un server no
se engancha aquí.

## Piezas

| Capa | Archivo | Rol |
| --- | --- | --- |
| Main | `electron/lsp-manager.ts` | Spawnea `typescript-language-server --stdio`, framing Content-Length, `initialize` / `initialized` |
| IPC | `lsp:start`, `lsp:stop`, `lsp:request`, `lsp:notification` | El renderer no habla stdio |
| Renderer | `src/lsp/client.ts` | `didOpen` / `didChange` (debounce) / `didClose`, completion, hover, diagnostics, document symbols |
| Editor | `EditorArea.tsx` | Apaga el TS built-in de Monaco; conviven gramáticas TextMate + LSP |
| Outline | `ExplorerPanel` | Símbolos del documento activo |
| Problems | `BottomPanel` + status bar | `publishDiagnostics` → markers y panel |

Cambiar de workspace mata el server y lo vuelve a levantar con el
nuevo cwd.

## Alcance

Lenguajes: TypeScript, JavaScript, TSX, JSX. El binario se resuelve
desde el `typescript-language-server` de las dependencias (también con
el layout de symlinks de pnpm).

No hay formatters, linters ni language features aportados por
extensiones. Eso es Milestone 5
([extensions-roadmap.md](./extensions-roadmap.md)).

## Remoto

`lsp:start` recibe el path del workspace. Si es `ssh://…`, el cwd no
es un árbol local y el server no ve esos archivos. Hoy el LSP nativo
es para workspaces en disco. Ver
[remote-workspaces.md](./remote-workspaces.md).
