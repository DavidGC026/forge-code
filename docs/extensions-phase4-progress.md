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

## Próximo incremento

4.1 — espejo de documentos en main y `workspace.textDocuments` con sus
eventos. Es el incremento que hace verdadera la regla del diseño §1: un
documento abierto se lee del buffer del usuario, nunca del disco.
