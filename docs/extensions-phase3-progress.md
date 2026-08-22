# Extensiones: progreso del Milestone 3 (kernel del Extension Host)

Última actualización: 2026-08-22

Diseño: [extensions-phase3-design.md](./extensions-phase3-design.md) · Milestone
anterior: [extensions-phase2-progress.md](./extensions-phase2-progress.md)

## Incremento 3.1 — utilityProcess, handshake, envelope, timeouts y heartbeat

Completado (2026-08-15). Criterio de salida del diseño §8: *«Host arranca,
responde heartbeat, muere y reinicia limpio bajo prueba»*. **Este incremento
no carga extensiones**: cualquier método fuera de `lifecycle` responde
`UNSUPPORTED_API`, que es exactamente lo que debe hacer hasta el 3.2.

- **Vocabulario del protocolo** (`electron/extensions/domain/rpc-protocol.ts`):
  el `RpcEnvelope` del diseño §3.1 (`v`, `gen`, `id`, `kind`, `method`,
  `extensionId?`, `payload`), los seis códigos de error tipados
  (`UNSUPPORTED_API`, `ACTIVATION_FAILED`, `TIMEOUT`, `CANCELLED`,
  `HOST_UNAVAILABLE`, `INVALID_PAYLOAD`), la clase `RpcError` con
  `toPayload()`/`fromPayload()` y el guard `isRpcEnvelope`. La serialización
  **nunca incluye el stack**: viaja `{ code, message, data? }` y nada más
  (arquitectura §10).
- **Puerto `ExtensionHost`**
  (`application/ports/extension-host.ts`): `start`, `stop`, `restart`,
  `request`, `onEvent` y un estado observable
  (`stopped | starting | running | restarting | disabled` + `generation`,
  `restartsInWindow`, `lastError`). Es implementable tanto por el
  `utilityProcess` como por un doble en proceso, que es lo que exige la
  batería de contract tests del diseño §9 y lo que heredará el host remoto
  (arquitectura §16).
- **`RpcBroker`** (`infrastructure/hosts/rpc-broker.ts`): correlación por `id`
  monótono, notificaciones con `id: 0`, timeouts resueltos
  método → familia → default (`lifecycle.activate` 10 s,
  `commands.execute` 5 s, `lifecycle.deactivate` 3 s, `lifecycle.heartbeat`
  2 s, familia `configuration` 2 s, default 5 s), cancelación, validación en
  el borde (un envelope inválido responde `INVALID_PAYLOAD` y **no** se
  enruta), descarte de generaciones desfasadas y agregación de
  `diagnostics.log` en ventanas de 100 ms con límite por extensión
  (200 líneas/s por defecto) que emite una única línea *log rate exceeded*.
  El broker **no importa Electron**: recibe un `RpcTransport`
  (`send`/`onMessage`/`close`) y un `RpcTimers` (`now`/`setTimer`/
  `clearTimer`) como colaboradores.
- **`UtilityProcessExtensionHost`**
  (`infrastructure/hosts/utility-process-host.ts`): la política de ciclo de
  vida completa, sin Electron a la vista. Arranca una generación por spawn,
  hace el handshake §3.2 (`lifecycle.initialize` con
  `{ protocol, apiVersion, extensions, workspace, trust }`; se exige
  `protocol === 1` y `ready === true`), mantiene el heartbeat cada 2 s con
  3 fallos consecutivos ⇒ matar y reiniciar, reinicia por `exit` con backoff
  creciente (500 ms, 1 s, 2 s… tope 8 s) y aplica el circuit breaker de crash
  loop (3 reinicios en 60 s ⇒ `disabled`, sin respawn automático). El
  `HostProcessLauncher` es el único punto donde vive Electron:
  `createUtilityProcessLauncher` hace `utilityProcess.fork` + `MessageChannelMain`
  con un `require('electron')` perezoso, para que el módulo se pueda cargar
  en el runner de pruebas.
- **`electron/extension-host/bootstrap.ts`**: entrypoint del utilityProcess.
  Recibe el `MessagePortMain` por `process.parentPort`, responde
  `lifecycle.initialize` (`{ protocol, nodeVersion, ready: true }`),
  `lifecycle.heartbeat` (`{ ok, uptimeMs }`) y `lifecycle.shutdown`, y
  contesta `UNSUPPORTED_API` a todo lo demás. La lógica está en
  `createBootstrapResponder`, una función pura envelope→envelope; el wiring
  de I/O queda aparte y sólo se ejecuta si `process.parentPort` existe, así
  que el módulo es cargable desde `node --test`.

Pruebas añadidas (43 casos nuevos; la suite pasa de 98 a 141 tests):

