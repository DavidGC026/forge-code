# Registro de Refactorización (Refactoring Log)

Este documento mantiene un registro de los esfuerzos de modularización y refactorización aplicados al proyecto para evitar código espagueti.

## Cambios Realizados

### 1. Refactorización de `SideBar.tsx`
Se extrajo la lógica pesada de los paneles de la barra lateral hacia componentes independientes dentro de `src/components/Sidebar/`:
- **`SearchPanel.tsx`**: Funcionalidad de búsqueda en todo el proyecto.
- **`AgentsPanel.tsx`**: Integración con agentes IA.
- **`RunDebugPanel.tsx`**: Comandos de terminal y scripts de `package.json`. No hay debugger.
- **`SourceControlPanel.tsx`**: Funcionalidad completa de Git, visualización de cambios y modal de GitHub OAuth.
- **`ExplorerPanel.tsx`**: Árbol de archivos, menús contextuales, arrastrar y soltar, sub-secciones Outline y Timeline.
- **`gitHelpers.ts`** (en `src/utils/`): Se extrajeron funciones repetidas de Git (`gitStatusLabel`, `isStaged`, etc.) para uso compartido.

> **Resultado:** `SideBar.tsx` se redujo de ~2,600 líneas a apenas 106 líneas, siendo responsable únicamente de la orquestación y renderizado condicional de sus paneles.

### 2. Refactorización de `store.ts` (En Progreso)
El archivo principal de estado global (`store.ts`) sigue en ~1 750 líneas
(bajó de ~2 600). Las slices viven en `src/store/slices/`.

- **`layoutSlice.ts`**: visibilidad, anchos, panel activo, persistencia de layout.
- **`remoteSlice.ts`**: modal SSH y `connectRemoteWorkspace`.

## Próximos Pasos (To-Do)
- [ ] Extraer `editorSlice.ts` (archivos abiertos, pestañas, guardado, fuente).
- [x] Extraer `gitSlice.ts` (ramas, staging, log).
- [x] Extraer `terminalSlice.ts` (PTY, sesiones nativas y de agentes).
- [x] Extraer `remoteSlice.ts` (modal y conexión SSH).
- [ ] Extraer `aiSlice.ts` (chat, proveedores, modelo activo).
- [x] Extraer `extensionSlice.ts` (inventario, tema, Open VSX, trust, host).
- [ ] Construir un `store/index.ts` unificado con el combinador de slices.

Monolitos fuera del store que siguen por encima de la guía (300–400
líneas): `electron/main.ts`, `ExplorerPanel.tsx`,
`src/types.ts`, `App.tsx`. El mapa está en
[app-architecture.md](./app-architecture.md).

## Progreso Reciente
- **Plataforma de extensiones**: Se documentó la arquitectura objetivo SOLID,
  roadmap por milestones, contrato de compatibilidad y gates de seguridad/pruebas
  para evolucionar desde contribuciones declarativas hacia hosts Node, Web y remoto.
- **Extensiones Milestone 0.1**: Se extrajeron contratos de manifiesto, el puerto
  `ManifestReader`, su adaptador VS Code y fixtures/pruebas de caracterización
  JSONC/VSIX sin añadir dependencias.
- **Extensiones Milestone 0.2**: Se extrajo `ExtensionRegistry` con adaptador JSON
  inyectable y migración legacy, se tiparon los DTO IPC de tienda y `ext:list`
  comenzó el handshake con `protocolVersion: 1`.
- **Extensiones Milestone 0.3**: Themes, snippets, languages e icon themes ahora
  usan readers segregados con resolución segura de recursos; un analyzer central
  calcula compatibilidad desde contribuciones cargadas realmente.
- **TerminalSlice**: Se ha extraído exitosamente `terminalSlice.ts`, moviendo el manejo de terminales nativas, PTY y agentes.
- **Persistencia de terminales**: El ciclo de vida de los PTY se separó de React mediante
  `TerminalSessionManager`. Cambiar pestañas o mover un agente entre docks ya no
  destruye su proceso; sólo cerrar o reiniciar una sesión lo termina.
- **GitSlice**: Se ha extraído exitosamente `gitSlice.ts`, moviendo todo el control de cambios de git.
- **Extensiones Milestone 0.4**: El analyzer entrega un `ExtensionCompatibilityReport`
  tipado (nivel + blockers) que la UI consume en lugar de heurísticas; se extrajo
  `extensionSlice.ts` del store monolítico y el manifest reader ganó un modo
  validante con errores discriminados (`readWithDiagnostics`), manteniendo el
  modo legacy hasta el package manager transaccional.
