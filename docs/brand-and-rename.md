# Identidad y cambio de nombre a Forge Code

El nombre público del editor es **Forge Code**. El paquete Node y la
carpeta local del proyecto se llaman `forge-code`; la carpeta anterior
era `editor-app`. Esto distingue al editor de código de otros proyectos
con ese nombre genérico.

## Identidad de ejecución y distribución

| Superficie | Valor |
| --- | --- |
| Paquete (`package.json.name`) | `forge-code` |
| Producto (`build.productName`) | `Forge Code` |
| Nombre interno de Electron y título inicial de ventana | `Forge Code` |
| Título HTML | `Forge Code` |
| Identificador instalable (`build.appId`) | `com.forge.app` (conservado) |
| Icono | `electron/assets/forge-logo.svg` y PNG de 512 px (barras de la nueva identidad) |

`scripts/prepare-pack.mjs` copia los metadatos del paquete raíz a
`.electron-pack/package.json`. Por eso el nuevo nombre también llega a
electron-builder y a los artefactos de `release/`, sin una segunda fuente
de configuración. El target sigue siendo AppImage Linux.

Los metadatos del bridge de Claude Code, el cliente LSP y el User-Agent
de GitHub también identifican el producto como Forge Code / `forge-code`.
Los nombres de servicios, canales IPC, variables `FORGE_*`, clases y tokens
de estilo conservan su namespace técnico para evitar cambios de contrato.

## Perfiles y datos existentes

Cambiar el nombre del paquete puede cambiar el `userData` predeterminado
de Electron. `electron/app-identity.ts`, importado antes de los servicios
de main, fija explícitamente `userData` **y** `sessionData` antes de que
Electron esté listo. Así la configuración y el almacenamiento de Chromium
(incluido `localStorage`) siguen en el perfil anterior.

- En desarrollo se prefiere `<appData>/forge`.
- En la aplicación empaquetada se prefiere `<appData>/Forge`.
- Si ese directorio no existe y el otro sí, se usa el perfil existente.
- Si existen ambos, se conserva la preferencia según el modo de ejecución;
  los perfiles no se mezclan.
- Un `--user-data-dir=/ruta/absoluta` explícito tiene prioridad en ambos
  modos y mantiene allí toda la sesión. Sirve también para QA aislado.

En Linux, `appData` suele ser `~/.config` (o `$XDG_CONFIG_HOME`). La copia
local comprobada antes del cambio usa `~/.config/forge`. No se renombran
ni se copian perfiles automáticamente y no se crea un perfil adicional
`forge-code` / `Forge Code` con la configuración vacía.

Siguen iguales `forge-config.json`, el directorio de extensiones del
perfil, las claves `forge.*` de `localStorage`, el namespace IPC `forge`
y los metadatos `.forge/` de cada workspace. El cambio de nombre tampoco
reinicia los ajustes de extensiones ni las decisiones de Workspace Trust.

La persistencia de los PTY sigue limitada a la ejecución de la aplicación:
cerrarla termina esos procesos. Conservar el perfil no restaura un proceso
de terminal después de cerrar el editor.

## Cambio de carpeta local

Con el editor y los procesos de desarrollo cerrados, renombra la carpeta
`editor-app` a `forge-code` y abre de nuevo el proyecto desde esa ruta.
Los scripts de build y empaquetado resuelven rutas desde el proyecto y no
dependen del nombre anterior. Los accesos directos, terminales externas o
workspaces guardados que apunten a la ruta absoluta anterior deben abrir
la carpeta nueva; si este repositorio era el último workspace, vuelve a
seleccionarlo con **Abrir carpeta**.

El 2026-10-31 también se renombró el repositorio de GitHub a
`DavidGC026/forge-code`, conservando su historial. Se creó la copia privada
`DavidGC026/forge-code` en Git dvguzman. El remoto `origin` apunta a GitHub
y `gitea` a completa-1 por Tailscale. Ver
[repositorios y publicaciones](./repositories-and-releases.md).