- `tests/extensions/rpc-broker.test.cjs` (24): forma exacta del envelope,
  correlación con respuestas fuera de orden, guard del envelope (versión,
  kind, `id` de eventos y requests, `extensionId`), resolución de timeouts
  por método/familia/default, expiración con `TIMEOUT` y evento
  `request-timeout` con su dueño, respuesta tardía descartada, los seis
  códigos de error, código desconocido degradado a `INVALID_PAYLOAD`,
  serialización sin stack, cancelación, fallo de envío, descarte por
  generación desfasada (respuesta, evento y request), envelope malformado
  respondido `INVALID_PAYLOAD` sin enrutar, `UNSUPPORTED_API` sin handler,
  round-trip del handler, agregación de logs por ventana, recorte del
  storm con una sola línea de aviso y presupuesto por extensión, ventana
  deslizante, payloads de log malformados y `dispose` que rechaza todo lo
  pendiente con `HOST_UNAVAILABLE`.
- `tests/extensions/extension-host.test.cjs` (19): handshake completo,
  desajuste de protocolo que aborta sin degradar, handshake sin respuesta,
  requests rechazados fuera de `running`, `UNSUPPORTED_API` de punta a
  punta, heartbeat cada 2 s, dos fallos tolerados y el tercero matando y
  respawneando, contador que se resetea con un latido bueno, reinicio por
  `exit` con backoff creciente, tráfico dirigido sólo a la generación viva,
  circuit breaker (3 reinicios ⇒ `disabled`, `start()` rechazado), ventana
  que desliza, `restart()` explícito que limpia el breaker, `stop()` con
  `shutdown` y sin respawn, host que ignora `shutdown`, logs reenviados con
  su generación, generación muerta que no reporta nada, suscriptor que
  lanza sin romper la máquina de estados, y el responder real del bootstrap
  (orden handshake→heartbeat, eco de `gen` e `id`, `UNSUPPORTED_API`,
  `shutdown` que responde antes de salir).
- `tests/extensions/helpers/rpc-harness.cjs`: reloj y timers falsos,
  transporte falso y un launcher falso cuyos «procesos» ejecutan el
  responder **real** del bootstrap.

Pendiente en este incremento: **la prueba de integración con un
`utilityProcess` real**. Requiere `app.whenReady()` y en este entorno
Electron aborta sin display (`--ozone-platform=headless` vuelca core y no hay
`Xvfb`), así que ejecutarla obligaría a abrir una ventana. Queda anotada para
correrse junto a las fixtures del 3.2/3.5, donde ya habrá extensiones reales
que cargar; el sustituto actual es la mitad en proceso de la batería de
contrato: el mismo `RpcBroker` y el mismo `createBootstrapResponder` que se
empaquetan, hablando por un transporte de prueba.

### Decisiones del incremento 3.1

- **El envelope vive en `domain/rpc-protocol.ts`, no dentro del broker.** Es
  vocabulario compartido por los dos extremos: si lo definiera la
  infraestructura, el puerto de aplicación tendría que importar
  infraestructura para nombrar un código de error, justo la dependencia que
  la arquitectura §4 prohíbe. `rpc-broker.ts` lo **re-exporta**, así que
  para cualquier consumidor (y para las pruebas) el broker sigue siendo el
  módulo del protocolo.
- **El launcher es un puerto, no un detalle interno.** Todo lo específico de
  Electron (`utilityProcess.fork`, `MessageChannelMain`) cabe en
  `createUtilityProcessLauncher`; la política —handshake, heartbeat, backoff,
  breaker— es código puro sobre `HostProcessLauncher` + `RpcTimers`. Por eso
  las pruebas de reinicio y crash loop corren en milisegundos y sin Electron,
  y por eso el host remoto del futuro reutilizará la política entera.
- **Un fallo de handshake no reintenta; un crash sí.** El desajuste de
  protocolo o un entrypoint roto son determinísticos: reintentar sólo
  produciría un bucle con la misma causa, así que el host queda `stopped` con
  `lastError` y la UI podrá explicarlo (diseño §3.2, «nunca degrada en
  silencio»). El `exit` inesperado, en cambio, sí reintenta con backoff.
- **El breaker cuenta reinicios ya realizados, no crashes.** Se permiten 3
  reinicios dentro de la ventana de 60 s; el crash que sigue al tercero
  deshabilita. Contar crashes habría dejado sólo 2 reinicios efectivos, que
  no es lo que dice la tabla del diseño §6.
- **`restart()` explícito limpia el breaker.** Un humano (o el comando
  *Restart Extension Host* del 3.5) pidiendo reinicio es intención nueva, no
  otro síntoma del bucle que disparó el breaker; el reinicio automático, en
  cambio, respeta el presupuesto.
- **El timeout de `lifecycle.heartbeat` es de 2 s, igual que el intervalo.**
  Un presupuesto mayor detectaría un host colgado varios latidos tarde; con
  éste, tres fallos consecutivos se confirman en ~12 s.
- **El host echo de la generación, nunca la inventa.** `main` es su única
  fuente y descarta lo que vuelva con una desfasada; así un `activate` tardío
  de un host muerto no puede registrar nada en el nuevo (diseño §1.3).