- **Extensiones Milestone 0.5**: El Explorer aplica el icon theme activo mediante
  un resolver puro (`src/extensions/iconTheme.ts`) con fallback a lucide; la
  selección se persiste y restaura vía IPC y `iconThemes` cuenta como
  contribución soportada en el compatibility report.
- **Extensiones Milestone 1.0**: Instalación de VSIX transaccional — staging con
  límites y guard zip-slip que rechaza, sha256 de provenance, commit atómico en
  directorios versionados `<id>/<version>`, errores discriminados
  (`ExtensionInstallError`), validación de `engines.vscode` y escritura atómica
  del registry. Una instalación fallida ya no puede corromper la versión activa.
- **Extensiones Milestone 1.1**: Enable/disable por extensión sin desinstalar
  (persistido, preservado en upgrades y honrado por Monaco, icon themes y la UI)
  y pruebas de corte simulado en el promote del commit con restauración del
  directorio aparcado.
- **Extensiones Milestone 1.2**: Rollback explícito con retención de la versión
  anterior (los directorios versionados intercambian roles), dependencias
  `extensionDependencies`/`extensionPack` resueltas con detección de ciclos, y
  el downloader de Open VSX extraído a un puerto `ExtensionCatalog` con fetch
  inyectable.
- **Extensiones Milestone 1.3 (Milestone 1 completo)**: El grafo de
  dependencias se resuelve por adelantado con metadatos del catálogo
  (`latestMetadata`) y las deps se instalan antes que la raíz — una dep
  requerida que falla aborta sin instalar nada de la extensión pedida.
  Update explícito por extensión (`CheckExtensionUpdates` + botón en el
  panel) y sweep de huérfanos del almacén al arrancar. Se retiró la
  excepción de UI que trataba Claude Code y Codex como agentes en el panel
  de extensiones: viven como agentes de terminal hasta que el Extension
  Host los soporte como extensiones independientes.
- **Extensiones Milestone 2.0**: `contributes.configuration` y
  `configurationDefaults` soportados de punta a punta — normalización con
  secciones aplanadas en el reader, `ConfigurationService` (application) con
  precedencia default < override de otra extensión < usuario, ownership con
  warning en redeclaraciones, validación de tipo/enum al escribir, puerto
  `UserConfigurationStore` persistido bajo `extensionSettings` en
  forge-config.json, IPC `ext:config:*` tipado y sección de settings
  editable en la vista de detalle (`ExtensionSettingsSection`).
- **Extensiones Milestone 2.1**: `ContributionRegistry` genérico
  (renderer) con ownership y cleanup por extensión — `sync` reconcilia por
  diff (aplicar nuevas, retirar salientes, re-aplicar cambios de versión)
  sin tocar las que no cambiaron. Themes, snippets y languages migrados a
  appliers por familia; los snippets pasaron a providers por extensión.
  Fallos de applier/dispose aislados con warning. Probado sin bundler vía
  type stripping de Node.
- **Extensiones Milestone 2.2**: scope workspace del `ConfigurationService`
  con precedencia default < override < user < workspace, puerto
  `ConfigurationScopeStore` con provider de workspace (null en remotos),
  adaptador `ForgeWorkspaceSettingsStore` (`.forge/settings.json`, lectura
  tolerante y escritura atómica), `setValue(key, value, scope)` validado y
  `onDidChange` → broadcast `ext:config:changed` a todas las ventanas
  (`'*'` al cambiar de workspace). La UI edita el scope efectivo con reset
  contextual y badge de procedencia.
- **Extensiones Milestone 2.3**: `contributes.commands` y
  `contributes.keybindings` declarativos de punta a punta — normalización y
  round-trip en main; en el renderer, parser puro de cláusulas `when`
  (`whenClause.ts`), `ContextKeyService` con caché y keys publicadas desde
  el store, `ExtensionCommandService` (handlers + no-op reportado sin
  Extension Host) y `KeybindingService` (chords por plataforma, gana el más
  reciente, sólo consume si un handler corrió). Ownership por extensión con
  un ContributionRegistry de workbench independiente de Monaco; paleta de
  comandos integrada y despacho tras los atajos nativos.
