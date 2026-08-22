# Roadmap ejecutable de compatibilidad con extensiones VS Code

Estado: **plan maestro**

Arquitectura normativa: [extensions-architecture.md](./extensions-architecture.md)

Matriz normativa: [extensions-compatibility.md](./extensions-compatibility.md)

## Reglas de ejecución

- Las fases expresan dependencias técnicas, no fechas prometidas.
- Cada milestone debe terminar en un incremento utilizable y verificable.
- No se inicia ejecución de código de terceros antes de completar instalación
  transaccional, trust básico y aislamiento de proceso.
- Los archivos de producción no deben convertirse en nuevos monolitos. Al llegar
  a una segunda responsabilidad, se extrae un puerto o adaptador.
- Toda compatibilidad nueva actualiza la matriz y añade fixtures de prueba.

## Milestone 0 — Baseline, contratos y caracterización

Objetivo: volver medible el sistema actual antes de refactorizarlo.

Estado: **completado**. Incrementos 0.1 y 0.2 completaron manifest reader,
fixtures JSONC/VSIX, registry desacoplado, migración legacy y DTO IPC v1. El
incremento 0.3 separó contribution readers, aseguró sus rutas y centralizó el
análisis básico de compatibilidad. El incremento 0.4 añadió el reporte tipado
de compatibilidad (nivel + blockers) consumido por la UI, extrajo
`extensionSlice` del store monolítico e inició la validación de manifest con
errores discriminados en modo legacy. El incremento 0.5 aplicó el icon theme
activo en el Explorer con persistencia completa y promovió `iconThemes` a
contribución soportada. Lo que quedó de `any` en preload no es de `ext:*`
(ese handshake está tipado); vive en `lsp` / `ai` / `claudeIde` y no
bloquea este milestone.

Trabajo:

- Crear fixtures VSIX mínimos para theme, snippets, language e icon theme.
- Añadir pruebas de caracterización del parser/instalador actual.
- Medir startup, carga de lista y tamaño de payload IPC.
- Definir DTO versionado y errores discriminados. DTO/list handshake completado;
  errores discriminados de manifest disponibles vía `readWithDiagnostics`
  (bloquean sólo documentos ilegibles; el resto sigue en modo legacy).
- Crear `extensionSlice` y retirar estado de extensiones del store monolítico.
  Completado en el incremento 0.4.
- Registrar issues actuales: `any` en preload sigue pendiente. Resueltos: icon
  theme aplicado en el Explorer con persistencia completa (incremento 0.5) y
  heurísticas de badges reemplazadas por el reporte tipado (incremento 0.4).

Criterios de salida:

- Build actual protegido por pruebas.
- Contratos compartidos sin `any` en la API de extensiones.
- Dashboard inicial muestra estado real, no inferido por el nombre del paquete.

## Milestone 1 — Package manager confiable

Objetivo: instalar, actualizar y revertir sin corromper el inventario.

Estado: **completado**. Incremento 1.0 completó el package store
transaccional (staging, límites, hash, commit atómico en directorios
versionados), los rechazos discriminados de manifest y la validación de
`engines.vscode`. Incremento 1.1 añadió enable/disable sin desinstalar y las
pruebas de corte simulado en el commit. Incremento 1.2 completó rollback con
retención de la versión anterior, resolución de
`extensionDependencies`/`extensionPack` con detección de ciclos y el catálogo
Open VSX como puerto. Incremento 1.3 cerró el milestone: grafo de
dependencias resuelto por adelantado (deps antes que la raíz, como VS Code),
update explícito por extensión con check contra el catálogo e inventario del
almacén que limpia huérfanos al arrancar. Progreso detallado:
[extensions-phase1-progress.md](./extensions-phase1-progress.md)

Trabajo:

- Separar catálogo, downloader, manifest reader, package store y registry.
- Staging, límites, hash, validación ZIP y commit atómico.
- Instalar versiones en directorios versionados.
- Enable/disable, uninstall seguro y rollback.
- Resolver `extensionDependencies` y `extensionPack` con grafo y detección de
  ciclos.
- Validar `engines.vscode`, plataforma y arquitectura.
- Añadir provenance y política de prerelease.

Criterios de salida:

- Una instalación fallida deja intacta la versión activa.
- Update y rollback pasan pruebas con corte simulado en cada etapa.
- No hay path traversal, overwrite fuera del store ni registry parcial.