- **El límite de logs es por extensión y por ventana de un segundo**, con una
  única línea *log rate exceeded* por ventana: una extensión ruidosa se
  recorta a sí misma sin silenciar a las demás ni inundar el broker.
- **`request()` devuelve `Promise<unknown>`.** El casteo cómodo a un tipo
  esperado escondería que el payload viene del otro lado del proceso; la
  validación por método llega con los schemas del 3.2.

## Cableado del composition root

Completado (2026-08-15). El 3.1 dejó el kernel probado pero desconectado;
esto lo enchufa a Forge sin cargar todavía código de extensión.

- **`electron/extensions.ts`**: la instancia del host vive en la facade, no
  en `main.ts`, junto al resto del subsistema. `initialize` se reconstruye
  por generación, así que un reinicio siempre refleja el workspace, la
  decisión de confianza y el conjunto habilitado del momento.
- **`activatableExtensionIds()`**: sólo llegan al host las extensiones
  habilitadas **y** activables bajo la confianza actual
  (`isActivatableUnderTrust`). Una extensión bloqueada no queda "oculta en
  la UI": su id no viaja, de modo que ninguna generación puede cargarla por
  error.
- **`syncExtensionHost(reason)`**: el conjunto viaja en el handshake y el
  handshake ocurre una vez por generación, así que un cambio de confianza o
  de habilitación se aplica reiniciando. Si tras el cambio no queda nada
  activable, el host se **detiene** en lugar de reiniciarse — revocar la
  confianza no puede dejar viva una generación con código ya cargado.
- **Arranque y parada**: `app.whenReady()` lo lanza sin bloquear (un host
  que no levanta no debe retrasar ni impedir la ventana) y sólo si hay algo
  que podría ejecutar; `window-all-closed` lo para explícitamente, que es
  lo que dará su `deactivate()` a las extensiones cargadas.
- **Canales `ext:host:state` / `ext:host:restart` / `ext:host:event`** con
  su preload tipado, más `extensionHostState` y `watchExtensionHost()` en
  el `extensionSlice`. El renderer **observa**; no manda. Los eventos de
  logs y descartes ya llegan pero no se pintan: su superficie es el 3.6.
- Se reutiliza `FORGE_VSCODE_API_VERSION` (la misma constante con la que se
  validan los `engines.vscode`) como `apiVersion` del handshake, en vez de
  declarar una segunda versión emulada que podría divergir.

## Incremento 3.2 — loader, `require('vscode')`, `ExtensionContext` y primitivas

Completado (2026-08-22). Criterio de salida del diseño §8: *«Una extensión
fixture carga y expone `activate` sin ejecutar lógica de workbench»*. **Este
incremento ejecuta código de terceros por primera vez**, y sólo eso: las
familias `commands`, `window` y `configuration` siguen respondiendo
`UNSUPPORTED_API`, ahora de forma tipada y medida en vez de por omisión.

- **Descriptores en el cable** (`domain/rpc-protocol.ts`): el handshake pasa
  de `extensions: string[]` a `ExtensionHostDescriptor[]` con
  `{ id, version, dir, main, globalStoragePath, workspaceStoragePath,
  extensionMode }`, más `storageRoot` en el payload. El host recibe **sólo**
  lo que el loader necesita: las contribuciones se quedan en main. El guard
  `isExtensionHostDescriptor` valida en el borde y un descriptor inválido se
  descarta con aviso, nunca se completa a ojo.
- **Resolución del entrypoint** (`extension-host/module-loader.ts`): `main`
  se resuelve contra el directorio instalado y la contención se comprueba
  sobre el **realpath** de ambos extremos, así que un symlink que apunta
  fuera del store se rechaza igual que un `../../..`. El escape se distingue
  de la ausencia (`outside-extension` vs `not-found`): reportar un ataque
  como «archivo no encontrado» lo escondería. El orden de candidatos imita
  al de Node (exacto, `.js`, `.cjs`, `.json`, `index.*`), de modo que nada
  resuelve aquí que `require` fuese a rechazar después.
- **`require('vscode')` por dueño**: `createOwnerIndex` atribuye cada archivo
  a su extensión por prefijo de directorio (gana el más largo, así una
  instalación anidada no la absorbe su padre) y el hook sobre `Module._load`
  devuelve la facade **de quien hace el require**, no un singleton. Código
  sin dueño recibe un throw explícito: entregarle una facade atribuiría sus
  disposables y su storage a la primera extensión que pasara por ahí. Sin
  extensiones activables el hook ni se instala.
- **Primitivas** (`vscode-api/primitives.ts`): `Disposable` (idempotente,
  con `from` que libera a todos aunque uno lance), `EventEmitter` (snapshot
  al emitir, listener que lanza reportado y no propagado), `Uri` (inmutable,
  `file`/`parse`/`joinPath`/`with`, minúsculas en la letra de unidad de
  Windows para que dos grafías comparen igual, `toJSON` que sobrevive al
  structured clone) y `CancellationTokenSource` con token desacoplado de su
  fuente.
