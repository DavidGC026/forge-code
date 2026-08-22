# Extensiones: progreso del Milestone 4 (workspace, documentos y edición)

Última actualización: 2026-08-22

Diseño: [extensions-phase4-design.md](./extensions-phase4-design.md) · Milestone
anterior: [extensions-phase3-progress.md](./extensions-phase3-progress.md)

## Incremento 4.0 — `Uri`, workspace folders y `workspace.fs`

Completado (2026-08-22). Criterio de salida del diseño §7: *«Una fixture lee,
escribe y lista dentro del workspace; fuera falla tipado, y un workspace SSH
funciona igual»*.

- **Política de rutas** (`domain/file-access.ts`): pura, sin filesystem, para
  que la regla sea verificable. Una extensión alcanza el workspace (lectura y
  escritura), su directorio de instalación (**sólo lectura**: una extensión
  que reescribe su propio código deja sin sentido al instalador
  transaccional) y su almacenamiento. Fuera de ahí, `NoPermissions` con un
  mensaje que dice exactamente qué pasó. La contención exige frontera de
  separador: `/home/dev/project-2` no está dentro de `/home/dev/project`,
  por mucho que la cadena lo sugiera.
- **Desviación consciente de VS Code**, documentada en el diseño §3: allí
  `workspace.fs` alcanza cualquier ruta del sistema. El gate de seguridad de
  este proyecto parte de que una extensión instalada no es confiable por
  estarlo, y una API de ficheros sin límites convierte a cualquier extensión
  comprometida en un exfiltrador. El rechazo se **reporta**, así que si una
  extensión real necesita más, aparece con un caso delante en lugar de
  ampliarse por si acaso.
- **Autorización sobre el realpath**, no sobre la cadena: `path.resolve` no
  sigue symlinks y el filesystem sí, así que un enlace que apunta fuera del
  workspace se rechaza aunque la ruta parezca contenida. Es la misma regla
  que aplica el loader desde el 3.2.
- **`rename` y `copy` autorizan los dos extremos.** Leer de un sitio
  permitido y escribir en uno prohibido es justo la exfiltración que la
  política existe para impedir.
- **El filesystem es un puerto** (`ExtensionFileSystemPort`). El adaptador de
  Node traduce errno a los códigos de `FileSystemError` que las extensiones
  capturan (`FileNotFound`, `FileExists`, `FileNotADirectory`…), y las rutas
  remotas van por un puente SSH que main inyecta con los mismos helpers que
  ya usa el workbench. Sin puente configurado, una URI remota falla
  `Unavailable` en vez de resolverse contra el disco local — que es como una
  extensión acabaría leyendo los archivos de la máquina equivocada.
- **Host**: `workspace.fs` completo (`stat`, `readFile`, `writeFile`,
  `readDirectory`, `createDirectory`, `delete`, `rename`, `copy`),
  `FileSystemError` como clase real con sus constructores estáticos,
  `workspaceFolders`, `name`, `getWorkspaceFolder` y `asRelativePath`. Los
  bytes viajan en base64 porque sobreviven a cualquier transporte; un typed
  array no. `readDirectory` devuelve tuplas `[nombre, tipo]`, que es lo que
  las extensiones desestructuran.
- **Un solo workspace folder**, reportado como array de uno. Forge abre una
  carpeta cada vez; fingir multi-root haría que el código de la extensión
  pareciera correcto hoy y fallara el día que existan varias.

Pruebas añadidas (19 casos; la suite pasa de 291 a 310 tests):
`tests/extensions/workspace-fs.test.cjs` (18: frontera de separador,
los tres ámbitos y su modo, escritura rechazada en el directorio de
instalación, refusal reportado sin tocar el disco, symlink que escapa,
`rename`/`copy` con ambos extremos, operación desconocida, round-trip del
adaptador, traducción de errno, directorio no vacío, URI remota sin puente y
con él, y la facade del host con base64, tuplas y reconstrucción del error) y
`extension-host.test.cjs` (+1: la fixture `filesystem` escribiendo de verdad
en un workspace temporal a través del protocolo completo).

### Decisiones del incremento 4.0

- **La política es dominio puro y se prueba sin disco.** Es la parte que, si
  se equivoca, se equivoca en silencio y a favor del atacante.
