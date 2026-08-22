# Fixtures de runtime del Extension Host

Extensiones **reales** (CommonJS, sin dependencias) que el `ExtensionRuntime`
carga en `tests/extensions/extension-runtime.test.cjs`. Cubren los cuatro
resultados que el modelo de fallos del diseño §6 distingue:

| Fixture | Qué ejercita |
| --- | --- |
| `healthy` | `require('vscode')`, `context.subscriptions`, exports, `deactivate()` |
| `throwing` | excepción en `activate` tras registrar un disposable |
| `unsupported` | uso de una API que Forge todavía no implementa |
| `silent` | `main` válido sin `activate` exportado (extensión declarativa) |
| `escaping` | `main` que apunta fuera del directorio instalado |
| `commanding` | `commands.registerCommand`, comando que lanza y comando sin `dispose` |
| `messaging` | `window.showInformationMessage` y `workspace.getConfiguration` |
| `helloworld` | el ejemplo oficial de VS Code, sin adaptar: criterio de salida del Milestone 3 |

## Fixtures maliciosas de runtime (gate de seguridad §9)

Extensiones hostiles a propósito. No comprueban que Forge las impida hacer
daño *dentro* de su proceso —el modelo de VS Code tampoco lo hace: el host
tiene Node completo— sino que **el daño no sale de ahí**: el resto de
extensiones, el proceso main y la ventana sobreviven, y lo ocurrido queda
diagnosticado.

| Fixture | Ataque | Contención esperada |
| --- | --- | --- |
| `hanging` | `activate` que nunca devuelve el control | timeout por familia; el host sigue sirviendo al resto |
| `crasher` | `process.exit` durante la activación | muere la generación, no Forge; reinicio con backoff |
| `log-storm` | miles de líneas de log seguidas | recorte por extensión y ventana, sin silenciar a las demás |
| `hijacker` | registra un id de comando que ya es de otra extensión | rechazado: el dueño original conserva el comando |

Ninguna se descarga: el documento de seguridad prohíbe depender de un
registro externo, así que viven en el repo con su versión fijada.