- **Enums** (`vscode-api/enums.ts`): objetos congelados, no `enum` de
  TypeScript, porque estos módulos también se cargan por type stripping.
  Sólo están los enums cuya API existe o se lee antes de existir; los de
  debug, notebooks y tests se omiten a propósito — un valor sin su API es
  una trampa.
- **API no soportada** (`vscode-api/unsupported.ts`): cada namespace es un
  Proxy cuyos miembros son funciones que **lanzan** `UnsupportedApiError` al
  llamarse y se reportan por `diagnostics.unsupportedApi`. Se reporta en la
  llamada, no en el acceso, para que `typeof api.foo === 'function'` siga
  funcionando; `then`, `Symbol.toPrimitive` y compañía devuelven `undefined`
  para que un `await` o un `console.log` no se cuenten como uso.
- **`ExtensionContext`** (`extension-context.ts`): `subscriptions`,
  `extensionPath`/`extensionUri`, `extensionMode`, `asAbsolutePath`,
  `extension.id` y los dos mementos. El storage se persiste por extensión a
  través de un puerto `MementoStore`; el adaptador de fs escribe
  `tmp`+`rename` y las rutas las decide main con el id saneado. Sin
  workspace no hay storage de workspace (queda en memoria) y `storagePath`
  es `undefined`, no `null`, porque es sobre eso que ramifican las
  extensiones. Un storage corrupto lee vacío: perder estado se recupera, no
  poder activar no.
- **`ExtensionRuntime`** (`extension-runtime.ts`): activación una vez por
  generación con promesa compartida entre llamadas concurrentes, contexto
  construido **antes** de cargar el módulo (una extensión puede requerir
  `vscode` en tiempo de import), `activate` síncrono o asíncrono, y fallo
  aislado — la extensión queda `failed`, sus disposables se liberan y el
  resto de la generación sigue intacta. `deactivate()` corre siempre antes
  del dispose, y su excepción no impide liberar lo registrado. `shutdown`
  desactiva todo y desengancha el hook.
- **Bootstrap**: `lifecycle.activate` / `lifecycle.deactivate` reales, el
  responder pasa a poder contestar de forma asíncrona (activar ejecuta
  código ajeno) y ninguna excepción escapa al bombeo de mensajes: todo sale
  como envelope de error tipado, porque una excepción suelta parecería un
  cuelgue a main y gastaría presupuesto de heartbeat.
- **Composition root**: `activatableDescriptors()` traduce el registro a
  descriptores y deriva las rutas de storage bajo `userData/extension-storage`
  — nunca dentro del directorio de instalación, que una actualización
  reemplaza entero.

Pruebas añadidas (48 casos nuevos; la suite pasa de 168 a 216 tests):

- `tests/extensions/vscode-api.test.cjs` (21): idempotencia y agregación de
  `Disposable`, alta/baja de listeners y aislamiento de excepciones,
  cancelación, `Uri` (posix, unidad de Windows, `parse`, `joinPath`,
  serialización), API no soportada (detección de características sin
  reportar, throw tipado al llamar, miembros implementados que la sombrean),
  facade (primitivas, enums congelados, `env`, typo que sigue `undefined`) y
  `ExtensionContext` (rutas, ausencia de workspace, mementos, storage
  corrupto, dispose LIFO tolerante a fallos, saneo de la clave de storage).
- `tests/extensions/extension-runtime.test.cjs` (23): resolución del
  entrypoint (dentro, absoluto, symlink que escapa, inexistente, sin `main`,
  sin extensión), índice de dueños, hook que sólo intercepta `vscode` y se
  desinstala limpio, y el ciclo completo contra fixtures reales — activación
  sana con su facade, activación concurrente que ejecuta `activate` una vez,
  extensión que lanza y libera lo registrado sin arrastrar a las demás,
  extensión fallida que no reintenta, API no soportada reportada, `main` sin
  `activate`, entrypoint que escapa, id fuera de la generación, `deactivate`
  idempotente y adaptador de storage.
- `tests/extensions/extension-host.test.cjs` (+4): el protocolo de punta a
  punta con extensiones reales — handshake con descriptores (uno inválido
  descartado), `activate`/`deactivate` por envelope, error tipado sin stack
  con su `diagnostics.log`, `diagnostics.unsupportedApi` con `id: 0`,
  peticiones antes del handshake o con payload malformado, y `shutdown` que
  desactiva antes de contestar.
- `tests/fixtures/extensions/host/`: cinco extensiones fixture (`healthy`,
  `throwing`, `unsupported`, `silent`, `escaping`), en el repo y sin red.

### Decisiones del incremento 3.2

- **El descriptor viaja por el cable, no el registro entero.** El host no
  necesita saber qué temas o menús aporta una extensión para cargarla, y
  cuanto menos cruce el proceso, menos superficie tiene lo que corre código
  ajeno.