## Milestone 2 — Motor declarativo completo

Objetivo: maximizar compatibilidad segura antes del Extension Host.

Estado: **completado**. Incremento 2.0 completó `contributes.configuration`
y `configurationDefaults` end-to-end: normalización en el manifest reader,
`ConfigurationService` con precedencia default < override < user, puerto de
persistencia de valores de usuario, validación de escrituras contra el
schema declarado, IPC tipado y editor de settings en la vista de detalle.
Incremento 2.1 añadió el `ContributionRegistry` genérico con ownership y
cleanup por extensión: habilitar/deshabilitar aplica y retira sólo las
contribuciones de esa extensión, sin re-registrar el resto ni recargar
Forge (primer criterio de salida del milestone). Incremento 2.2 completó el
scope workspace del `ConfigurationService` (`.forge/settings.json`, con
precedencia workspace > user como VS Code, adaptador de escritura atómica y
desactivado en workspaces remotos) y los eventos de cambio push hacia el
renderer (`onDidChange` → canal `ext:config:changed`). Incremento 2.3
completó `commands`/`keybindings` declarativos con `ContextKeyService` y
evaluador de cláusulas `when`: comandos en la paleta (gated por
`enablement`), despacho de keybindings por plataforma tras los atajos
nativos, y cleanup por extensión vía un ContributionRegistry de workbench
(avanza el tercer criterio de salida del milestone). Incremento 2.4
completó `grammars` TextMate reales con vscode-textmate + vscode-oniguruma
(WASM): tokenización con estado multi-línea, inyecciones, plist y JSON,
ownership con invalidación de caché al retirar, y cinco lenguajes fixture
coloreando en pruebas contra el motor real (segundo criterio de salida del
milestone). Incremento 2.5 completó `menus` declarativos: los items de
`explorer/context` aparecen en el menú contextual del explorador gateados
por sus cláusulas `when` contra keys de recurso transitorias, con títulos
resueltos entre extensiones y orden de grupos de VS Code; al derivarse de
los payloads instalados no pueden quedar registros huérfanos (tercer
criterio de salida). Incremento 2.6 llevó `editor/context` al menú
contextual de Monaco: acciones globales con ids namespaciados por dueño,
`group@order` traducido a los campos de Monaco y — como Monaco no admite
predicados de visibilidad — un conjunto registrado que se reconcilia por
diff cuando cambian las extensiones o las context keys, con las keys
`resource*` del tab activo publicadas por el workbench. Incremento 2.7
cerró el milestone con la superficie de usuario que faltaba: la vista de
detalle lista los comandos de la extensión con su atajo en la notación de
la plataforma, dónde aparece cada uno y cuáles siguen esperando al
Extension Host. Progreso detallado:
[extensions-phase2-progress.md](./extensions-phase2-progress.md)

Orden de contribution points:

1. Corregir y terminar `themes`, `snippets`, `languages`, `iconThemes`.
2. `grammars` con TextMate/Oniguruma y semantic-token coexistence.
3. `configuration` y `configurationDefaults`.
4. `commands` declarativos, `keybindings`, `menus` y `when` clauses.
5. `jsonValidation`, `colors`, `icons`, `productIconThemes`.
6. `problemPatterns`, `problemMatchers` y soporte declarativo de breakpoints.

Infraestructura necesaria:

- `ContributionRegistry` extensible.
- `ContextKeyService`.
- `ConfigurationService` con scopes default/user/workspace/language.
- Ownership y cleanup por extensión.

Criterios de salida:

- Habilitar/deshabilitar una extensión aplica y retira sus contribuciones sin
  recargar Forge.
- Gramáticas reales colorean al menos cinco lenguajes fixture.
- Menús/keybindings reaccionan a context keys y no dejan registros huérfanos.

## Milestone 3 — Kernel del Node Extension Host

Objetivo: activar de forma aislada extensiones simples basadas en comandos.

