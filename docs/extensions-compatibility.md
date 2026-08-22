# Contrato y matriz de compatibilidad de extensiones

Esta matriz es la fuente de verdad del estado funcional. “Instalada” no
significa “compatible”. Un capability sólo avanza de nivel cuando cumple la
Definition of Done de la arquitectura.

## Niveles

| Nivel | Significado |
| --- | --- |
| `unsupported` | Forge reconoce la necesidad, pero no ofrece implementación |
| `metadata` | El manifiesto se conserva y se muestra; no se activa |
| `declarative` | La contribución se interpreta sin ejecutar código |
| `partial` | Existe una parte útil de la API, con limitaciones conocidas |
| `compatible` | Casos representativos y suite contractual pasan |
| `degraded` | Normalmente compatible, pero limitada por host/workspace/plataforma |
| `blocked` | Política, seguridad, engine, API proposed o dependencia impiden activar |

La UI debe mostrar nivel, razones y evidencia; nunca reducirlo a un badge
genérico “Active”.

## Estado real al 2026-08-22

Actualizada tras el Milestone 3 (incremento 3.6)
([extensions-phase3-progress.md](./extensions-phase3-progress.md)).
El motor declarativo cerró en el Milestone 2.

| Área | Estado | Observaciones |
| --- | --- | --- |
| Open VSX search/detail | `partial` | Búsqueda (size 1–50, sin offset), detalle y README; sin paginación ni selector de versiones. Search/detail siguen en la facade, no en `ExtensionCatalog` |
| Instalación Open VSX | `compatible` | Transaccional con staging, hash y provenance; deps resueltas por adelantado |
| VSIX local | `partial` | Staging, zip-slip, rechazo de symlinks y de `publisher` con separadores; sin selector de versión ni provenance de catálogo |
| Uninstall | `partial` | Elimina paquete/registry con sweep de huérfanos; falta lifecycle del host |
| Update/rollback | `compatible` | Update por extensión y rollback a la versión previa conservada |
| Registry local | `compatible` | Puerto/adaptador tipado, escritura atómica y decoder tolerante con legacy |
| IPC de tienda | `partial` | Preload tipado, handshake list v1, `ext:config:*` y `ext:host:*`; el envelope RPC es del host, no de la tienda |
| Color themes | `partial` | Conversión aproximada TextMate → tokens Monaco; Monaco no permite retirar un tema |
| Snippets | `declarative` | Providers por extensión con ownership y cleanup |
| Languages | `declarative` | Registro y configuración con ownership; algunos campos sin cubrir |
| Icon themes | `declarative` | Aplicados al Explorer (0.5) con persistencia; `rootFolder` / `rootFolderExpanded` aún no |
| Recursos declarativos | `partial` | Readers aislados, path traversal y symlinks bloqueados en extract; falta validación de corpus público |
| Analyzer | `partial` | Nivel `none` / `partial` / `full` + blockers tipados por carga real; sin evidencia runtime |
| Grammars | `declarative` | TextMate real (vscode-textmate + oniguruma WASM) con estado multi-línea e inyecciones |
| Configuration | `partial` | Scopes default < override < user < workspace, validación y settings UI; las extensiones la leen desde el host (snapshot en step), escribirla desde una extensión aún no |
| Commands | `partial` | `registerCommand`/`executeCommand`/`getCommands` ejecutan en el host desde la paleta, el menú del editor y keybindings; los comandos del propio workbench aún no son invocables desde una extensión |
| Keybindings | `declarative` | Chords single-stroke por plataforma, gated por `when`, tras los atajos nativos |
| Menus | `declarative` | `explorer/context` y `editor/context` con `when` y grupos de VS Code |
| Context keys / `when` | `declarative` | Parser propio con la precedencia de VS Code y keys publicadas por el workbench |
| Extension `main` | `partial` | Se carga y se ejecuta en el host: entrypoint contenido por realpath, `require('vscode')` por dueño y `activate`/`deactivate` con aislamiento de fallos |
| Extension `browser` | `metadata` | No existe Web Extension Host |
| Activation events | `partial` | `*`, `onStartupFinished`, `onCommand`, `onLanguage` y `workspaceContains` (scan acotado) activan de verdad, con métricas y fallos por generación; el resto se reconoce como no despachable en lugar de ignorarse |
| VS Code API | `partial` | Facade por extensión con primitivas (`Disposable`, `EventEmitter`, `Uri`, cancelación), enums, `commands`, `window.show*Message`, `workspace.getConfiguration` (snapshot síncrono, sólo lectura) y `ExtensionContext`; el resto lanza `UnsupportedApiError` y se reporta para el análisis de compatibilidad |
| LSP/DAP/tasks/testing | `unsupported` | Forge tiene LSP/Git/terminal nativos, aún sin bridge de extensiones |
| Views/webviews/notebooks | `unsupported` | Sin workbench contribution hosts |
| Remote extension host | `unsupported` | Remote SSH no ejecuta extensiones junto al workspace |
| Workspace Trust | `compatible` | Trust por workspace y Restricted Mode con política de activación honrada por el host: una extensión bloqueada ni siquiera viaja en el handshake. Safe Mode (`--disable-extensions` o decisión persistida) vacía el conjunto activable en el origen |
| Extension Host (kernel) | `compatible` | `utilityProcess` con handshake, envelope RPC, heartbeat, backoff y circuit breaker; carga extensiones, activa por evento, ejecuta comandos y se diagnostica en la UI (estado, tiempos, fallos). Safe Mode disponible. El Hello World oficial corre sin modificar |