- **La contención se comprueba sobre el realpath, no sobre la cadena.**
  `path.resolve` no sigue symlinks; `require` sí. Comparar sólo las cadenas
  habría dejado abierto exactamente el agujero que el 3.0 cerró en la
  instalación.
- **Una facade por extensión, memoizada.** Dos `require('vscode')` desde la
  misma extensión deben devolver el mismo objeto: la identidad detrás de los
  disposables y del storage no puede cambiar a mitad de una activación.
- **La API no soportada lanza en la llamada, no en el acceso.** Reportar en
  el acceso convertiría cualquier feature detection en un falso positivo del
  reporte de compatibilidad, que es justo lo que este mecanismo existe para
  medir bien.
- **El contexto se construye antes de cargar el módulo.** Muchas extensiones
  requieren `vscode` en tiempo de import; si la facade no existiera todavía,
  el hook tendría que inventar un dueño o fallar.
- **Un fallo de activación libera lo ya registrado.** Una extensión a medio
  activar con disposables vivos es peor que una fallida: nadie los va a
  liberar después, porque nadie la considera activa.
- **El responder puede contestar asíncronamente, pero nunca lanzar.** El
  bombeo de mensajes es el único punto donde una excepción se traduciría en
  silencio, y el silencio es indistinguible de un host colgado.
- **Sin extensiones activables no se toca `Module._load`.** Parchear el
  sistema de módulos cuando no hay nada que cargar sólo añade una capa que
  puede fallar; el host arranca igual de vacío.

## Incremento 3.3 — comandos de punta a punta y activación `onCommand`

Completado (2026-08-22). Criterio de salida del diseño §8: *«Un comando de
extensión ejecuta desde la paleta, el menú del editor y un keybinding»*. Las
tres superficies ya despachaban por el `ExtensionCommandService`, así que el
cambio visible en el renderer es el que anticipaba el diseño §5 y **ninguno
más**: un comando sin handler local ahora cae al host en vez de reportar un
no-op.

- **`HostCommandRegistry`** (`extension-host/host-commands.ts`): el handler
  nunca sale del proceso; lo que viaja es el *hecho* de que un id existe y
  quién lo posee. Ids duplicados **lanzan**, como en VS Code — reemplazar en
  silencio el comando de otro dejaría que cualquier extensión secuestrara el
  workbench declarando un id conocido. La propiedad se lleva por extensión,
  así que `deactivate()` retira todo lo que registró aunque no lo dispusiera.
- **`vscode.commands`** en la facade: `registerCommand`, `executeCommand` y
  `getCommands`, ligados a la extensión que hace el `require`, de modo que un
  registro es atribuible sin que el llamante tenga que decir quién es. Los
  comandos propios del workbench todavía no son invocables desde una
  extensión: `executeCommand` responde `COMMAND_NOT_FOUND` y lo reporta,
  en vez de resolver `undefined` y dejar que la extensión actúe sobre algo
  que nunca corrió.
- **`commands.register` / `unregister` son notificaciones, no requests.** El
  host ya decidió (el duplicado revienta localmente) y main veta no cargando
  la extensión, nunca comando a comando. Además un request anidado dentro de
  `activate` competiría con su propio timeout.
- **`ExtensionCommandDispatcher`**
  (`application/extension-command-dispatcher.ts`): índice id → dueño de la
  generación viva y activación bajo demanda. Un comando sin handler busca a
  quien declare `onCommand:<id>`, lo activa y **reintenta una vez**; más
  reintentos convertirían un activation event mal declarado en un bucle. Si
  la extensión se activa y aun así no registra el comando, se dice
  exactamente eso. El índice se vacía al cambiar de generación o al parar el
  host: un registro es un hecho sobre un proceso que ya no existe.
- **`COMMAND_NOT_FOUND`** entra en el vocabulario de errores. `UNSUPPORTED_API`
  significa «Forge no implementa esa API»; esto otro significa «el id no
  existe ahora mismo en ningún sitio», y confundirlos haría imposible
  distinguir una API pendiente de un comando mal escrito.
- **Renderer**: `ExtensionCommandService` recibe `hasRemote` (síncrono) y
  `executeRemote`. La sincronía no es un capricho: un keybinding tiene que
  decidir si consume la pulsación antes de que un round-trip pudiera
  contestar. `hasHandler` cuenta también los comandos que **se activarían**
  (`onCommand:` declarado en un manifiesto instalado), porque main sabe
  despertarlos; tratarlos como ausentes haría fallar el primer disparo de
  cada comando. Un handler local gana siempre al del host: una extensión no
  puede sombrear un comando del workbench declarando su id.
- **Semántica de `execute()`**: devuelve si el comando fue **despachado**, no
  si tuvo éxito. Un comando que lanza consume igual la pulsación, que es lo
  que hace VS Code; el fallo se reporta. Se añade `executeAndWait` para quien
  sí necesita el resultado.