- **Extensiones Milestone 2.4**: `contributes.grammars` con TextMate real —
  vscode-textmate + vscode-oniguruma (WASM inline como data URL para
  file://), `FileGrammarContributionReader` que envía la fuente cruda
  (JSON/plist) al renderer, `TextmateGrammarService` con ownership por
  scopeName, compilación bajo demanda, invalidación de caché al retirar,
  inyecciones y estado multi-línea; applier `grammars` asíncrono amarrado
  al ContributionRegistry de Monaco. Probado contra el motor WASM real con
  cinco lenguajes fixture.
- **Extensiones Milestone 2.5**: `contributes.menus` declarativos — record
  aplanado en main, helpers puros en `menus.ts` (títulos resueltos entre
  extensiones, orden de grupos de VS Code con `navigation` primero y `@N`,
  empates estables), overlay de keys transitorias en
  `ContextKeyService.match` y `explorerResourceContext` con las keys de
  recurso de VS Code. El menú contextual del explorador muestra los items
  de `explorer/context` gateados por `when` para el nodo clicado y ejecuta
  con la ruta como argumento. Derivado de payloads: sin registros
  huérfanos por construcción.
- **Extensiones Milestone 2.6**: `editor/context` sobre Monaco —
  `EditorMenuService` registra los items como acciones globales
  (`monaco.editor.addEditorAction`) con ids namespaciados por dueño y
  traduce `group@order` a `contextMenuGroupId`/`contextMenuOrder`. Como
  Monaco no admite predicados de visibilidad, el conjunto registrado se
  reconcilia por diff ante cambios del set de extensiones y de context keys
  (coalescidos en microtask). `editorResourceContext` publica las keys
  `resource*` del tab activo y la ejecución pasa por el
  `ExtensionCommandService` con la ruta como argumento.
- **Extensiones Milestone 2.7**: comandos y atajos en la vista de detalle —
  `formatChord` (notación por plataforma, `null` para los chords que el
  dispatcher no soporta) y `summarizeCommands` emparejando
  `contributes.commands` con sus keybindings; `ExtensionContributionsSection`
  muestra título, id, badges de atajo, superficies donde aparece el comando
  y `enablement`, marcando los que aún necesitan el Extension Host. Cierra
  el Milestone 2.

- **Extensiones Milestone 3.0**: Workspace Trust y Restricted Mode —
  servicio en main con puerto y adaptador atómico, estado por workspace
  (los nuevos y los remotos empiezan sin confianza), IPC `ext:trust:*` con
  broadcast, banner en el panel y política de activación por
  `capabilities.untrustedWorkspaces`. Las fixtures maliciosas destaparon
  tres agujeros reales de instalación (symlink fuera del paquete,
  `publisher` con separadores escribiendo fuera del store, capacidades
  contradictorias sin leer), todos cerrados.
  Ver [extensions-phase3-trust.md](./extensions-phase3-trust.md).
- **Extensiones Milestone 3.1**: kernel del Extension Host —
  `utilityProcess` con handshake, envelope RPC versionado con generaciones,
  timeouts por familia, cancelación, agregación de logs, heartbeat, backoff
  y circuit breaker. El broker no depende de Electron (transporte y timers
  inyectados) y el puerto `ExtensionHost` es implementable por un doble en
  proceso. Todavía no carga código de extensión.
  Ver [extensions-phase3-progress.md](./extensions-phase3-progress.md).
- **Extensiones Milestone 3.2**: el host ya carga código de extensión —
  descriptores en el handshake, resolución del entrypoint contenida por
  realpath (symlinks incluidos), `require('vscode')` interceptado y resuelto
  por dueño, primitivas (`Disposable`, `EventEmitter`, `Uri`, cancelación),
  enums congelados, `ExtensionContext` con mementos persistidos por
  extensión y activación aislada: la que lanza queda `failed`, libera lo que
  registró y no arrastra a las demás. Toda API sin implementar lanza
  `UnsupportedApiError` y se reporta, en vez de devolver `undefined`.
  Ver [extensions-phase3-progress.md](./extensions-phase3-progress.md).
- **Extensiones Milestone 3.3**: comandos de punta a punta. El handler se
  queda en el host y sólo cruzan ids: registro por notificación, ejecución
  por request con dueño y timeout. Main indexa por generación y activa bajo
  demanda a quien declare `onCommand:<id>`, con un único reintento. En el
  renderer, un comando sin handler local cae al host y `hasHandler` cuenta
  también lo activable, así que la paleta, el menú del editor y los
  keybindings ejecutan comandos reales de extensión.
  Ver [extensions-phase3-progress.md](./extensions-phase3-progress.md).
- **Extensiones Milestone 3.4 (criterio de salida del Milestone 3)**: el
  Hello World oficial de VS Code corre sin modificar — activa por comando,
  muestra su mensaje y se desactiva limpio. Activation service con índice
  evento → extensiones (`*`, `onStartupFinished`, `onCommand`, `onLanguage`,
  `workspaceContains` con scan acotado), una activación por generación con
  el fallo recordado, métricas y fallos publicados por IPC,
  `window.show*Message` con notificaciones no modales en el renderer y
  `workspace.getConfiguration` servido desde un snapshot que main mantiene
  en step (síncrono, como en VS Code).
  Ver [extensions-phase3-progress.md](./extensions-phase3-progress.md).
- **Extensiones Milestone 3.5 y 3.6 (Milestone 3 completo)**: Safe Mode
  (`--disable-extensions` que no persiste y decisión de usuario que sí,
  comprobada en el origen), fixtures maliciosas de runtime y aislamiento
  demostrado —colgada, crash, request en vuelo, tormenta de logs y secuestro
  de comando—, más la superficie de usuario: estado del host y modo seguro en
  el panel, runtime por extensión (qué la despertó, cuánto tardó, por qué
  falló) en la vista de detalle, y los comandos de la paleta. Con esto los
  siete incrementos 3.0–3.6 están cerrados.
  Ver [extensions-phase3-progress.md](./extensions-phase3-progress.md).
- **Extensiones Milestone 4.0**: `workspace.fs` con política de rutas propia
  —workspace, directorio de la extensión (sólo lectura) y su storage—
  aplicada sobre el realpath y con ambos extremos autorizados en `rename` y
  `copy`. El filesystem es un puerto: local por Node y remoto por un puente
  SSH que main inyecta, con `FileSystemError` tipado de punta a punta.
  Ver [extensions-phase4-progress.md](./extensions-phase4-progress.md) y el
  [diseño del milestone](./extensions-phase4-design.md).
- **Extensiones Milestone 4.1**: espejo de documentos en main alimentado por
  el renderer (versiones monótonas suyas, debounce, contenido completo) y
  `workspace.textDocuments` con sus cuatro eventos. Una extensión ve el
  buffer sucio, no el disco; `TextDocument` calcula posiciones y líneas en el
  host para no convertir un linter en miles de round-trips.
- **Extensiones Milestone 4.2**: `window.activeTextEditor`,
  `visibleTextEditors`, selección con sus eventos y `showTextDocument` que
  respeta `preserveFocus`. El layout se publica entero y deduplicado (el
  caret cambia en cada pulsación) y un editor sin su documento se descarta en
  vez de inventarse.
- **Extensiones Milestone 4.3**: `WorkspaceEdit` y `applyEdit` con
  verificación de versión y semántica todo-o-nada. Las ediciones se resuelven
  contra el texto original y se aplican de atrás hacia adelante; las
  solapadas se rechazan; un archivo abierto se edita en su buffer en un solo
  paso de undo y uno cerrado en disco. `editor.edit()` comparte camino, para
  que no haya dos formas de saltarse el version check.

Actualmente `store.ts` ha delegado Layout, Terminal, Git, Remote y Extensiones a
slices específicos. Siguen inline: workspace, tabs, editor, IA, Live Server,
problems, command palette y Quick Open.

Documentación de producto añadida en 2026-08-22: README de raíz,
[app-architecture.md](./app-architecture.md),
[ai-and-agents.md](./ai-and-agents.md), [git-and-scm.md](./git-and-scm.md),
[lsp.md](./lsp.md) y [remote-workspaces.md](./remote-workspaces.md). La
matriz, el “estado actual” de la arquitectura y el próximo incremento
del roadmap se alinearon con el código (M0 cerrado, siguiente corte 3.2).

## Forge Code y cierre del incremento 4.4 — 2026-10-31

El editor se renombró a Forge Code conservando perfiles y contratos. Se
rediseñaron inicio, barras, pestañas y estados; `EditorArea.tsx` quedó como
composición de módulos menores de 400 líneas y los divisores salieron de
`App.tsx`. Los paneles estrechos usan overlays sin sobrescribir tamaños.

El 4.4 incorpora watchers/búsquedas cancelables y corrige autorización de
symlinks y URIs SSH. La QA real encontró y corrigió el `env` opcional del
launcher, la carrera de restauración y los getters congelados/orden de
sincronización documental. Ver [diseño](./workbench-design.md),
[progreso 4.4](./extensions-phase4-progress.md) y
[verificación](./verification-2026-10-31.md).
