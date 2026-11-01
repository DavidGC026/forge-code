# Workspaces remotos (SSH)

Forge Code abre una carpeta en otro host y la trata como workspace. El
modelo es un URI `ssh://`, no un mount FUSE ni un Extension Host
remoto (eso es Milestone 9).

La historia del modal está en
[remote-ssh-modal.md](./remote-ssh-modal.md). Este doc es el contrato
del motor.

## URI

```
ssh://<user@host>/<path>
```

El target se `encodeURIComponent`; el path, `encodeURI`. `~` y `~/…`
se expanden en el remoto a `$HOME`. Parser y builder viven en
`electron/main.ts`.

Ejemplo: `ssh://david@devbox/home/david/proj`.

## Qué sí funciona

| Capacidad | Cómo |
| --- | --- |
| Conectar / navegar carpetas | IPC `remote:connect`, `remote:browse` — listan directorios por SSH |
| Leer / escribir / crear / borrar / renombrar | Las APIs `fs:*` ramifican: si el path es `ssh://`, corren comandos remotos (`cat`, `find`, `mkdir`, `rm`, …) |
| Imágenes | `readImageDataUrl` también va por SSH |
| Terminal | `createSshPty()`: `ssh -t <target> 'cd <path> && exec $SHELL'` sobre `node-pty` |
| Explorer | El árbol usa las mismas `fs:*`; el URI es el path canónico de tabs y selección |

Hace falta un `ssh` que ya autentique (agente, llave, `~/.ssh/config`).
Forge Code no pide contraseña interactiva.

## Qué no funciona (y no está escondido en la UI)

| Hueco | Por qué |
| --- | --- |
| Watcher (`chokidar`) | `fs:watch` no-op en remoto; el árbol no se refresca solo |
| Settings de extensión workspace | `.forge/settings.json` es local; el scope workspace se apaga |
| Tools del agente nativo | `agent-tools.ts` usa `fs` de Node sobre un path local |
| Git / SCM | `git.ts` necesita un cwd real |
| LSP nativo | `typescript-language-server` no ve el árbol remoto |
| Extension Host remoto | Milestone 9; las extensiones corren (cuando corran) en la máquina de Forge Code |

Restricted Mode es el default de un workspace remoto. Confiarlo es una
decisión explícita; hoy no se puede marcar remoto como trusted desde
la UI (`grantWorkspaceTrust` rechaza remotos). Ver
[extensions-phase3-trust.md](./extensions-phase3-trust.md).

## UI

`TitleBar` y `ExplorerPanel` abren el modal (`remoteSlice` +
`RemoteSSHModal`). Primero se valida el host, después se elige la
carpeta (filtro local o path escrito). Errores en línea; nada de
`prompt()` / `alert()`.