- **IPC**: `ext:host:commands` (invoke + push al cambiar) y
  `ext:command:execute`, que devuelve `{ ok, result }` o
  `{ ok: false, error: { code, message } }` — el error viaja como dato con su
  código para que la UI distinga «nadie lo registra» de «la extensión
  reventó» sin leer mensajes.

Pruebas añadidas (24 casos nuevos; la suite pasa de 216 a 240 tests):

- `tests/extensions/command-dispatcher.test.cjs` (14): construcción del
  índice, unregister sólo del dueño, tráfico de generación desfasada,
  notificación malformada descartada, otras notificaciones ignoradas,
  generación nueva y host parado que vacían el registro, ejecución con args y
  dueño, activación bajo demanda con reintento único, nadie que declare el
  comando (sin despertar a nadie), extensión que activa sin registrar,
  activación que falla, host parado que se arranca antes del comando e id
  vacío.
- `tests/extensions/extension-runtime.test.cjs` (+7): registro anunciado al
  bridge, ejecución con argumentos, comando que lanza sin desregistrarse,
  `COMMAND_NOT_FOUND`, `deactivate` que retira incluso lo que la extensión
  olvidó, activación fallida que se lleva sus comandos a medias, id duplicado
  rechazado y `executeCommand`/`getCommands` desde la propia facade.
- `tests/extensions/extension-host.test.cjs` (+1): el camino completo sin
  nada simulado en medio — la fixture registra dentro del host, la
  notificación cruza el broker, el dispatcher la indexa y ejecuta el comando;
  el que lanza vuelve como error tipado sin tumbar el host, y parar el host
  vacía el registro.
- `tests/extensions/commands-keybindings.test.cjs` (+2): despacho al host,
  handler local que lo sombrea y fallo remoto reportado sin lanzar.
- `tests/fixtures/extensions/host/commanding/`: fixture que registra dos
  comandos por `subscriptions` y un tercero sin disponer.

### Decisiones del incremento 3.3

- **El handler se queda en el host.** Sólo cruzan ids. Cualquier diseño en el
  que main sostenga la función acaba serializando closures o pasando por
  `eval`.
- **Registro por notificación, ejecución por request.** El registro es un
  hecho consumado; la ejecución necesita respuesta, timeout y dueño.
- **El resultado de un comando se filtra por serializabilidad.** Un comando
  puede devolver un `Disposable` o un objeto vivo; se prueba el clonado y lo
  que no pasa se descarta con aviso, en vez de que `postMessage` reviente
  después de que el responder ya prometió una respuesta.
- **`hasHandler` incluye lo activable.** Es la única forma de que el primer
  disparo de un comando funcione sin haber activado antes la extensión, y es
  lo que hace VS Code.
- **Un comando que lanza consume su disparador.** Lo contrario dejaría pasar
  la pulsación a otro binding después de que la extensión ya hizo trabajo.

## Incremento 3.4 — activation service, mensajes, configuración y métricas

Completado (2026-08-22). Criterio de salida del diseño §8 —y del Milestone 3
entero—: *«Hello World sin modificar: instala, activa por comando, muestra
mensaje, desactiva limpio»*. La fixture `helloworld` es el ejemplo oficial de
VS Code copiado tal cual, sin adaptar a Forge, y el test recorre el camino
completo.

- **Vocabulario de eventos** (`domain/activation-events.ts`): parser y
  matcher puros para `*`, `onStartupFinished`, `onCommand:`, `onLanguage:` y
  `workspaceContains:`. Lo que Forge no sabe disparar se reconoce como
  `unknown` en lugar de ignorarse, que es lo que permite decir qué necesita
  una extensión en vez de que falle sin explicación. `*` activa **sólo** en
  arranque: plegarlo en todos los triggers la reactivaría con cada lenguaje.
- **Glob propio para `workspaceContains`**: `*`, `**`, `?` y `{a,b}`
  traducidos a RegExp con los puntos escapados. El patrón viene de un
  manifiesto, así que no puede hacer nada más que emparejar; `**/` acepta
  cero segmentos, que es lo que hace que `**/package.json` encuentre el del
  raíz.
- **`ExtensionActivationService`** (application): índice evento → extensiones
  cacheado e invalidado por generación o al cambiar el conjunto — disparar un
  trigger no puede recorrer todos los manifiestos instalados
  (arquitectura §9). Una activación por extensión y generación, promesa
  compartida entre llamadas concurrentes, y el resultado **recordado**: una
  extensión que falló no se reintenta con cada pulsación que toque su
  lenguaje. Un trigger nunca rechaza (el usuario abrió un archivo, no pidió
  activar nada); sólo el camino explícito de un comando propaga el error.
- **Métricas y fallos**: `durationMs` lo mide el host —el round-trip es coste
  de Forge, no de la extensión, y cargárselo haría los números inútiles para
  decidir qué deshabilitar—, con el `reason` que la despertó. `metrics()` y
  `failures()` se publican por `ext:host:activation`, que es lo que cierra
  «logs y reporte de activation failure» del gate de seguridad.
