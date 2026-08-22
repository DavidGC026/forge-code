# Seguridad y estrategia de pruebas de extensiones

Este documento define los bloqueadores que deben cumplirse antes de ejecutar el
`main` o `browser` de una extensión de terceros.

## 1. Modelo de amenazas

Activos a proteger:

- Archivos del usuario y workspaces.
- Credenciales, tokens y secret storage.
- Procesos, terminales, red y clipboard.
- Integridad del editor y disponibilidad de la sesión.
- Datos de otras extensiones.

Amenazas principales:

- VSIX malicioso: zip-slip, symlinks, zip bomb y manifest patológico.
- Supply chain: descarga alterada, publisher confundible o update comprometido.
- Código Node con acceso al sistema del usuario.
- Workspace malicioso que induce ejecución mediante settings/tasks/debug.
- Webview con XSS, navegación externa o acceso excesivo a recursos locales.
- RPC flooding, payloads gigantes, objetos remotos filtrados y deadlocks.
- Extensión defectuosa: loop de CPU, memory leak, crash loop o provider colgado.

## 2. Límites de confianza

| Límite | Confianza |
| --- | --- |
| Renderer Forge | Código propio; no recibe objetos ejecutables de extensiones |
| Electron main/broker | Privilegiado; valida identidad, schemas y políticas |
| Node Extension Host | Código no confiable para estabilidad; no es sandbox completo |
| Web Extension Host | Aislado por Web Worker, sin Node; sigue sujeto a cuotas/política |
| Webview | Contenido no confiable, CSP estricta y message schema |
| Workspace | No confiable hasta decisión explícita de Workspace Trust |
| Catálogo/VSIX | Entrada no confiable hasta descargar, validar y registrar |

## 3. Workspace Trust

Forge tendrá Trusted y Restricted Mode. En Restricted Mode:

- No se ejecutan tasks, debug, terminal commands ni procesos inducidos por el
  workspace.
- Se respetan `capabilities.untrustedWorkspaces` y restricted configurations.
- Contribuciones puramente declarativas seguras pueden continuar.
- El command handler vuelve a verificar trust; ocultar el menú no es suficiente.

Referencia: [Workspace Trust Extension Guide](https://code.visualstudio.com/api/extension-guides/workspace-trust).

Estado: implementado en el Milestone 3.0 —estado por workspace persistido,
Restricted Mode por defecto (carpetas nuevas y workspaces remotos incluidos)
y política de activación basada en `capabilities.untrustedWorkspaces`. Ver
[extensions-phase3-trust.md](./extensions-phase3-trust.md).

## 4. Controles de package/install

- Límite de bytes descargados, descomprimidos, número de entries y ratio.
- Canonicalización de paths, rechazo de escapes y política de symlinks.
- Staging en filesystem local y commit atómico.
- Hash SHA-256 y provenance persistidos.
- Validación estricta de ID/version/entrypoint y schema tolerante hacia campos
  desconocidos.
- Rollback si falla extracción, análisis, registry o activación inicial.
- No ejecutar scripts npm de instalación.

Estado: desde Milestone 3.0, la extracción rechaza entradas que escapan del
paquete, entradas symlink y manifiestos cuya identidad (`name`/`publisher`)
no puede usarse como segmento de ruta; el install por marketplace verifica
además que el paquete descargado declare el id solicitado.

Estado: desde Milestone 0.3, todos los readers declarativos resuelven recursos
dentro del root instalado y rechazan escapes. Los controles de
extracción/staging (límites, hash, commit atómico, zip-slip) cerraron en
el Milestone 1; el 3.0 añadió el rechazo de symlinks y de identidades
que no son segmentos de ruta seguros.

## 5. Controles de runtime

- Host separado, heartbeat, activation timeout y shutdown timeout.
- Límites de tamaño y frecuencia RPC; cancelación y backpressure.
- Circuit breaker por crash loop.
- Ownership de commands/providers/disposables.
- Secret storage aislado por extension ID.
- Logs con redacción de secretos y paths cuando se exportan.
- Safe Mode y deshabilitación desde fuera del host.

## 6. Webviews

- `contextIsolation`, sandbox y sin Node integration.
- CSP con nonce; sin `unsafe-eval` y sin scripts inline arbitrarios.
- Local resource roots explícitos.
- Navegación y `openExternal` mediante allowlist de schemes.
- Mensajes validados por schema, tamaño y extension owner.
- Command URIs deshabilitadas salvo opt-in seguro.

## 7. Pirámide de pruebas

### Unitarias

- Manifest normalization y engine constraints.
- JSONC, when-clause parser y context evaluation.
- Dependency graph/cycles.
- Compatibility analyzer.
- Contribution adapters y cleanup.
- RPC serialization, error mapping y cancellation.

### Contract tests

- Cada namespace del módulo `vscode` contra fixtures.
- Mismo contrato para Node local, Web y Remote host.
- DTO preload/main/renderer versionados.

### Integración

- Instalar → habilitar → activar → usar → desactivar → desinstalar.
- Host crash/restart, timeout y pérdida de IPC.
- Workspace local, remoto, trusted y restricted.
- Update/rollback con fallos inyectados.

### End-to-end

- Extensiones fixture empaquetadas como VSIX real.
- Corpus público fijado por versión.
- Interacción visible en Monaco/workbench.

### Seguridad y robustez

- Fuzzing de ZIP, manifest JSONC, theme/grammar y mensajes RPC.
- Zip bombs simuladas y payload limits.
- Traversal/symlink cases por plataforma.
- Webview CSP/XSS tests.
- Extensión con CPU loop, memory growth, crash loop y event flood.

## 8. Matriz CI

Como mínimo:

- Linux, Windows y macOS cuando haya runners disponibles.
- Arquitecturas soportadas por el empaquetado.
- Workspace local y remoto.
- Trusted/Restricted Mode.
- Host Node y Web cuando ambos existan.
- Instalación limpia, update y rollback.

Los tests que descargan extensiones públicas no deben depender de `latest`.
Usarán versión y hash fijados o un cache controlado.

## 9. Gate para habilitar Extension Host

No se ejecuta código de terceros hasta pasar:

| Requisito | Estado | Dónde |
| --- | --- | --- |
| Instalación transaccional | Cubierto | Milestone 1 ([progreso](./extensions-phase1-progress.md)) |
| Enable/disable fuera del host | Cubierto | Milestone 1 |
| Workspace Trust básico | Cubierto | Milestone 3.0 ([progreso](./extensions-phase3-trust.md)) |
| Fixtures maliciosos mínimos de **package** | Cubierto | Milestone 3.0 (`tests/fixtures/extensions/malicious/`) |
| Fixtures maliciosos mínimos de **runtime** | Cubierto | Milestone 3.5 (`hanging`, `crasher`, `log-storm`, `hijacker`) |
| RPC schema/timeout/heartbeat | Cubierto | Milestone 3.1 ([progreso](./extensions-phase3-progress.md)) |
| Crash isolation demostrado | Cubierto | Milestone 3.5 (timeout de la colgada, crash con backoff, request en vuelo rechazado) |
| Logs y reporte de activation failure | Cubierto | Milestone 3.4 (`ext:host:activation`, métricas y fallos por generación) |
| Safe Mode | Cubierto | Milestone 3.5 (`--disable-extensions` y decisión persistida, comprobado en el origen) |