## Matriz objetivo por contribution point

La lista oficial evoluciona; el analyzer conservará claves desconocidas y las
reportará. Prioridad inicial:

| Grupo | Contribution points | Fase |
| --- | --- | --- |
| Apariencia/lenguaje básico | themes, snippets, languages, grammars, iconThemes, productIconThemes, colors, icons | M2 |
| Configuración/contexto | configuration, configurationDefaults, commands, keybindings, menus | M2 |
| Validación/build | jsonValidation, problemPatterns, problemMatchers, breakpoints | M2/M7 |
| Workbench | views, viewsContainers, viewsWelcome, walkthroughs | M6 |
| Lenguaje runtime | semanticTokenScopes y providers vía API | M5 |
| Debug/tasks/tests | debuggers, taskDefinitions y APIs runtime | M7 |
| UI avanzada | customEditors, notebooks, notebookRenderer | M8 |
| Auth/SCM | authentication y APIs runtime | M6 |
| Chat/LM | chatAgents, languageModelTools/providers y relacionados | Posterior a M8; diseño separado |

Referencia completa: [Contribution Points](https://code.visualstudio.com/api/references/contribution-points).

## Matriz objetivo por namespace API

| Orden | API | Alcance inicial |
| --- | --- | --- |
| 1 | Primitivas | Disposable, EventEmitter, Uri, Position, Range, Selection, Cancellation |
| 2 | commands | register/execute/getCommands y activación on-demand |
| 3 | workspace | folders, documents, fs, configuration, edits, watchers, trust |
| 4 | window | editors, messages, output, progress, status, quick input |
| 5 | languages | diagnostics y providers de lenguaje |
| 6 | env/extensions | identidad, host, clipboard, URIs, extension inventory |
| 7 | tasks/debug/tests | workflows de ejecución y DAP |
| 8 | scm/authentication | providers con consentimiento y storage seguro |
| 9 | notebooks/webviews | superficies aisladas y mensajería |

La referencia contractual se derivará de `vscode.d.ts` para la versión de API
objetivo publicada por Forge. No se copiará de memoria:
[VS Code API](https://code.visualstudio.com/api/references/vscode-api).

## Compatibility report por extensión

El analyzer producirá como mínimo:

```ts
interface CompatibilityReport {
  extensionId: string;
  extensionVersion: string;
  targetApiVersion: string;
  engineSatisfied: boolean;
  selectedHost: 'node-local' | 'node-remote' | 'web' | null;
  level: 'metadata' | 'declarative' | 'partial' | 'compatible' | 'degraded' | 'blocked';
  supportedContributions: string[];
  unsupportedContributions: string[];
  observedApiCalls: string[];
  unsupportedApiCalls: string[];
  activationEvents: string[];
  blockers: { code: string; message: string }[];
  lastVerifiedAt: string | null;
}
```

El análisis estático del manifiesto es una predicción. La evidencia runtime y las
pruebas contractuales son las que permiten elevar una extensión a `compatible`.

## Corpus de compatibilidad

Se mantendrán dos grupos:

### Fixtures controlados

Extensiones mínimas dentro del repositorio, una por capability y caso de error.
Son deterministas y forman la suite obligatoria de CI.

### Extensiones públicas representativas

Un corpus fijado por ID y versión desde Open VSX para themes, grammars,
formatters, linters, language servers, tree views, tasks, debuggers, webviews y
web extensions. No se actualizará automáticamente en CI sin revisar cambios.

## Reglas para comunicar compatibilidad

- No mostrar “compatible” por reconocer `main` o `contributes`.
- No sustituir una extensión por un CLI y presentarla como la misma extensión.
- Las integraciones especiales de agentes se etiquetan como integración Forge,
  no como ejecución de la extensión VS Code.
- Toda limitación por remoto, virtual workspace, trust, SO o arquitectura debe
  aparecer antes de activar.
- APIs unknown/proposed se muestran por nombre cuando sea seguro hacerlo.
