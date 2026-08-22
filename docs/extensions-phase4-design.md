# Milestone 4 — Diseño de workspace, documentos y edición

Documento de diseño previo a la implementación, en la línea del
[Milestone 3](./extensions-phase3-design.md): fija qué parte del estado del
editor cruza al host, en qué dirección y con qué garantías, antes de escribir
código.

Contexto: el Milestone 3 dejó el host ejecutando extensiones reales, con
comandos, activación por evento, mensajes y configuración
([progreso](./extensions-phase3-progress.md)). Todo lo que una extensión
puede tocar hoy es *suyo* (sus comandos, su storage) o de sólo lectura (la
configuración). Este milestone es el primero en que una extensión **observa y
modifica el trabajo del usuario**, y ahí es donde el diseño tiene que ser
explícito.

## 1. El problema de fondo: dónde vive la verdad

| Dato | Dueño real | Consecuencia |
| --- | --- | --- |
| Contenido en disco | filesystem (local o SSH) | main ya lo abstrae; el host pregunta |
| Buffer abierto y sin guardar | renderer (Monaco) | main **no** lo tiene: hay que espejarlo |
| Selección, editor activo | renderer | ídem |
| Workspace abierto | main | ya lo publica |

De ahí la regla que gobierna el milestone: **un documento abierto no se lee
del disco**. Una extensión que lea `package.json` mientras el usuario tiene
cambios sin guardar debe ver lo que el usuario ve, no lo que hay en disco.
Eso obliga a un espejo del estado de documentos en main, alimentado por el
renderer, y es el trabajo del incremento 4.1 — no un detalle de
implementación.

## 2. Topología

Se mantiene la del Milestone 3 (`renderer → main → host`, arquitectura §1.2).
Lo nuevo es que main deja de ser sólo broker y pasa a mantener **estado
derivado**: el espejo de documentos. Ese espejo es autoridad para el host y
réplica para el renderer; ante discrepancia gana el renderer, que es quien
tiene el buffer.

```text
renderer                     main                        host
  Monaco  ──documentos──►  DocumentMirror  ──eventos──►  workspace.textDocuments
  tabs    ◄──ediciones───  WorkspaceEdit   ◄──applyEdit── extensión
                           fs local/SSH    ◄──workspace.fs──
```

## 3. `workspace.fs` y la política de rutas

`workspace.fs` es host→main. Main resuelve cada `Uri` con la abstracción que
ya usa el workbench, que trata local y SSH por igual — con eso el criterio de
salida «recursos locales y SSH pasan por la misma abstracción URI» sale casi
gratis.

**Desviación deliberada de VS Code**: allí `workspace.fs` alcanza cualquier
ruta del sistema. En Forge una extensión sólo puede tocar

- el workspace abierto,
- su propio directorio de instalación (sólo lectura),
- su directorio de storage.

Fuera de ahí se responde un `FileSystemError` tipado que dice exactamente
eso. Es más estricto que VS Code, y es una decisión consciente: el gate de
seguridad de este proyecto parte de que una extensión instalada no es
confiable por el hecho de estar instalada, y una API de ficheros sin límites
convierte cualquier extensión comprometida en un exfiltrador. Si una
extensión real necesita más, el error queda registrado en el reporte de
compatibilidad y la decisión se revisa con un caso delante, no por si acaso.

El host tiene Node completo y puede saltarse esto con `require('fs')`. No es
contradictorio: lo que se defiende aquí es la API *soportada*, para que el
día que exista un sandbox real (Milestone 9, host web) el contrato ya sea el
correcto y no haya que romper extensiones.

## 4. Documentos

- **Identidad**: `Uri` normalizada. Dos rutas que apuntan al mismo archivo
  son el mismo documento.
- **Versión**: entero monótono por documento, del renderer. Es lo que hace
  verificable una edición: una `WorkspaceEdit` contra una versión vieja se
  rechaza en vez de pisar lo que el usuario escribió mientras tanto.
- **Ciclo**: `didOpen` al abrir pestaña, `didChange` al editar (agregado, no
  por pulsación), `didSave`, `didClose` al cerrarla. El host recibe eventos,
  nunca sondea.
