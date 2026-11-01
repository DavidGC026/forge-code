# Verificación de Forge Code — 2026-10-31

La entrega renombra el proyecto a `forge-code` / **Forge Code**, rediseña
el workbench y completa el incremento 4.4 de extensiones. El siguiente
incremento es el 4.5; no se declara compatibilidad completa con VS Code.

## Validación automática

- TypeScript del renderer y main, y build Vite: correctos.
- Suite completa de extensiones: **414 pruebas correctas**, sin omitidas.
- Lock actualizado con TextMate/Oniguruma ya declarados y la versión de
  rebuild que exigía el manifiesto; las gramáticas y WASM se validan.
- El build mantiene un aviso por el tamaño del chunk Oniguruma (~631 kB).

En este equipo pnpm 11 puede intentar reinstalar antes de cada script;
la verificación usó `pnpm_config_verify_deps_before_run=false` tras instalar
y comprobar el lock. No se cambió la configuración global de pnpm.

## Flujo real con Electron

Se ejecutó Electron 28 con los bundles de producción, un perfil y un
workspace temporales y una extensión fixture local instalada como VSIX.
El host fue un `utilityProcess` real, observado por el IPC de la aplicación.

| Flujo | Resultado |
| --- | --- |
| Restaurar el último workspace desde un perfil aislado | Archivos y nombre visibles al arrancar |
| Iniciar y reiniciar el host | Estado `running`, generaciones 1 y 2 |
| Ejecutar `findFiles` | Devuelve los archivos `.ts` y `.md` de la carpeta temporal |
| Crear watcher y cambiar/crear/borrar archivos | Recibe los tres tipos de evento |
| Activar extensión antes de abrir un documento | El getter ve el documento abierto después |
| Aplicar `WorkspaceEdit` al buffer de Monaco | Devuelve éxito y el editor muestra la edición |
| Guardar desde la barra del editor | La edición aparece en el archivo temporal |
| Crear PTY y ejecutar un comando | Salida de ejecución recibida por IPC |
| Interfaz a 1400 y 520 px | Sin desbordamiento horizontal; paneles estrechos en overlay |

El AppImage final también se ejecutó con ese perfil temporal: restauró el
workspace, arrancó su host real, ejecutó búsquedas y editó un buffer; su PTY
ejecutó el comando de comprobación. El artefacto está en
`release/Forge Code-1.0.0.AppImage` (aproximadamente 120 MiB).

La inspección visual incluye inicio, proyecto, Monaco, terminal y asistente
sin credenciales. No se hicieron llamadas a proveedores de IA.

La QA detectó y corrigió fallos previos: `env: undefined` impedía lanzar el
proceso, el evento de restauración podía adelantarse a React, los getters
del host quedaban congelados por un spread y el layout se publicaba antes
que sus documentos. Cada corrección tiene una regresión automática.

## Límites

Los escenarios maliciosos de crash, timeout y tormenta de logs conservan
pruebas con transporte simulado; esta QA real cubre el flujo normal. SSH se
prueba mediante doble y mediante sus comandos reales sobre un filesystem
local temporal, sin conexión a un servidor SSH. Watchers usa polling con
los límites descritos en [el progreso 4.4](./extensions-phase4-progress.md).

Las sesiones, ajustes, claves y extensiones del perfil real del usuario no
forman parte de las fixtures de prueba. La migración mantiene los perfiles
existentes; ver [identidad y rutas](./brand-and-rename.md).