- **Sólo lectura en el directorio de la extensión.** Cualquier otra cosa
  entra en conflicto con la instalación transaccional del Milestone 1.
- **La URI remota no cae al filesystem local.** Un fallo tipado es
  recuperable; leer la máquina equivocada, no.
- **El host tiene Node completo y puede saltarse esto con `require('fs')`.**
  No es contradictorio: lo que se define aquí es el contrato de la API
  soportada, para que el día que exista un sandbox real (Milestone 9) no haya
  que romper extensiones para aplicarlo.

## Incremento 4.1 — espejo de documentos y `workspace.textDocuments`

Completado (2026-08-22). Criterio de salida del diseño §7: *«Una fixture ve
el buffer sucio, no el disco, y recibe open/change/save/close»*.

- **`DocumentMirror`** (application): réplica en main de los buffers del
  renderer. Su única razón de existir es responder bien a una pregunta —qué
  ve el usuario en este archivo ahora— y por eso `contentOf` devuelve `null`
  cuando el archivo no está abierto: sólo entonces se cae al disco.
- **Las versiones las emite el renderer**, nunca main. Son lo que hará
  verificable la `WorkspaceEdit` del 4.3, y una versión inventada aquí
  validaría una edición contra una revisión que nunca existió. Un `change`
  con versión igual o anterior se **descarta con explicación**, igual que uno
  de un documento que nunca se abrió: el espejo prefiere quedarse corto a
  inventar.
- **`TextDocument`** (host): `getText`, `lineAt`, `offsetAt`, `positionAt`,
  `getWordRangeAtPosition`, `validateRange`. Todo se calcula en el host
  porque son las llamadas que ocurren en bucle — un linter sobre 2000 líneas
  serían 2000 round-trips. El índice de líneas se recalcula al cambiar el
  contenido, no por llamada, y `positionAt` hace búsqueda binaria.
- **Instancia estable**: un `change` actualiza el documento que la extensión
  ya tiene, no lo sustituye. Devolver un objeto nuevo congelaría la vista de
  quien lo guardó en `onDidOpenTextDocument`, sin ningún error que lo
  explicara.
- **`Position`, `Range` y `Selection`** como primitivas inmutables, con la
  normalización de VS Code (un rango construido al revés se ordena solo) y
  `Selection` conservando de qué lado está el cursor. `Range` sólo se congela
  cuando es realmente un `Range`: `Selection` lo extiende y aún tiene campos
  que asignar — un fallo que la primera versión tuvo y las pruebas
  destaparon.
- **`DocumentSyncService`** (renderer): versiones monótonas, *debounce* de
  los cambios, contenido completo, y `flush` antes de un guardado para que
  `onDidSaveTextDocument` vea el texto guardado y no el anterior. Un
  contenido idéntico no es un cambio: en Forge los agentes escriben en los
  buffers mediante streaming, y sin esa comprobación cada escritura
  programática sería un evento.
- **`openTextDocument`** de un archivo sin pestaña lo lee del disco **sin**
  abrirla, bajo la misma política de rutas que `workspace.fs` — abrir un
  documento no puede ser la forma de rodearla.
- El espejo se alimenta desde donde el editor ya sincronizaba con el
  servidor de lenguaje, y cubre **todos** los buffers de texto, no sólo los
  que un LSP entiende: a una extensión puede importarle cualquier archivo.

Pruebas añadidas (26 casos; la suite pasa de 310 a 336 tests):
`tests/extensions/documents.test.cjs` (25: primitivas, documento vacío con
una línea, CRLF, clamp de offsets, palabra bajo el cursor, ciclo del
registry con instancia estable, reapertura tratada como cambio, cambio
huérfano descartado, `reset` que siembra sin eventos, el espejo devolviendo
el buffer sucio, evento obsoleto descartado, host caído que no rompe la
escritura del usuario, validación en el borde, y el servicio del renderer:
debounce, contenido idéntico ignorado, flush al guardar, versiones
monótonas, reconciliación de pestañas y cierre que cancela lo pendiente) y
`extension-host.test.cjs` (+1: la fixture `documents` viendo el ciclo
completo por el protocolo, incluida la revisión sin guardar).

### Decisiones del incremento 4.1

