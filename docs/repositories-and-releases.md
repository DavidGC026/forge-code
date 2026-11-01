# Repositorios y publicaciones de Forge Code

Desde el 2026-10-31 ambos repositorios pertenecen a **DavidGC026**:

| Servicio | Repositorio | Visibilidad |
| --- | --- | --- |
| GitHub | https://github.com/DavidGC026/forge-code | Pública, conservada del repositorio anterior |
| Git dvguzman | https://git.dvguzman.com/DavidGC026/forge-code | Privada |

GitHub se renombró desde `editor-app`, conservando commits e historial.
Gitea recibe el mismo historial de `main`. El usuario del repositorio es
`DavidGC026`; las cuentas SSH del sistema no cambian su propietario.

## Remotos y sincronización

```bash
git remote add origin git@github.com:DavidGC026/forge-code.git
git remote add gitea git@100.83.26.44:DavidGC026/forge-code.git

git push origin main
git push gitea main
```

Si el remoto ya existe, usar `git remote set-url` en lugar de `add`.
El SSH de Gitea entra por Tailscale a completa-1. La web usa
`git.dvguzman.com`; el SSH público de ese dominio no es el acceso configurado
para esta copia. Los dos pushes son explícitos: publicar en uno no actualiza
el otro automáticamente.

Los branches internos de antiguos worktrees no se usan como ramas de
producto ni se publican; los commits integrados se conservan en `main`.

## Distribución Linux

La publicación **v1.0.0** incluye en ambos servicios:

- `Forge-Code-1.0.0-x86_64.AppImage`
- `Forge-Code-1.0.0-x86_64.AppImage.sha256`

Los binarios son adjuntos de Releases; `release/`, builds, dependencias y
perfiles locales siguen fuera del historial de código.

Tras descargar ambos adjuntos en el mismo directorio:

```bash
sha256sum -c Forge-Code-1.0.0-x86_64.AppImage.sha256
chmod +x Forge-Code-1.0.0-x86_64.AppImage
./Forge-Code-1.0.0-x86_64.AppImage
```

La compilación y QA de esta entrega están en
[verification-2026-10-31.md](./verification-2026-10-31.md).
Las descargas de Git dvguzman requieren una sesión con acceso al repositorio.
