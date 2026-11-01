# Plataforma de extensiones de Forge: arquitectura objetivo

Estado del documento: **marco normativo** (la implementación se mide en
la [matriz](./extensions-compatibility.md) y el
[roadmap](./extensions-roadmap.md))
Última revisión: 2026-08-22

## 1. Objetivo

Forge construirá una plataforma capaz de instalar y ejecutar extensiones creadas
para la API estable de VS Code, con compatibilidad incremental, observable y
verificable. La meta no es afirmar compatibilidad total antes de tenerla, sino
ampliar sistemáticamente la superficie soportada sin comprometer el editor.

La anatomía que debemos respetar es la de VS Code: manifiesto, contribution
points, activation events y las funciones `activate`/`deactivate`. El host se
elige además según `main`, `browser` y `extensionKind`.

Referencias primarias:

- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
- [Activation Events](https://code.visualstudio.com/api/references/activation-events)
- [VS Code API](https://code.visualstudio.com/api/references/vscode-api)

## 2. Alcance y definición de compatibilidad

“Usar extensiones de VS Code” incluye varias clases distintas:

1. Extensiones puramente declarativas: temas, gramáticas, snippets, lenguajes,
   iconos, configuración, menús y keybindings.
2. Extensiones Node: declaran `main` y esperan el módulo `vscode`, Node.js y un
   host local o cercano al workspace.
3. Extensiones web: declaran `browser` y esperan un Web Extension Host.
4. Extensiones de lenguaje, tareas y depuración: registran providers o lanzan
   procesos auxiliares mediante LSP, DAP, terminales y task runners.
5. Extensiones de interfaz: views, tree views, status bar, webviews, custom
   editors y notebooks.
6. Extensiones remotas: esperan ejecutarse donde vive el workspace.

La primera meta estable es la API pública estable. APIs `proposed`, módulos
nativos incompatibles, dependencias de internals de VS Code y extensiones que
comprueban el producto por nombre podrán quedar bloqueadas o degradadas. Cada
caso debe aparecer en el reporte de compatibilidad.

## 3. Estado actual auditado

Instantánea al 2026-08-22. El detalle por capability está en
[extensions-compatibility.md](./extensions-compatibility.md); esto
sólo nombra el piso sobre el que se construye.

Ya existe y se usa:

- Búsqueda e instalación desde Open VSX o VSIX local, transaccional
  (staging, hash, directorios `<id>/<version>`, rollback, deps).
- Enable/disable, update por extensión y sweep de huérfanos.
- Motor declarativo: themes, snippets, languages, icon themes en el
  Explorer, grammars TextMate, configuration (user + workspace),
  commands/keybindings/menus con `when`.
- Analyzer con reporte tipado (`none` / `partial` / `full` + blockers).
- Workspace Trust y Restricted Mode (3.0).
- Extension Host (3.1–3.6): `utilityProcess`, RPC, heartbeat, backoff,
  loader de `main`, facade `vscode`, contexto, activación, comandos y modo seguro.
- Workspace, documentos y edición (4.0–4.4): filesystem local/SSH con
  política de rutas, buffers y editores sincronizados, ediciones con versión,
  watchers y búsquedas cancelables.
- Integración Electron real verificada en Linux el 2026-10-31:
  [evidencia y límites](./verification-2026-10-31.md).

Deuda vigente:

- `electron/extensions.ts` sigue siendo facade; no debe absorber
  responsabilidades nuevas.
- El preload de `ext:*` está tipado; otros namespaces (`lsp`, `ai`,
  `claudeIde`) todavía usan `any`.
- APIs del 4.5/4.6 y milestones posteriores según el roadmap.
- No hay perfiles, auto-update ni Extension Host web/remoto.

## 4. Principios SOLID aplicados

### Responsabilidad única

Cada componente tendrá una sola razón de cambio:

- Catálogo: búsqueda y metadatos remotos.
- Package service: descarga, validación, extracción e instalación.
- Manifest service: parsing y normalización.
- Registry: inventario, versiones, enablement y perfiles.
- Compatibility analyzer: capacidades requeridas y soportadas.
- Contribution services: una familia por contribution point.
- Host manager: procesos, activación, reinicio y salud.
- API bridge: implementación del módulo `vscode` y RPC.
- Workbench adapters: integración con Monaco y la UI de Forge.

### Abierto/cerrado

Agregar un contribution point o namespace de API debe implicar añadir un
adaptador que implemente un contrato, no modificar un `switch` monolítico.

### Sustitución de Liskov

Los hosts Node, Web y Remote cumplirán el mismo contrato de lifecycle y RPC.
Una implementación que no pueda garantizar una operación debe responder con una
capacidad no soportada; no debe simular éxito.

### Segregación de interfaces

No existirá una interfaz gigante `ExtensionService`. Se usarán puertos pequeños:
`ExtensionCatalog`, `PackageInstaller`, `ManifestReader`, `ExtensionRegistry`,
`ExtensionHost`, `CommandBridge`, `WorkspaceBridge`, `LanguageBridge`, etc.

### Inversión de dependencias

Los casos de uso dependerán de esos puertos. Electron, Open VSX, filesystem,
Monaco, Zustand e IPC serán adaptadores reemplazables en los bordes.

## 5. Modelo de procesos

```text
┌──────────────────────────── Forge Workbench / renderer ────────────────────────────┐
│ UI, Monaco, commands, views, status bar, notifications, compatibility dashboard    │
└───────────────────────────────▲─────────────────────────────────────────────────────┘
                                │ RPC tipado + eventos
┌───────────────────────────────┴─────────────────────────────────────────────────────┐
│ Electron main: broker y servicios privilegiados                                    │
│ instalación · registro · trust · filesystem · procesos · terminal · LSP · DAP      │
└──────────────▲────────────────────────▲────────────────────────▲────────────────────┘
               │                        │                        │
     ┌─────────┴─────────┐    ┌─────────┴─────────┐    ┌─────────┴─────────┐
     │ Node Extension   │    │ Web Extension     │    │ Remote Extension  │
     │ Host child proc. │    │ Host WebWorker    │    │ Host sobre SSH    │
     │ main entrypoint  │    │ browser entrypoint│    │ workspace-side    │
     └──────────────────┘    └───────────────────┘    └───────────────────┘
```

Reglas no negociables:

- El renderer no ejecuta código de extensiones.
- El proceso main no hace `require()` directo de una extensión.
- Un crash del host no derriba Forge.
- Los mensajes cruzan contratos versionados y validados.
- Los servicios privilegiados verifican identidad, trust y capacidades; no
  confían sólo en lo declarado por el cliente RPC.

El child process proporciona aislamiento de fallos, no un sandbox de seguridad
completo: una extensión Node tiene capacidades del usuario del sistema. Por eso
la confianza y la transparencia son parte del producto, no una nota secundaria.

## 6. Capas y contratos

### 6.1 Dominio

Tipos sin Electron, React, Monaco o filesystem:

- `ExtensionId`, `ExtensionVersion`, `ExtensionLocation`.
- `ExtensionManifest`, `NormalizedManifest`, `EngineConstraint`.
- `InstalledExtension`, `ExtensionProfile`, `EnablementState`.
- `CompatibilityReport`, `Capability`, `SupportLevel`.
- `ActivationEvent`, `ExtensionLifecycleState`, `HostKind`.
- Errores discriminados: manifest, integridad, red, política, activación y RPC.

### 6.2 Aplicación

Casos de uso orquestadores:

- Search/get detail/install/update/rollback/uninstall.
- Enable/disable por usuario, workspace y perfil.
- Resolve dependencies y extension packs.
- Analyze compatibility.
- Activate/deactivate/restart extension.
- Dispatch activation events.
- Collect diagnostics y performance.

### 6.3 Infraestructura

Adaptadores iniciales:

- `OpenVsxCatalogAdapter`.
- `LocalVsixSourceAdapter`.
- `FileSystemPackageStore`.
- `JsonExtensionRegistry` migrable a una base dedicada.
- `ElectronNodeHostAdapter`.
- `MonacoLanguageAdapter` y adaptadores de workbench.

### 6.4 Presentación

La tienda y la página de detalle consumen view models; no inspeccionan el
manifiesto ni deducen capacidades mediante strings. Un `extensionSlice` separado
del store principal manejará el estado de UI y llamará casos de uso vía preload.

## 7. Estructura objetivo

La migración será incremental; no se moverá todo en un solo cambio.

```text
electron/extensions/
  domain/             # entidades, value objects y errores
  application/        # casos de uso y puertos
  infrastructure/
    catalog/          # Open VSX
    packages/         # VSIX, staging, integridad
    persistence/      # registry, profiles, state
    hosts/            # Node/remote host managers
  ipc/                # handlers y validación de DTO
  index.ts             # composition root

electron/extension-host/
  bootstrap.ts
  lifecycle.ts
  rpc/
  vscode-api/         # namespaces segregados

src/extensions/
  application/        # facade del workbench
  contributions/      # themes, snippets, languages, commands...
  bridges/            # Monaco/UI/commands/workspace
  store/              # extensionSlice
  ui/                  # componentes de tienda y runtime
```

Los contratos compartidos serán DTO explícitos y versionados. No se importarán
entidades con dependencias de Electron dentro del renderer.

Estado de migración: el Milestone 0.2 introdujo DTOs Electron dedicados y
`protocolVersion: 1` en `ext:list`. Esto es un handshake inicial; todavía no es
el envelope RPC general requerido para los futuros Extension Hosts.

El Milestone 0.3 añadió puertos/readers separados para las cuatro contribuciones
actuales y una política central de resolución de recursos que impide salir del
directorio instalado. La facade ya no interpreta estos archivos directamente.

## 8. Instalación transaccional

Flujo requerido:

1. Resolver versión y descargar a staging.
2. Aplicar límites de tamaño, timeout y redirects.
3. Calcular hash y conservar provenance.
4. Validar ZIP/VSIX, zip-slip, manifest, ID, versión y `engines.vscode`.
5. Extraer a un directorio temporal sin seguir symlinks fuera del paquete.
6. Analizar contribuciones, entrypoints, dependencias y compatibilidad.
7. Mover atómicamente la versión validada al store.
8. Actualizar registry en escritura atómica.
9. Activar o mantener deshabilitada según política.
10. Si falla cualquier paso, conservar la versión anterior.

El registry almacenará por extensión y versión: fuente, fecha, hash, ubicación,
estado, perfil, engine solicitado, capacidades, última activación, fallos y
versión anterior disponible para rollback.

## 9. Lifecycle y activación

Estados mínimos:

```text
discovered -> installed -> disabled
                    └──-> enabled -> activating -> active
                                      │             │
                                      └── failed <──┘
active -> deactivating -> enabled
failed -> restarting -> activating
installed/disabled/enabled -> uninstalling -> removed
```

Invariantes:

- `activate()` se invoca una sola vez por generación del host.
- Los contribution points declarativos pueden registrarse sin activar código.
- Los eventos se indexan para no recorrer todas las extensiones en cada acción.
- Se soportarán primero `onStartupFinished`, `onCommand`, `onLanguage`,
  `workspaceContains` y activación implícita por contribuciones modernas.
- `deactivate()` tiene timeout; después se fuerza el cierre del contexto.
- Todos los `Disposable` asociados a una extensión se liberan al desactivar.

## 10. Protocolo RPC

El protocolo tendrá versión, request ID, extension ID, método, parámetros y
resultado/error serializable. Los límites IPC validarán schemas y tamaños.

Familias de mensajes:

- Lifecycle: initialize, activate, deactivate, shutdown, heartbeat.
- API calls: commands, workspace, window, languages, configuration, env.
- Workbench events: editor/document/workspace/configuration/trust changes.
- Providers: register/unregister e invoke/cancel.
- Diagnostics: log, error, metrics, unsupported API usage.

Requisitos:

- Timeout y cancelación por request.
- Backpressure para eventos y logs.
- IDs opacos para objetos remotos y disposables.
- Errores tipados, sin serializar stacks sensibles hacia UI por defecto.
- Handshake que negocia protocolo y versión de API emulada.

## 11. Implementación del módulo `vscode`

El host interceptará `require('vscode')` y devolverá una facade estable. Cada
namespace delegará a un puerto pequeño. Orden inicial:

1. Primitivas: `Disposable`, `EventEmitter`, `Uri`, `Position`, `Range`,
   `Selection`, `CancellationTokenSource`, enums y `MarkdownString`.
2. `commands`.
3. `workspace`: folders, documents, `workspace.fs`, configuración y eventos.
4. `window`: active editor, show/open document, mensajes, output channels,
   status bar, progress y quick pick básico.
5. `languages`: diagnostics y providers de lenguaje.
6. `env`, `extensions`, `authentication`, `tasks`, `debug`, `scm`, `tests`,
   notebooks y webviews según las fases del roadmap.

No se devolverán stubs silenciosos. Una API pendiente genera un error
`UnsupportedApiError`, se registra en telemetría local y actualiza el reporte de
compatibilidad de la extensión.

## 12. Contribution registry

Cada contribution point implementará un contrato equivalente a:

```ts
interface ContributionAdapter<TContribution> {
  readonly key: string;
  validate(value: unknown, context: ContributionContext): ValidationIssue[];
  register(value: TContribution, context: ContributionContext): Disposable;
}
```

El registry resolverá adaptadores por clave. Así `grammars`, `commands`,
`configuration`, `menus` o `debuggers` evolucionan de manera independiente.
Todos deben ser idempotentes y retornar disposables.

Durante la migración previa al registry genérico, themes, snippets, languages e
icon themes ya utilizan readers segregados. Éstos son adaptadores de lectura; el
futuro `ContributionRegistry` añadirá lifecycle, ownership y disposables.

## 13. Context keys, comandos y menús

Una gran parte del ecosistema depende de `when` clauses. Forge necesita un
`ContextKeyService` central con parser, evaluación incremental y eventos. Será
consumido por commands, keybindings, menus, views y trust.

El `CommandService` tendrá un único namespace global, ownership por extensión,
resolución de colisiones, argumentos serializables y activación bajo demanda.

## 14. Seguridad y confianza

Antes del primer Node Extension Host deben existir:

- Trust por workspace y Restricted Mode.
- Enable/disable y Safe Mode sin extensiones.
- Confirmación clara al instalar VSIX local o publisher no verificado.
- Política de enlaces, webviews, command URIs y acceso a secretos.
- CSP estricta y roots locales para webviews.
- Storage aislado por extensión.
- Secret storage cifrado mediante capacidades del sistema operativo cuando sea
  posible.
- Auditoría local de activaciones, crashes y permisos sensibles.

Forge seguirá las declaraciones `capabilities.untrustedWorkspaces` y
`capabilities.virtualWorkspaces`. Véanse las guías oficiales de
[Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
y [Virtual Workspaces](https://code.visualstudio.com/api/extension-guides/virtual-workspaces).

## 15. Rendimiento y resiliencia

Presupuestos iniciales medibles:

- La tienda no bloquea el renderer con parsing o I/O.
- Ninguna extensión se activa durante startup sin evento válido.
- Heartbeat del host y detección de proceso colgado.
- Timeouts por activation y provider call configurables.
- Medición por extensión: activation time, CPU aproximada, memoria, errores y
  requests pendientes.
- Circuit breaker para extensiones con crash loop.
- “Restart Extension Host” y “Start With Extensions Disabled”.

Los presupuestos numéricos definitivos se fijarán con benchmarks del milestone 0
en lugar de inventarlos antes de medir la aplicación actual.

## 16. Local, web y remoto

Forge implementará primero host Node local. Después:

- Web host en Web Worker para entrypoint `browser`, sin APIs Node.
- Host remoto junto al workspace SSH para extensiones `workspace`.
- Selección basada en entrypoints, `extensionKind`, ubicación y capacidades.
- `workspace.fs` como abstracción preferida para recursos virtuales/remotos.

La guía oficial confirma que VS Code puede tener hosts local, web y remoto, y que
`extensionKind` expresa preferencia `ui`/`workspace`.

## 17. Decisiones de producto

- Catálogo predeterminado: Open VSX, que se presenta como alternativa abierta y
  neutral al Marketplace de Visual Studio.
- Instalación manual: VSIX conservada.
- Microsoft Marketplace: no se integrará sin revisión legal y autorización
  contractual explícita.
- API objetivo: versión estable declarada por Forge y visible en Settings.
- APIs proposed: deshabilitadas por defecto y fuera de la promesa de
  compatibilidad.
- Forkear Code OSS completo no es el enfoque inicial; Forge conservará su
  workbench y construirá bridges compatibles de forma incremental.

Referencia: [Eclipse Open VSX](https://github.com/eclipse-openvsx/openvsx).

## 18. Definition of Done transversal

Una capacidad no se marca “soportada” hasta tener:

1. Contrato tipado y validación en límites.
2. Implementación y cleanup idempotente.
3. Pruebas unitarias.
4. Prueba de integración host ↔ broker ↔ workbench.
5. Fixture VSIX y, cuando aplique, una extensión pública representativa.
6. Manejo de error, timeout y cancelación.
7. Telemetría local/diagnóstico y documentación de compatibilidad.
8. Sin regresiones de build, startup y desinstalación.