- **Contenido completo con debounce, no deltas.** Corrige el diseño inicial
  y está anotado allí: es la estrategia con la que el editor ya sincroniza
  con el LSP, y un segundo protocolo para el mismo texto significaría dos
  fuentes de verdad. Los deltas llegarán cuando haya una medida que los pida.
- **El espejo descarta lo dudoso.** Un evento obsoleto o huérfano no se
  aplica: es preferible que el host vaya un instante por detrás a que
  retroceda a una revisión que el usuario ya no tiene.
- **Un fallo al notificar al host no interrumpe al usuario.** Escribir en el
  editor no puede fallar porque una extensión esté reiniciándose.

## Incremento 4.2 — editores, selección y `showTextDocument`

Completado (2026-08-22). Criterio de salida del diseño §7: *«Una fixture lee
la selección y abre un documento sin robar el foco»*.

- **`EditorRegistry`** (host): `window.activeTextEditor`,
  `visibleTextEditors` y los eventos de foco, selección y visibilidad. Un
  editor es una **vista** de un documento, así que su `document` es el mismo
  objeto que la extensión ya tiene de `workspace.textDocuments`; un editor
  cuyo documento el host no conoce se descarta en vez de inventarse.
- **La instancia del editor también es estable.** Cambiar la selección
  actualiza el editor que la extensión guardó, no lo sustituye.
- **El layout viaja entero en cada cambio**, no como stream de movimientos:
  hay un puñado de editores, y reconciliar una lista es mucho más fácil de
  acertar. El servicio del renderer compara con lo último enviado y **no
  republica** si nada cambió — el caret dispara eventos en cada pulsación, y
  sin eso el canal más ruidoso de la aplicación sería el que no lleva
  información.
- **Conversión de coordenadas en un solo sitio**: Monaco es 1-based y la API
  de VS Code 0-based. Se traduce al publicar, para que ningún consumidor
  tenga que recordarlo.
- **`showTextDocument`** cruza al renderer y **espera**: la promesa de la
  extensión se resuelve cuando la pestaña existe de verdad. `preserveFocus`
  se honra —revelar un documento en segundo plano no roba el cursor— y la
  espera tiene tope: un renderer que no conteste no puede dejar a la
  extensión colgada el resto de la sesión.
- **La política de rutas también aplica a revelar**: `editors.show` hace
  `stat` bajo las mismas reglas que `workspace.fs`, porque abrir un documento
  no puede ser la forma de rodear lo que el sistema de archivos rechaza.
- **`editor.edit()` no está**, y se nota a propósito: pertenece al 4.3 con el
  resto de la maquinaria de edición, y un edit builder a medias sería peor
  que un `UnsupportedApiError` honesto.

Pruebas añadidas (11 casos; la suite pasa de 336 a 347 tests):
`documents.test.cjs` (+9: editor con su caret y foco, instancia estable,
sync idéntico que no dispara nada, editor sin documento descartado, cierre
que limpia el activo, multi-cursor con el primario primero, constructor del
layout, ruta activa inexistente reportada como «sin foco» y servicio que sólo
envía lo que cambió) y `extension-host.test.cjs` (+2: la fixture leyendo el
texto bajo la selección y siguiendo el foco por el protocolo, y
`showTextDocument` con `preserveFocus` viajando a main).

### Decisiones del incremento 4.2

- **El layout se publica entero y se deduplica.** Es la respuesta a que el
  caret cambie constantemente: barato de construir, y el que no cambia no
  cruza.
- **Sin documento no hay editor.** `editor.document` tiene que ser el objeto
  que la extensión ya conoce; cualquier otra cosa produce dos vistas del
  mismo archivo que no se comparan iguales.
- **`showTextDocument` espera al renderer.** Una promesa que resuelve antes
  de que el editor exista hace que la línea siguiente de la extensión —leer
  `activeTextEditor`— falle de forma intermitente.

## Próximo incremento

4.3 — `WorkspaceEdit`, `applyEdit` y edit builders con version checks. Es el
incremento que cierra el bucle: hasta ahora las extensiones **observan** el
trabajo del usuario; a partir de ahí lo **modifican**, y las versiones que el
4.1 dejó viajando son lo que hace verificable cada edición.
