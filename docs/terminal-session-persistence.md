# Persistencia de sesiones de terminal

## Problema resuelto

Las terminales de agentes se reiniciaban al cambiar de pestaña o ubicación porque
`XTermView` creaba el PTY y también lo destruía durante el desmontaje de React.
Un cambio puramente visual terminaba así el proceso interactivo del agente.

## Diseño

La responsabilidad se divide en tres capas:

- `terminalSlice`: conserva el estado de navegación y ejecuta las acciones
  explícitas de crear, seleccionar y cerrar una sesión.
- `TerminalSessionManager`: es propietario del ciclo de vida del PTY, mantiene
  sus suscripciones IPC y conserva un búfer acotado de salida para reconstruir
  la pantalla cuando vuelve a montarse una vista.
- `XTermView`: presenta xterm, envía entrada y se suscribe a una sesión. Su
  desmontaje sólo desconecta la vista; nunca destruye el proceso.

Esta separación aplica responsabilidad única e inversión de dependencias: la
vista depende del contrato del gestor de sesiones y no controla directamente la
vida del proceso.

## Contrato de ciclo de vida

| Acción | Resultado |
| --- | --- |
| Cambiar entre terminales | El PTY continúa ejecutándose |
| Abrir la pestaña de chat | Las terminales de agentes continúan ejecutándose |
| Ocultar un panel | Las sesiones continúan ejecutándose |
| Mover agentes entre sidebar, panel derecho y panel inferior | Las sesiones continúan ejecutándose |
| Cerrar una terminal | Se destruye el PTY y se libera su búfer |
| Reiniciar un agente | Se cierra la sesión anterior y se crea una nueva |
| Cerrar Forge Code | Electron termina todos los PTY activos |

## Memoria y alcance

Cada sesión conserva aproximadamente los últimos 2 millones de caracteres de
salida y elimina primero los bloques completos más antiguos. Esto mantiene
acotado el consumo de memoria durante sesiones largas y reduce el riesgo de
fragmentar la salida ANSI almacenada.

La persistencia cubre toda la ejecución actual de Forge Code. Recuperar un proceso
interactivo después de cerrar y volver a abrir la aplicación requeriría un
multiplexor externo (por ejemplo `tmux`) o un daemon de terminal independiente y
no forma parte de este cambio.