Estado: **completado**. Incremento 3.0 cerró Workspace Trust y Restricted
Mode, y de paso tres agujeros reales de instalación que las fixtures
maliciosas destaparon: symlinks que escapaban del paquete, un `publisher`
con separadores que escribía fuera del store y capacidades contradictorias
que ni se leían
([extensions-phase3-trust.md](./extensions-phase3-trust.md)). Incremento
3.1 levantó el kernel del host —`utilityProcess`, handshake, envelope RPC
con generaciones, timeouts por familia, heartbeat, backoff y circuit
breaker— todavía sin cargar código de extensión. Incremento 3.2 puso el
loader detrás de ese kernel: entrypoint contenido por realpath,
`require('vscode')` resuelto por dueño, primitivas, enums y
`ExtensionContext` con storage por extensión, con la activación aislada
(la extensión que lanza queda `failed` sin arrastrar a las demás).
Incremento 3.3 completó los comandos de punta a punta —el handler se queda
en el host, sólo cruzan ids— y la activación bajo demanda por
`onCommand:<id>`
([extensions-phase3-progress.md](./extensions-phase3-progress.md)).
Incremento 3.4 completó el activation service (índice evento → extensiones
con `*`, `onStartupFinished`, `onCommand`, `onLanguage` y
`workspaceContains`), `window.show*Message` con notificaciones no modales,
`workspace.getConfiguration` por snapshot síncrono y las métricas y fallos
de activación: con él, el Hello World oficial corre sin modificar, que es
el criterio de salida del milestone. Incremento 3.5 añadió Safe Mode
(`--disable-extensions` y decisión persistida, comprobada en el origen), las
fixtures maliciosas de runtime y el aislamiento demostrado; el 3.6 cerró el
milestone con la superficie de usuario: estado del host, modo seguro,
tiempos y fallos de activación por extensión, y los comandos de la paleta.

Diseño detallado (runtime, protocolo RPC, activación, modelo de fallos y
plan de incrementos 3.0–3.6):
[extensions-phase3-design.md](./extensions-phase3-design.md). Decisiones
principales: el host corre en un `utilityProcess` de Electron con
`MessagePortMain`, el renderer nunca habla directamente con él (main hace
de broker), y el incremento 3.0 es Workspace Trust — el gate de seguridad
lo exige antes de ejecutar código de terceros.

Trabajo:

- Child process dedicado y bootstrap del host.
- RPC versionado, heartbeat, timeout, cancelación y backpressure.
- Loader para `main` e interceptación de `require('vscode')`.
- Primitivas API y `ExtensionContext` con subscriptions y storage.
- Activation service: `onStartupFinished`, `onCommand`, `onLanguage`,
  `workspaceContains` e implicit activation.
- `commands`, configuración de lectura, logging y mensajes básicos.
- Restart host, safe mode y crash-loop protection.

Criterios de salida:

- Una extensión Hello World sin modificar se instala, activa por comando,
  muestra un mensaje y se desactiva limpiamente.
- Una extensión que lanza excepción no derriba Electron ni React.
- Una extensión colgada termina por timeout y queda diagnosticada.

## Milestone 4 — Workspace, documentos y edición

Objetivo: soportar extensiones de productividad y edición.

Estado: **en progreso**. Incremento 4.0 completó `Uri`, workspace folders y
`workspace.fs` con política de rutas propia (workspace, directorio de la
extensión en sólo lectura y storage), autorizada sobre el realpath y con el
filesystem como puerto: local por Node y remoto por un puente SSH. Incremento
4.1 añadió el espejo de documentos y `workspace.textDocuments` con sus
eventos: una extensión ve el buffer del usuario, no el disco. Diseño y
plan de incrementos 4.0–4.6:
[extensions-phase4-design.md](./extensions-phase4-design.md) · progreso:
[extensions-phase4-progress.md](./extensions-phase4-progress.md)

Trabajo:

- `Uri`, workspace folders y `workspace.fs`.
- Text documents, active/visible editors y eventos.
- `openTextDocument`, `showTextDocument`, `WorkspaceEdit` y edit builders.
- File watchers y búsquedas con cancelación.
- Clipboard, progress, output channels, quick pick/input box.
- Storage global/workspace y secrets.

Criterios de salida:

- Fixtures de edición aplican cambios multiarchivo con version checks.
- Watchers se liberan al desactivar.
- Recursos locales y SSH pasan por la misma abstracción URI.

## Milestone 5 — Language features

Objetivo: ejecutar formatters, linters y proveedores IntelliSense.

Trabajo:

- Diagnostic collections.
- Completion, hover, signature help, definition, references, symbols.
- Formatting, code actions, rename, folding, links, colors, inlay hints.
- Semantic tokens con merge/prioridad frente a TextMate.
- Document selectors y cancellation tokens correctos.
- Bridge a LSP existente para extensiones que lanzan language servers.