- **Cliente RPC en el host**: el bootstrap pasa de sólo responder a también
  **preguntar**, con correlación por id propio y timeout de 60 s. Los ids de
  cada lado pueden coincidir sin ambigüedad porque sólo se emparejan
  respuestas y sólo se despachan requests.
- **`window.show{Information,Warning,Error}Message`**: host→main→renderer y
  vuelta. Main sostiene la promesa mientras el usuario decide, y el
  componente `ExtensionNotifications` responde **por todas las salidas** —
  botón, descarte o desmontaje—, porque un mensaje que no resuelve deja a la
  extensión colgada de su propia promesa. `modal: true` se respeta como
  énfasis visual: una extensión no congela el workbench.
- **`workspace.getConfiguration`** servido desde un **snapshot**, no por
  round-trip. En VS Code `get()` es síncrono y las extensiones lo llaman
  dentro de `activate` y de sus handlers; devolver una promesa las rompería.
  Main resuelve la precedencia (default < override < user < workspace), envía
  los valores efectivos en el handshake y empuja `configuration.update` al
  cambiar — reiniciar el host por un ajuste desactivaría extensiones que
  quizá ni lo leen. Escribir configuración desde una extensión sigue sin
  soportarse, y lo dice.
- **Disparadores cableados**: `onStartupFinished` y `workspaceContains` tras
  crear la ventana (que es lo que significa «startup finished»: no «lo antes
  posible» sino «cuando el usuario tiene dónde ver el resultado»), y
  `onLanguage` desde el renderer al abrir un archivo **y al cambiar de
  pestaña** — una extensión instalada después no debería quedarse dormida
  para un archivo que ya estaba abierto.
- **Scanner acotado** (`infrastructure/workspace-scanner.ts`): BFS con
  presupuesto de entradas y profundidad, saltando `node_modules`, `.git` y
  compañía, sin seguir symlinks de directorio, y que corta en cuanto todos
  los patrones han encontrado algo. Esto corre al abrir carpeta: un recorrido
  sin límites convertiría abrir un monorepo en varios segundos de I/O.

Pruebas añadidas (25 casos nuevos; la suite pasa de 240 a 265 tests):

- `tests/extensions/activation.test.cjs` (16): parsing de los cinco eventos y
  de lo desconocido, matching por tipo (con `*` que no reactiva por
  lenguaje), el subconjunto de glob, trigger de arranque y de lenguaje,
  trigger que no rechaza y registra el fallo, extensión fallida que no se
  reintenta, activaciones concurrentes que comparten petición, host parado
  que se arranca, generación nueva que olvida, `workspaceContains` que sólo
  activa lo que coincidió, eventos desconocidos reportados, invalidación del
  índice y el scanner (raíz, anidado, `node_modules`, profundidad, workspace
  ausente).
- `tests/extensions/extension-runtime.test.cjs` (+4): `showInformationMessage`
  con la carga exacta que cruza, configuración leída síncronamente del
  snapshot (con sección y sin ella), escritura rechazada y reportada, y
  ausencia de canal que falla tipado en lugar de colgarse.
- `tests/extensions/extension-host.test.cjs` (+5): request saliente del host
  con su generación, respuesta que reanuda la activación, error que la
  rechaza, `configuration.update` que reemplaza el snapshot, payload
  malformado que lee vacío, y **Hello World completo**: activa por comando
  desde el dispatcher, muestra su mensaje, y al parar el host su comando se
  retira y su estado vuelve a `idle`.
- `tests/fixtures/extensions/host/`: `messaging` (mensajes + configuración) y
  `helloworld` (el ejemplo oficial sin tocar).

### Decisiones del incremento 3.4

- **La configuración va por snapshot, no por request.** Es una desviación
  deliberada del diseño §3.3, que la listaba como `configuration.get`
  host→main: implementarla así habría hecho asíncrona una API que en VS Code
  es síncrona, y ninguna extensión real sobrevive a eso.
- **Un trigger no rechaza; un comando sí.** Abrir un archivo no es pedir una
  activación. Si `onLanguage` propagara el fallo, una extensión rota se
  manifestaría como un archivo que no abre.
- **El fallo se recuerda por generación.** Reintentar en cada trigger
  convertiría una extensión rota en un bucle de activaciones fallidas a
  cada pulsación.
- **El índice se cachea y se invalida explícitamente.** Es la ruta caliente
  (cada cambio de pestaña); reconstruirlo por trigger es justo lo que la
  arquitectura §9 prohíbe.
- **Las notificaciones no son modales.** Una extensión no debe poder
  bloquear el editor, ni siquiera pidiéndolo con `modal: true`.
- **El scan tiene presupuesto.** `workspaceContains` es una comodidad; que
  cueste segundos al abrir una carpeta grande no lo sería.

## Incremento 3.5 — Safe Mode y aislamiento demostrado

