# Documentación de Forge Code

Índice de `docs/`. Cada documento declara su alcance. **El roadmap y la
matriz de compatibilidad mandan** sobre cualquier nota histórica de
extensiones. El mapa del editor (no el de extensiones) está en
[app-architecture.md](./app-architecture.md). Setup y scripts:
[README de la raíz](../README.md).

## Empezar por aquí

| Documento | Para qué sirve |
| --- | --- |
| [app-architecture.md](./app-architecture.md) | Procesos main/preload/renderer, store, IPC, workbench y `.forge/`. |
| [brand-and-rename.md](./brand-and-rename.md) | Identidad Forge Code, carpeta local y conservación de perfiles y configuración. |
| [workbench-design.md](./workbench-design.md) | Diseño del workbench, jerarquía visual y decisiones de interacción. |
| [CODING_GUIDELINES.md](./CODING_GUIDELINES.md) | Reglas de arquitectura y estilo (límites de tamaño, slices, anti-monolitos). |
| [REFACTORING_PROGRESS.md](./REFACTORING_PROGRESS.md) | Bitácora del refactor: slices extraídos y monolitos que quedan. |

## Producto (fuera de extensiones)

| Documento | Para qué sirve |
| --- | --- |
| [ai-and-agents.md](./ai-and-agents.md) | Agente nativo, providers, acciones rápidas, CLIs de terminal y bridge de Claude Code. |
| [git-and-scm.md](./git-and-scm.md) | Git por CLI, diffs y device flow de GitHub. |
| [lsp.md](./lsp.md) | Language server nativo de TS/JS (no el bridge de extensiones). |
| [remote-workspaces.md](./remote-workspaces.md) | Motor `ssh://`: qué opera en remoto y qué no. |
| [terminal-session-persistence.md](./terminal-session-persistence.md) | El PTY sobrevive a cambios de pestaña; React no es dueño del proceso. |
| [remote-ssh-modal.md](./remote-ssh-modal.md) | Nota histórica del bug de `window.prompt()` en el modal SSH. |

## Verificación de la entrega

[QA de Forge Code y extensiones 4.4](./verification-2026-10-31.md): pruebas, flujos reales y límites.

## Sistema de extensiones

El trabajo grande del proyecto. Se lee en este orden:

| Documento | Para qué sirve |
| --- | --- |
| [extensions-architecture.md](./extensions-architecture.md) | Arquitectura objetivo: capas, lifecycle, RPC, API `vscode`, seguridad. |
| [extensions-roadmap.md](./extensions-roadmap.md) | Milestones 0–10. **Fuente de verdad del plan.** |
| [extensions-compatibility.md](./extensions-compatibility.md) | Matriz por capability. **Fuente de verdad de qué funciona.** |
| [extensions-security-and-testing.md](./extensions-security-and-testing.md) | Amenazas, trust, controles de install/runtime y el gate antes de ejecutar código de terceros. |
| [extensions-marketplace.md](./extensions-marketplace.md) | Tienda tal como está: búsqueda, install, updates, badges y lo que falta. |

### Progreso por milestone

| Documento | Milestone |
| --- | --- |
| [extensions-phase0-progress.md](./extensions-phase0-progress.md) | 0 — contratos, manifest reader, DTOs y readers segregados. |
| [extensions-phase1-progress.md](./extensions-phase1-progress.md) | 1 — package store transaccional, instalación, updates y rollback. |
| [extensions-phase2-progress.md](./extensions-phase2-progress.md) | 2 — motor declarativo (2.0–2.7). |
| [extensions-phase3-design.md](./extensions-phase3-design.md) | 3 — diseño del kernel del Extension Host (3.0–3.6). |
| [extensions-phase3-trust.md](./extensions-phase3-trust.md) | 3.0 — Workspace Trust y fixtures maliciosas de instalación. |
| [extensions-phase3-progress.md](./extensions-phase3-progress.md) | 3.1+ — utilityProcess, envelope RPC, heartbeat, reinicio. |

### Notas históricas

| Documento | Estado |
| --- | --- |
| [extensions-phase2-implementation.md](./extensions-phase2-implementation.md) | Fase 2 anterior a la numeración actual. No es el roadmap vigente. |

## Convenciones de esta carpeta

- Los documentos de progreso se escriben **por incremento**, con una
  sección de decisiones que explica el porqué de lo no obvio.
- Un incremento no se da por cerrado sin actualizar su documento de
  progreso, el roadmap y —si cambia lo que un usuario puede hacer— la
  matriz de compatibilidad.
- Un sistema de producto nuevo (IA, Git, LSP, remoto, …) tiene su
  propio doc; no se mete de pasada en una nota de extensiones.