Criterios de salida:

- Fixtures para cada provider y al menos Prettier/ESLint o alternativas Open
  VSX representativas evaluadas end-to-end.
- Cancelar una petición obsoleta evita resultados sobre un documento cambiado.
- Diagnostics se retiran al deshabilitar/desinstalar.

## Milestone 6 — Workbench extensible

Objetivo: integrar extensiones que contribuyen UI nativa.

Trabajo:

- Status bar, tree data providers y views containers.
- Decorations, CodeLens y editor/title/context menus.
- SCM providers.
- URI handlers y authentication providers con consentimiento.
- Theme/icon refresh completo y product icons.

Criterios de salida:

- Views y status items respetan ownership, ordering, visibility y context keys.
- Ninguna extensión obtiene acceso directo al DOM del workbench.

## Milestone 7 — Tasks, terminales, testing y debug

Objetivo: soportar workflows que ejecutan herramientas externas.

Trabajo:

- Task providers, executions y problem matchers.
- Terminal API sobre el servicio PTY persistente.
- Testing API y panel de resultados.
- Debug configuration providers y tracker factories.
- DAP session manager y UI de debugging.
- Workspace Trust obligatorio en rutas de ejecución.

Criterios de salida:

- Una extensión puede contribuir/ejecutar una task y publicar problemas.
- Un debug adapter fixture completa launch, break, step y terminate.
- Restricted Mode bloquea ejecución aunque se invoque el command ID directo.

## Milestone 8 — Webviews, custom editors y notebooks

Objetivo: habilitar extensiones con superficies complejas sin exponer Forge.

Trabajo:

- Webview aislada, CSP, local resource roots y message bridge.
- Webview views y serializers.
- Custom text editors y custom readonly editors.
- Notebook serializers, controllers y renderers.
- Retención/revival con límites de memoria.

Criterios de salida:

- Webview no puede acceder al DOM o APIs Electron de Forge.
- Navegación, recursos y command URIs obedecen política explícita.
- Custom editor y notebook fixture sobreviven reload y restore.

## Milestone 9 — Web Extension Host y remoto

Objetivo: respetar `browser`, `extensionKind` y workspaces remotos.

Trabajo:

- Host Web Worker con loader compatible para bundles web.
- Host remoto desplegable sobre SSH.
- Resolver de ubicación `ui`/`workspace`/web.
- Virtual workspace capability y schemes no-file.
- Sincronización selectiva de extensiones/perfiles con remoto.

Criterios de salida:

- Una web extension fixture corre sin Node globals.
- Una workspace extension opera junto al filesystem remoto.
- El reporte explica por qué se eligió cada host o por qué no existe uno válido.

## Milestone 10 — Producto de tienda y hardening

Objetivo: convertir la plataforma en una experiencia mantenible para usuarios.

Trabajo:

- Perfiles, auto-update configurable, prerelease y update channels.
- Compatibility dashboard por extensión y API faltante.
- Runtime status, activation time, logs, crash history y export diagnostic.
- Recommendations, extension packs y workspace recommendations.
- Filtros `@installed`, `@enabled`, `@disabled`, `@updates`, `@builtin`.
- Firma/integridad cuando la fuente lo permita.
- Matriz CI por SO, arquitectura, local/remoto y versión de API objetivo.
- Auditoría de seguridad, fuzzing de VSIX/JSONC/RPC y pruebas de carga.

Criterios de salida:

- Actualizaciones pueden pausarse y revertirse.
- Safe mode recupera el editor de una extensión problemática.
- La compatibilidad publicada se deriva automáticamente de pruebas y runtime.

## Primer incremento recomendado

El Milestone 3 está cerrado: los siete incrementos (3.0–3.6) están hechos y
el gate de seguridad queda cubierto salvo la integración con un
`utilityProcess` real, que este entorno no puede ejecutar sin display.

El próximo cambio de código es el **incremento 4.2**: `window.activeTextEditor`,
`visibleTextEditors`, selección y `showTextDocument`. El espejo de documentos
ya está; falta la capa de editores encima, que es estado del renderer igual
que los buffers.

Diseño: [extensions-phase3-design.md](./extensions-phase3-design.md).
Progreso del kernel: [extensions-phase3-progress.md](./extensions-phase3-progress.md).
No se carga código de terceros hasta cerrar el resto del gate en
[extensions-security-and-testing.md](./extensions-security-and-testing.md).