Completado (2026-08-22). Criterio de salida del diseño §8: *«Extensión que
revienta y extensión colgada, ambas diagnosticadas sin derribar Forge»*.

- **Safe Mode** (`domain/safe-mode.ts` + `application/safe-mode-service.ts`):
  existe para una sola situación —el usuario no puede volver a un editor
  usable por culpa de una extensión— y sus reglas son de rescate, no de
  comodidad. `--disable-extensions` (el mismo flag de VS Code, comparado
  exacto: `--disable-extensions-foo` es otra cosa) manda pero **no
  persiste**: escribirlo a disco convertiría un rescate puntual en un estado
  permanente que nadie pidió. La decisión del usuario sí persiste, porque su
  razón de ser es sobrevivir al reinicio que le saca del bucle. Salir con el
  flag puesto **falla en voz alta** en vez de fingir que funcionó.
- **Se comprueba en el origen**: `activatableExtensions()` devuelve vacío en
  modo seguro, así que ningún descriptor puede llegar a una generación y
  nada aguas abajo necesita acordarse. Entrar no depende de que el host esté
  sano: es la salida del crash loop.
- **Persistencia bajo su propia clave** (`extensionSafeMode`), separada del
  registry de extensiones: el interruptor de rescate no puede caer con
  aquello de lo que rescata. Decodifica sólo un `true` explícito, y salir
  borra la clave en vez de escribir `false` — la ausencia es el estado
  natural y un registro caducado es una explicación caducada.
- **Fixtures maliciosas de runtime** (requisito del gate §9): `hanging`
  (nunca devuelve el control), `crasher` (`process.exit` durante la
  activación), `log-storm` (miles de líneas seguidas) y `hijacker` (registra
  un id de comando ajeno). Están documentadas en el README de las fixtures
  con lo que **no** prueban: dentro de su proceso una extensión tiene Node
  completo, igual que en VS Code; lo que se demuestra es que el daño no sale
  de ahí.
- **Aislamiento demostrado** con cinco pruebas: la colgada agota su
  presupuesto de 10 s, se responde `TIMEOUT` **nombrando a la culpable** y el
  host sigue sirviendo a su vecina; la que mata el proceso pierde su
  generación y vuelve otra con backoff, sin tocar a Forge; matar el host a
  mitad de request rechaza lo pendiente con `HOST_UNAVAILABLE` en vez de
  colgarlo; la tormenta de logs se recorta por extensión sin silenciar a las
  demás y **diciendo** que se recortó; y el secuestro de un id de comando se
  rechaza, con el dueño original conservando su comando en funcionamiento.
- **Aislamiento real de la caché de `require` en el harness**: los procesos
  falsos viven en el mismo Node que el runner, así que un módulo cacheado
  conservaba la facade `vscode` de una generación anterior y registraba sus
  comandos allí. En producción cada generación es un proceso y el problema
  no existe; en pruebas lo era, y se veía como un falso duplicado de comando.

Pruebas añadidas (14 casos; la suite pasa de 265 a 279 tests):
`tests/extensions/safe-mode.test.cjs` (9: flag exacto, precedencia del
comando sobre lo persistido, entrada persistida y notificada, salida que
limpia la clave, salida rechazada con el flag puesto, config ilegible que lee
«apagado», suscriptor que lanza sin romper el rescate, round-trip del store
con basura, e independencia del registry) y `extension-host.test.cjs` (+5, el
aislamiento descrito arriba).

### Decisiones del incremento 3.5

- **El flag no persiste; la decisión del usuario sí.** Son dos intenciones
  distintas: una es «sácame de aquí ahora», la otra «quiero arrancar así».
- **Salir falla si el flag manda.** Decir «hecho» cuando la siguiente lectura
  seguirá diciendo «activo» es peor que negarse.
- **Modo seguro por delante de la confianza.** Las dos deciden qué puede
  ejecutarse antes de que se ejecute nada, y la más restrictiva gana.
- **Las fixtures hostiles prueban contención, no imposibilidad.** Prometer
  que una extensión no puede tocar el disco sería falso mientras el host sea
  Node completo; lo que sí se sostiene es que no se lleva por delante ni a
  Forge ni a sus compañeras.

Sigue pendiente la **prueba de integración con un `utilityProcess` real**,
anotada desde el 3.1: requiere `app.whenReady()` y en este entorno Electron
aborta sin display (`--ozone-platform=headless` vuelca core y no hay `Xvfb`),
así que ejecutarla obligaría a abrir una ventana. El sustituto sigue siendo
la mitad en proceso de la batería de contrato, que ahora ejecuta extensiones
fixture reales de punta a punta.

## Próximo incremento

3.6 — superficie de usuario: estado del host, tiempos de activación y fallos
en la vista de detalle. Todo lo que necesita ya se publica
(`ext:host:state`, `ext:host:activation`, `ext:host:commands`,
`ext:safe-mode:*`).