- **Contenido**: viaja entero, con *debounce*, no por pulsación. Es la misma
  estrategia con la que el editor ya sincroniza sus buffers con el servidor
  de lenguaje (`src/lsp/client.ts`), y reutilizarla evita un segundo
  mecanismo —y una segunda fuente de verdad— sobre el mismo buffer.

  > Corrección respecto a la primera versión de este diseño, que pedía
  > deltas en `didChange`. Los deltas son la optimización correcta cuando el
  > volumen lo justifique, y el riesgo §8 ya dice que se mide antes de
  > ampliar; introducirlos ahora significaría mantener dos protocolos de
  > sincronización distintos para el mismo contenido, uno de ellos sin
  > ningún dato que lo respalde todavía.
- `openTextDocument` de un archivo no abierto lo lee del disco **sin** abrir
  pestaña: en VS Code tampoco la abre, y hacerlo convertiría cualquier
  extensión en algo que reordena el editor del usuario.

## 5. Ediciones

`WorkspaceEdit` se aplica en el renderer, que es quien tiene los buffers, y
main coordina:

1. La extensión construye la edición y llama `applyEdit`.
2. Main valida: rutas dentro de política, versiones que coinciden.
3. El renderer aplica todas las ediciones de un archivo en una operación
   (un solo undo), y responde éxito por archivo.
4. Si una versión no cuadra, **la edición entera se rechaza**. Aplicar la
   mitad de una refactorización multiarchivo es peor que no aplicar nada.

Los archivos no abiertos se editan en disco; los abiertos, en el buffer,
quedando sucios como si el usuario hubiera escrito.

## 6. Ciclo de vida y fugas

Watchers, output channels y suscripciones cuelgan de la extensión que los
creó y se liberan en `deactivate` — el `HostCommandRegistry` del 3.3 ya
establece el patrón (propiedad por extensión, `disposeOwner`). El criterio de
salida «watchers se liberan al desactivar» se prueba, no se promete: un
watcher huérfano es un proceso que sigue leyendo disco por una extensión que
ya no existe.

## 7. Plan de incrementos

| # | Alcance | Criterio de salida |
| --- | --- | --- |
| 4.0 | `Uri`, workspace folders, `workspace.fs` con política de rutas | Una fixture lee, escribe y lista dentro del workspace; fuera falla tipado, y un workspace SSH funciona igual |
| 4.1 | Espejo de documentos en main + `workspace.textDocuments` y sus eventos | Una fixture ve el buffer sucio, no el disco, y recibe open/change/save/close |
| 4.2 | `window.activeTextEditor`, `visibleTextEditors`, selección, `showTextDocument` | Una fixture lee la selección y abre un documento sin robar el foco |
| 4.3 | `WorkspaceEdit`, `applyEdit`, edit builders con version checks | Edición multiarchivo aplicada en un undo; versión desfasada rechaza entera |
| 4.4 | File watchers y `findFiles` con cancelación | Watcher liberado al desactivar, demostrado; búsqueda cancelable |
| 4.5 | Output channels, quick pick, input box, progress, clipboard | Una fixture publica salida y pide datos sin bloquear el workbench |
| 4.6 | `secrets` sobre almacenamiento cifrado del SO | Un secreto sobrevive al reinicio y no aparece en claro en disco |

## 8. Riesgos

- **Volumen de tráfico.** Los deltas de edición son el canal más ruidoso que
  habrá; se miden antes de ampliar (arquitectura §15) y el broker ya tiene
  agregación por ventana.
- **Divergencia del espejo.** Si el renderer y main se desincronizan, una
  extensión edita sobre una versión que no existe. Mitigación: las versiones
  las emite el renderer y toda edición las verifica; ante duda, se rechaza.
- **Alcance.** `TextEditor` completo, decoraciones y `TextEditorEdit` son un
  imán de scope creep; 4.2 se limita a leer y a mostrar, y las decoraciones
  quedan para el Milestone 6 con el resto del workbench.
