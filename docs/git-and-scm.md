# Git y Source Control

Forge Code habla con el `git` del PATH. No hay libgit2. El backend es
`electron/git.ts`; la UI es `SourceControlPanel` + `gitSlice`.

## Operaciones

| Acción | Canal IPC | Notas |
| --- | --- | --- |
| Status | `git:status` | branch, cambios, ahead/behind, upstream |
| Stage / unstage / discard | `git:stage`, `git:unstage`, `git:discard` | paths relativos al workspace |
| Commit | `git:commit` | el cuadro de commit puede pedir un mensaje a la IA |
| Push / pull | `git:push`, `git:pull` | HTTPS usa el helper de credenciales en memoria |
| Diff | `git:diff`, `git:fileVersions`, `git:diffSummary` | tabs `GitDiffEditor` (inline o side-by-side) |
| Log | `git:log` | Timeline del Explorer (por archivo) |
| Ramas | `git:listBranches`, `git:checkoutBranch`, `git:createBranch` | picker en el panel |

El modo de diff (inline vs dos columnas) se configura en Settings.

## GitHub OAuth (device flow)

`electron/github-auth.ts` implementa el
[device flow](https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
para remotes HTTPS.

Hace falta una OAuth App **propia**: GitHub → Settings → Developer
settings → OAuth Apps, con *Enable Device Flow* marcado. El client id
es público (no hay secret). El usuario lo pega una vez en el modal del
panel de Source Control.

El token **no** viaja en la línea de comandos. `git.ts` lo inyecta con
un credential helper en memoria para `git push` / `git pull`.

Forge Code no trae un client id de producto. Sin App configurada, push/pull
HTTPS depende de la config de git del usuario.

## Dónde no corre

El cwd de git es el path del workspace. Un workspace `ssh://…` no es
un directorio local: status, stage y el resto **no** operan contra el
host remoto. Ver [remote-workspaces.md](./remote-workspaces.md).

Tampoco hay SCM providers de extensiones (Milestone 6).
