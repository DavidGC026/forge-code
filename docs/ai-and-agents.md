# IA nativa y agentes

Forge Code tiene **tres** integraciones de IA distintas. No son la misma
cosa, y ninguna de ellas es una extensión VS Code (las de chat/LM van
después del Milestone 8; ver
[extensions-compatibility.md](./extensions-compatibility.md)).

## 1. Agente nativo (panel de chat)

Loop renderer → main → proveedor. El runtime vive en
`src/ai/runtime.ts` y habla por `window.electronAPI.ai` / `.agent`.

Flujo:

1. El usuario escribe en `AIPanel`.
2. `runtime.ts` arma el system prompt (`src/ai/protocol.ts`) y pide un
   stream al proceso main.
3. `electron/ai-providers.ts` llama al vendor por HTTPS (el renderer no
   toca la red: CORS y keys se quedan en main).
4. El modelo intercala narración en español con bloques
   `<tool>{"name":"...","args":{...}}</tool>`.
5. El runtime ejecuta las tools, muestra diffs pendientes si hay
   escritura, y vuelve a llamar al modelo. Tope: 20 pasos.

Tools que el modelo puede emitir:

| Tool | Efecto |
| --- | --- |
| `leer_archivo` | Lee un archivo del workspace (tope 1.5 MB) |
| `escribir_archivo` | Crea o pisa; el usuario puede rechazar el diff |
| `listar_carpeta` | Lista entradas (tope 500) |
| `buscar_en_proyecto` | Grep acotado (tope 100 hits) |

Implementación: `electron/agent-tools.ts`. Las rutas se resuelven
dentro del workspace; `node_modules`, `.git`, `dist` y similares están
en la deny-list. `reemplazarEnProyecto` existe en el mismo módulo pero
lo usa el **Search panel**, no el loop del agente.

Comandos de chat:

- `/init` — inspecciona el árbol y genera `PROJECT.md`
- `/clear` — borra el hilo

El historial se guarda en `.forge/history.json`. Las escrituras
streaming pueden abrir tabs del editor (`live write`).

### Proveedores

`electron/ai-providers.ts`: OpenAI, Anthropic, Google Gemini, DeepSeek,
Qwen (DashScope) y Kimi (Moonshot). Las keys y el par
proveedor/modelo activo viven en `forge-config.json`. Los errores HTTP
se traducen a mensajes cortos en español (cuota, key inválida, modelo
inexistente, 5xx).

## 2. Acciones rápidas (un solo turno)

`src/ai/quickActions.ts` — sin tools ni `/init`:

- mensaje de commit desde el panel de Git
- sobre la selección del editor: explicar, refactorizar, documentar,
  corregir con el diagnóstico LSP activo

Usan el mismo streaming `ai:*` que el chat.

## 3. Agentes de terminal

`AgentsPanel` lanza un PTY con el CLI si está en el PATH:

| Id | Comando |
| --- | --- |
| `codex` | `codex` |
| `claude` | `claude` |
| `cursor-agent` | `cursor-agent` |
| `agy` | `agy` |

Se dockean a la derecha, al sidebar o abajo. El ciclo de vida del PTY
es el de
[terminal-session-persistence.md](./terminal-session-persistence.md):
cambiar de pestaña no mata el proceso. Claude Code y Codex **no** se
tratan como extensiones VS Code; viven aquí hasta que el Extension Host
pueda hospedarlos de verdad.

## 4. Bridge IDE de Claude Code

`electron/claude-ide.ts` levanta un servidor HTTP local al estilo MCP
y expone tools del editor (`getCurrentSelection`, `openFile`,
`getOpenEditors`, …). El renderer empuja estado (tabs, selección) y
ejecuta comandos que llegan por `claudeIde.onCommand`.

Es un puente de producto, no el Extension Host ni el agente nativo.

## Límites que hay que conocer

- Las tools del agente son **filesystem local**. En un workspace
  `ssh://` no hay equivalente remoto; el chat puede conversar, no
  editar el host.
- Restricted Mode / Workspace Trust gobiernan el Extension Host, no
  este loop. El agente nativo no reconsulta trust antes de escribir.
- No hay bridge de `chatAgents` / language-model tools de extensiones.

Estado del store: el chat y el proveedor activo siguen en `store.ts`.
`aiSlice` está en el TODO de
[REFACTORING_PROGRESS.md](./REFACTORING_PROGRESS.md).
