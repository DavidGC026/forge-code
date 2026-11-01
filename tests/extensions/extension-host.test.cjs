const assert = require('node:assert/strict');
const test = require('node:test');

const {
  UtilityProcessExtensionHost,
} = require('../../dist-electron/extensions/infrastructure/hosts/utility-process-host.js');
const {
  createBootstrapResponder,
} = require('../../dist-electron/extension-host/bootstrap.js');

const { flush, createFakeTimers, createFakeLauncher } = require('./helpers/rpc-harness.cjs');

/** A descriptor with no `main`: the kernel tests care about the protocol,
 *  not about loading code — that is `extension-runtime.test.cjs`. */
const DEMO_DESCRIPTOR = {
  id: 'acme.demo',
  version: '1.0.0',
  dir: '/store/acme.demo/1.0.0',
  main: null,
  globalStoragePath: '/storage/global/acme.demo',
  workspaceStoragePath: null,
  extensionMode: 'test',
};

function createHost({ launcher: launcherOptions, ...hostOptions } = {}) {
  const timers = createFakeTimers();
  const launcher = createFakeLauncher(timers, launcherOptions);
  const events = [];
  const warnings = [];
  const host = new UtilityProcessExtensionHost({
    launcher,
    timers,
    initialize: () => ({
      apiVersion: '1.90.0',
      extensions: [DEMO_DESCRIPTOR],
      workspace: '/w',
      trust: true,
    }),
    warn: (message) => warnings.push(message),
    ...hostOptions,
  });
  host.onEvent((event) => events.push(event));
  return { host, timers, launcher, events, warnings };
}

const statuses = (events) =>
  events.filter((event) => event.type === 'state').map((event) => event.state.status);

const methodsSent = (child) => child.sent.map((envelope) => envelope.method);

// ── Handshake (design §3.2) ─────────────────────────────────────────────

test('start forks a generation, completes the handshake and reports running', async () => {
  const h = createHost();
  const state = await h.host.start();

  assert.deepEqual(state, {
    status: 'running',
    generation: 1,
    restartsInWindow: 0,
    lastError: null,
  });
  assert.equal(h.launcher.generations.length, 1);

  const [handshake] = h.launcher.latest().sent;
  assert.equal(handshake.method, 'lifecycle.initialize');
  assert.equal(handshake.gen, 1, 'the envelope carries the generation it belongs to');
  assert.deepEqual(handshake.payload, {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [DEMO_DESCRIPTOR],
    workspace: '/w',
    trust: true,
  });
  assert.deepEqual(statuses(h.events), ['starting', 'running']);
});

test('a protocol mismatch aborts the start instead of degrading silently', async () => {
  const h = createHost({
    launcher: {
      respond: (envelope) => (envelope.method === 'lifecycle.initialize'
        ? { v: 1, gen: envelope.gen, id: envelope.id, kind: 'response', method: envelope.method, payload: { protocol: 2, nodeVersion: '20.0.0', ready: true } }
        : undefined),
    },
  });

  await assert.rejects(h.host.start(), (err) => {
    assert.equal(err.code, 'HOST_UNAVAILABLE');
    assert.match(err.message, /Protocolo incompatible/);
    return true;
  });
  assert.equal(h.host.state.status, 'stopped');
  assert.equal(h.host.state.lastError.code, 'HOST_UNAVAILABLE');
  assert.equal(h.launcher.latest().killed, true, 'the incompatible process is not left running');
  assert.equal(h.timers.pendingTimers(), 0, 'a deterministic failure schedules no restart');
});

test('a host that never answers the handshake times out and stays stopped', async () => {
  const h = createHost({ launcher: { respond: () => null }, handshakeTimeoutMs: 500 });
  const start = h.host.start();
  const rejected = assert.rejects(start, (err) => err.code === 'TIMEOUT');

  await h.timers.advance(500);
  await rejected;
  assert.equal(h.host.state.status, 'stopped');
});

test('requests are refused unless the host is running', async () => {
  const h = createHost();
  await assert.rejects(
    h.host.request('commands.execute', {}),
    (err) => err.code === 'HOST_UNAVAILABLE',
  );

  await h.host.start();
  assert.deepEqual(await h.host.request('lifecycle.heartbeat', {}), {
    ok: true,
    uptimeMs: 0,
  });

  await h.host.stop();
  await assert.rejects(
    h.host.request('commands.execute', {}),
    (err) => err.code === 'HOST_UNAVAILABLE',
  );
});

test('an unimplemented method answers UNSUPPORTED_API, not a silent stub', async () => {
  const h = createHost();
  await h.host.start();

  await assert.rejects(h.host.request('workspace.findFiles', {}), (err) => {
    assert.equal(err.code, 'UNSUPPORTED_API');
    assert.match(err.message, /workspace\.findFiles/);
    return true;
  });
  assert.equal(h.host.state.status, 'running', 'an unsupported call does not hurt the host');
});

// ── Heartbeat policy (design §6) ────────────────────────────────────────

test('the host beats every two seconds while it answers', async () => {
  const h = createHost();
  await h.host.start();

  await h.timers.advance(2_000);
  assert.deepEqual(methodsSent(h.launcher.latest()), ['lifecycle.initialize', 'lifecycle.heartbeat']);

  await h.timers.advance(2_000);
  assert.equal(
    methodsSent(h.launcher.latest()).filter((method) => method === 'lifecycle.heartbeat').length,
    2,
  );
  assert.equal(h.host.state.status, 'running');
  assert.equal(h.launcher.generations.length, 1, 'a healthy host is never respawned');
});

test('two missed beats are tolerated; the third kills and respawns the host', async () => {
  const h = createHost();
  await h.host.start();
  h.launcher.latest().hung = true;

  // Each beat waits its 2 s budget before counting as a failure.
  await h.timers.advance(8_000);
  assert.equal(h.host.state.status, 'running', 'two failures do not justify a kill');
  assert.equal(h.launcher.generations.length, 1);

  await h.timers.advance(4_000);
  assert.equal(h.launcher.generations[0].killed, true, 'the hung process is killed');
  assert.equal(h.host.state.status, 'restarting');

  await h.timers.advance(500);
  assert.equal(h.host.state.status, 'running');
  assert.equal(h.host.state.generation, 2, 'the restart opens a new generation');
  assert.equal(h.launcher.generations.length, 2);
});

test('an answered beat resets the failure counter', async () => {
  const h = createHost();
  await h.host.start();
  const child = h.launcher.latest();

  child.hung = true;
  await h.timers.advance(8_000); // two failures
  child.hung = false;
  await h.timers.advance(2_000); // one success
  child.hung = true;
  await h.timers.advance(8_000); // two more failures

  assert.equal(h.host.state.status, 'running', 'failures must be consecutive to kill');
  assert.equal(h.launcher.generations.length, 1);
});

// ── Restart and backoff ─────────────────────────────────────────────────

test('an unexpected exit restarts the host with growing backoff', async () => {
  const h = createHost();
  await h.host.start();

  h.launcher.latest().exit(1);
  await flush();
  assert.equal(h.host.state.status, 'restarting');
  assert.equal(h.host.state.restartsInWindow, 1);
  assert.match(h.host.state.lastError.message, /terminó \(código 1\)/);

  await h.timers.advance(499);
  assert.equal(h.launcher.generations.length, 1, 'the backoff is respected');
  await h.timers.advance(1);
  assert.equal(h.host.state.status, 'running');
  assert.equal(h.host.state.generation, 2);

  h.launcher.latest().exit(1);
  await flush();
  await h.timers.advance(999);
  assert.equal(h.launcher.generations.length, 2, 'the second wait doubles');
  await h.timers.advance(1);
  assert.equal(h.host.state.generation, 3);
  assert.equal(h.host.state.restartsInWindow, 2);
});

test('the restarted generation is the only one that receives traffic', async () => {
  const h = createHost();
  await h.host.start();
  const dead = h.launcher.latest();
  dead.exit(1);
  await h.timers.advance(500);

  await h.host.request('commands.execute', { command: 'demo' }).catch(() => {});
  assert.equal(methodsSent(dead).includes('commands.execute'), false);
  assert.equal(methodsSent(h.launcher.latest()).includes('commands.execute'), true);
  assert.equal(h.launcher.latest().sent[0].gen, 2, 'envelopes carry the new generation');
});

// ── Crash-loop circuit breaker ──────────────────────────────────────────

test('a crash loop trips the breaker and leaves the host observably disabled', async () => {
  const h = createHost();
  await h.host.start();

  // Three restarts inside the window are allowed; the next crash disables.
  for (let i = 0; i < 3; i += 1) {
    h.launcher.latest().exit(1);
    await flush();
    await h.timers.advance(8_000);
  }
  assert.equal(h.host.state.status, 'running');
  assert.equal(h.host.state.restartsInWindow, 3);
  assert.equal(h.launcher.generations.length, 4);

  h.launcher.latest().exit(1);
  await flush();
  assert.equal(h.host.state.status, 'disabled');
  assert.match(h.host.state.lastError.message, /3 reinicios en 60 s/);

  await h.timers.advance(60_000);
  assert.equal(h.launcher.generations.length, 4, 'a disabled host never respawns on its own');
  await assert.rejects(h.host.start(), (err) => {
    assert.equal(err.code, 'HOST_UNAVAILABLE');
    assert.match(err.message, /deshabilitado/);
    return true;
  });
});

test('crashes spaced beyond the window do not accumulate', async () => {
  const h = createHost();
  await h.host.start();

  for (let i = 0; i < 5; i += 1) {
    h.launcher.latest().exit(1);
    await flush();
    await h.timers.advance(500);
    assert.equal(h.host.state.status, 'running', `crash ${i + 1} restarted`);
    await h.timers.advance(60_001);
  }
  assert.equal(h.host.state.restartsInWindow, 1, 'the window slides with the clock');
  assert.equal(h.launcher.generations.length, 6);
});

test('an explicit restart clears the breaker and opens a new generation', async () => {
  const h = createHost();
  await h.host.start();
  for (let i = 0; i < 4; i += 1) {
    h.launcher.latest().exit(1);
    await flush();
    await h.timers.advance(8_000);
  }
  assert.equal(h.host.state.status, 'disabled');

  const state = await h.host.restart('el usuario pidió reiniciar');
  assert.equal(state.status, 'running');
  assert.equal(state.restartsInWindow, 0, 'explicit intent is not another symptom of the loop');
  assert.equal(state.generation, 5);
});

// ── Stop ────────────────────────────────────────────────────────────────

test('stop asks for shutdown, kills the process and schedules nothing', async () => {
  const h = createHost();
  await h.host.start();
  const child = h.launcher.latest();

  await h.host.stop('cerrando Forge');
  assert.equal(methodsSent(child).includes('lifecycle.shutdown'), true);
  assert.equal(child.alive, false);
  assert.equal(h.host.state.status, 'stopped');
  assert.equal(h.timers.pendingTimers(), 0, 'no heartbeat or restart timer survives');

  await h.timers.advance(60_000);
  assert.equal(h.launcher.generations.length, 1);
});

test('a host that ignores shutdown is stopped anyway', async () => {
  const h = createHost();
  await h.host.start();
  h.launcher.latest().hung = true;

  const stopped = h.host.stop();
  await h.timers.advance(3_000); // the lifecycle.shutdown budget expires
  await stopped;

  assert.equal(h.host.state.status, 'stopped');
  assert.equal(h.launcher.latest().killed, true);
  assert.equal(h.warnings.some((message) => message.includes('shutdown no confirmado')), true);
});

// ── Observability ───────────────────────────────────────────────────────

test('host logs reach the subscriber batched and tagged with their generation', async () => {
  const h = createHost();
  await h.host.start();

  h.launcher.latest().deliver({
    v: 1,
    gen: 1,
    id: 0,
    kind: 'event',
    method: 'diagnostics.log',
    extensionId: 'acme.demo',
    payload: { level: 'warn', message: 'algo pasó' },
  });
  await h.timers.advance(100);

  const [logs] = h.events.filter((event) => event.type === 'logs');
  assert.equal(logs.generation, 1);
  assert.deepEqual(logs.entries.map((entry) => [entry.extensionId, entry.level, entry.message]), [
    ['acme.demo', 'warn', 'algo pasó'],
  ]);
});

test('a stale generation cannot report anything to the live one', async () => {
  const h = createHost();
  await h.host.start();
  const dead = h.launcher.latest();
  dead.exit(1);
  await h.timers.advance(500);

  // The dead generation's transport is gone, so its traffic reaches nobody.
  dead.deliver({ v: 1, gen: 1, id: 0, kind: 'event', method: 'window.showMessage', payload: {} });
  await flush();
  assert.deepEqual(h.events.filter((event) => event.type === 'notification'), []);
});

test('a subscriber that throws does not break the state machine', async () => {
  const h = createHost();
  h.host.onEvent(() => {
    throw new Error('suscriptor roto');
  });

  await h.host.start();
  assert.equal(h.host.state.status, 'running');
  assert.equal(h.warnings.some((message) => message.includes('suscriptor del host falló')), true);
});

// ── Bootstrap responder (in-process contract) ───────────────────────────

test('the bootstrap responder answers lifecycle and refuses the rest', async () => {
  const exits = [];
  let clock = 0;
  const respond = createBootstrapResponder({
    now: () => clock,
    nodeVersion: '20.11.0',
    exit: (code) => exits.push(code),
    warn: () => {},
  });
  const request = (method, payload, id = 1) =>
    respond({ v: 1, gen: 4, id, kind: 'request', method, payload });

  const early = await request('lifecycle.heartbeat', {});
  assert.equal(early.kind, 'error');
  assert.equal(early.payload.code, 'HOST_UNAVAILABLE', 'no beats before the handshake');

  const handshake = await request('lifecycle.initialize', { protocol: 1 });
  assert.deepEqual(handshake.payload, {
    protocol: 1,
    nodeVersion: '20.11.0',
    ready: true,
    loadable: [],
  });
  assert.equal(handshake.gen, 4, 'the generation is echoed, never invented');
  assert.equal(handshake.id, 1, 'the response repeats the request id');

  clock = 250;
  assert.deepEqual((await request('lifecycle.heartbeat', {}, 2)).payload, {
    ok: true,
    uptimeMs: 250,
  });

  const unsupported = await request('workspace.findFiles', {}, 3);
  assert.equal(unsupported.payload.code, 'UNSUPPORTED_API');

  const mismatch = await request('lifecycle.initialize', { protocol: 2 }, 4);
  assert.equal(mismatch.payload.code, 'HOST_UNAVAILABLE');

  assert.equal(await respond({ nonsense: true }), null, 'garbage is ignored, not answered');
  assert.equal(
    await respond({ v: 1, gen: 4, id: 0, kind: 'event', method: 'lifecycle.heartbeat', payload: {} }),
    null,
    'notifications get no answer',
  );

  const shutdown = await request('lifecycle.shutdown', {}, 5);
  assert.deepEqual(shutdown.payload, { ok: true });
  assert.deepEqual(exits, [0], 'the process exits after answering, not before');
});

// ── Bootstrap with real extensions (increment 3.2) ──────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ExtensionRuntime,
} = require('../../dist-electron/extension-host/extension-runtime.js');

const HOST_FIXTURES = path.join(__dirname, '..', 'fixtures', 'extensions', 'host');

function hostDescriptor(name) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(HOST_FIXTURES, name, 'package.json'), 'utf8'),
  );
  return {
    id: `forge-tests.${name}`,
    version: '1.0.0',
    dir: path.join(HOST_FIXTURES, name),
    main: manifest.main ?? null,
    globalStoragePath: path.join(os.tmpdir(), 'forge-host-protocol', name),
    workspaceStoragePath: null,
    extensionMode: 'test',
  };
}

/** Responder wired to a runtime that loads the fixtures for real, with a
 *  fresh `require` cache so protocol tests do not see runtime tests' state. */
function createLoadingResponder() {
  const notifications = [];
  const warnings = [];
  let clock = 0;
  const respond = createBootstrapResponder({
    now: () => (clock += 1),
    nodeVersion: '20.11.0',
    exit: () => {},
    warn: (message) => warnings.push(message),
    notify: (envelope) => notifications.push(envelope),
    createRuntime: (input) => new ExtensionRuntime({
      apiVersion: input.apiVersion,
      workspacePath: input.workspacePath,
      moduleSystem: require('node:module'),
      loadModule: (entryPoint) => {
        delete require.cache[require.resolve(entryPoint)];
        return require(entryPoint);
      },
      entryPointDeps: {
        realpath: (target) => {
          try {
            return fs.realpathSync(target);
          } catch {
            return path.resolve(target);
          }
        },
        isFile: (target) => {
          try {
            return fs.statSync(target).isFile();
          } catch {
            return false;
          }
        },
      },
      mementoStore: { read: () => ({}), write: () => undefined },
      joinPath: (...segments) => path.join(...segments),
      now: input.now,
      log: input.log,
      reportUnsupportedApi: input.reportUnsupportedApi,
      commandBridge: input.commandBridge,
      request: input.request,
      configuration: input.configuration,
      documents: input.documents,
      editors: input.editors,
    }),
  });

  let nextId = 1;
  return {
    notifications,
    warnings,
    request: (method, payload) => respond({
      v: 1,
      gen: 7,
      id: nextId++,
      kind: 'request',
      method,
      payload,
    }),
    /** Feeds a raw envelope in — used to answer the host's own requests. */
    send: (envelope) => respond(envelope),
    /** Last request the host sent to main, if any. */
    lastOutbound: () => [...notifications].reverse().find((envelope) => envelope.kind === 'request'),
  };
}

test('the handshake carries descriptors and activate loads real extension code', async () => {
  const host = createLoadingResponder();

  const handshake = await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('healthy'), 'acme.legacy-string'],
    workspace: '/w',
  });

  assert.deepEqual(
    handshake.payload.loadable,
    ['forge-tests.healthy'],
    'an invalid descriptor is dropped at the edge, never guessed at',
  );
  assert.equal(
    host.warnings.some((message) => message.includes('descriptor de extensión inválido')),
    true,
  );

  const activated = await host.request('lifecycle.activate', { id: 'forge-tests.healthy' });
  assert.equal(activated.kind, 'response');
  assert.equal(activated.payload.status, 'active');
  assert.equal(activated.gen, 7, 'the generation is echoed on async answers too');

  const deactivated = await host.request('lifecycle.deactivate', { id: 'forge-tests.healthy' });
  assert.deepEqual(deactivated.payload, { id: 'forge-tests.healthy', status: 'inactive' });
});

test('a failing activation answers a typed error and logs it as a notification', async () => {
  const host = createLoadingResponder();
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('throwing'), hostDescriptor('unsupported')],
    workspace: null,
  });

  const failed = await host.request('lifecycle.activate', { id: 'forge-tests.throwing' });
  assert.equal(failed.kind, 'error');
  assert.equal(failed.payload.code, 'ACTIVATION_FAILED');
  assert.equal(failed.payload.stack, undefined, 'the stack never crosses the wire');
  assert.equal(
    host.notifications.some(
      (envelope) => envelope.method === 'diagnostics.log' && envelope.payload.level === 'error',
    ),
    true,
  );

  await host.request('lifecycle.activate', { id: 'forge-tests.unsupported' });
  const reported = host.notifications.find(
    (envelope) => envelope.method === 'diagnostics.unsupportedApi',
  );
  assert.deepEqual(reported.payload, {
    api: 'window.createStatusBarItem',
    extensionId: 'forge-tests.unsupported',
  });
  assert.equal(reported.id, 0, 'notifications carry no correlation id');
});

test('activate before the handshake, or with a bad payload, is refused typed', async () => {
  const host = createLoadingResponder();

  const early = await host.request('lifecycle.activate', { id: 'forge-tests.healthy' });
  assert.equal(early.payload.code, 'HOST_UNAVAILABLE');

  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('healthy')],
    workspace: null,
  });

  const malformed = await host.request('lifecycle.activate', { name: 'healthy' });
  assert.equal(malformed.payload.code, 'INVALID_PAYLOAD');

  const unknown = await host.request('lifecycle.activate', { id: 'acme.nope' });
  assert.equal(unknown.payload.code, 'INVALID_PAYLOAD');
  assert.match(unknown.payload.message, /no forma parte de esta generación/);
});

test('shutdown deactivates what is active before answering', async () => {
  const host = createLoadingResponder();
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('healthy')],
    workspace: null,
  });
  await host.request('lifecycle.activate', { id: 'forge-tests.healthy' });

  const shutdown = await host.request('lifecycle.shutdown', {});

  assert.deepEqual(shutdown.payload, { ok: true });
  const loaded = require(path.join(HOST_FIXTURES, 'healthy', 'out', 'extension.js'));
  assert.equal(loaded.trace.includes('deactivate'), true, 'the extension got its deactivate()');
});

// ── Commands end to end (increment 3.3) ─────────────────────────────────
// The full path with nothing stubbed between the two ends: a fixture
// extension registers a command inside the host, the notification travels
// through the broker, main's dispatcher indexes it and runs it.

const {
  ExtensionCommandDispatcher,
} = require('../../dist-electron/extensions/application/extension-command-dispatcher.js');
const {
  ExtensionActivationService,
} = require('../../dist-electron/extensions/application/extension-activation-service.js');
const { RpcError } = require('../../dist-electron/extensions/domain/rpc-protocol.js');

test('a fixture command registers through the broker and runs from main', async () => {
  const descriptor = hostDescriptor('commanding');
  const timers = createFakeTimers();
  const launcher = createFakeLauncher(timers);
  const host = new UtilityProcessExtensionHost({
    launcher,
    timers,
    initialize: () => ({
      apiVersion: '1.90.0',
      extensions: [descriptor],
      workspace: null,
      trust: true,
    }),
    warn: () => {},
  });

  const activation = new ExtensionActivationService({
    host,
    activatable: () => [{ id: descriptor.id, activationEvents: ['onCommand:fixture.greet'] }],
    ensureRunning: () => host.start(),
  });
  const dispatcher = new ExtensionCommandDispatcher({ host, activation });
  host.onEvent((event) => {
    dispatcher.handleHostEvent(event);
    activation.handleHostEvent(event);
  });

  await host.start();
  assert.equal(dispatcher.hasCommand('fixture.greet'), false, 'nothing is active yet');

  const result = await dispatcher.execute('fixture.greet', ['Forge']);

  assert.equal(result, 'hola, Forge');
  assert.deepEqual(
    dispatcher.registered().map((entry) => entry.command).sort(),
    ['fixture.explode', 'fixture.greet', 'fixture.leaked'],
    'every registration crossed as a notification',
  );

  // A command that throws inside the extension comes back as a typed error
  // and leaves the host running.
  await assert.rejects(dispatcher.execute('fixture.explode'), (err) => {
    assert.match(err.message, /el comando revienta/);
    return true;
  });
  assert.equal(host.state.status, 'running');

  assert.deepEqual(
    activation.metrics().map((entry) => entry.reason),
    ['onCommand:fixture.greet'],
    'the activation was attributed to the command that triggered it',
  );

  await host.stop();
  assert.deepEqual(dispatcher.registered(), [], 'stopping the host clears the registry');
});

// ── Host → main requests and configuration (increment 3.4) ──────────────

test('the host asks main to show a message and resumes with the answer', async () => {
  const host = createLoadingResponder();
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('messaging')],
    workspace: null,
    configuration: { 'messaging.greeting': 'buenas' },
  });

  const activation = host.request('lifecycle.activate', { id: 'forge-tests.messaging' });
  // The activation cannot finish until main answers: the extension awaits
  // the message box inside `activate`.
  await new Promise((resolve) => setImmediate(resolve));

  const outbound = host.lastOutbound();
  assert.equal(outbound.method, 'window.showMessage');
  assert.equal(outbound.kind, 'request');
  assert.equal(outbound.gen, 7, 'the request carries the generation it belongs to');
  assert.deepEqual(outbound.payload, {
    severity: 'info',
    message: 'buenas, mundo',
    items: ['Sí', 'No'],
    modal: false,
  });

  host.send({
    v: 1,
    gen: 7,
    id: outbound.id,
    kind: 'response',
    method: 'window.showMessage',
    payload: { selected: 'Sí' },
  });

  const answer = await activation;
  assert.equal(answer.payload.status, 'active');
});

test('an error from main rejects the host request instead of hanging it', async () => {
  const host = createLoadingResponder();
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('messaging')],
    workspace: null,
    configuration: {},
  });

  const activation = host.request('lifecycle.activate', { id: 'forge-tests.messaging' });
  await new Promise((resolve) => setImmediate(resolve));
  const outbound = host.lastOutbound();

  host.send({
    v: 1,
    gen: 7,
    id: outbound.id,
    kind: 'error',
    method: 'window.showMessage',
    payload: { code: 'UNSUPPORTED_API', message: 'sin ventana' },
  });

  const answer = await activation;
  assert.equal(answer.kind, 'error');
  assert.match(answer.payload.message, /sin ventana/);
});

test('configuration.update replaces the snapshot the host serves', async () => {
  const host = createLoadingResponder();
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [hostDescriptor('messaging')],
    workspace: null,
    configuration: { 'messaging.greeting': 'hola' },
  });

  const updated = await host.request('configuration.update', {
    values: { 'messaging.greeting': 'adiós' },
  });
  assert.deepEqual(updated.payload, { ok: true, keys: 1 });

  const activation = host.request('lifecycle.activate', { id: 'forge-tests.messaging' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    host.lastOutbound().payload.message,
    'adiós, mundo',
    'the extension read the value pushed after the handshake',
  );
  host.send({
    v: 1,
    gen: 7,
    id: host.lastOutbound().id,
    kind: 'response',
    method: 'window.showMessage',
    payload: { selected: null },
  });
  await activation;
});

test('a malformed configuration payload reads as empty, never as garbage', async () => {
  const host = createLoadingResponder();
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [],
    workspace: null,
    configuration: 'no soy un objeto',
  });

  const updated = await host.request('configuration.update', { values: ['tampoco'] });
  assert.deepEqual(updated.payload, { ok: true, keys: 0 });
});

// ── Hello World: criterio de salida del Milestone 3 ─────────────────────

test('the unmodified Hello World activates by command, shows its message and deactivates clean', async () => {
  const descriptor = hostDescriptor('helloworld');
  const timers = createFakeTimers();
  const launcher = createFakeLauncher(timers);
  const shown = [];

  const host = new UtilityProcessExtensionHost({
    launcher,
    timers,
    initialize: () => ({
      apiVersion: '1.90.0',
      extensions: [descriptor],
      workspace: null,
      trust: true,
      configuration: {},
    }),
    // Main's side of `window.showMessage`; the renderer would be here.
    onRequest: async (envelope) => {
      assert.equal(envelope.method, 'window.showMessage');
      shown.push(envelope.payload);
      return { selected: undefined };
    },
    warn: () => {},
  });

  const activation = new ExtensionActivationService({
    host,
    activatable: () => [{ id: descriptor.id, activationEvents: ['onCommand:helloworld.helloWorld'] }],
    ensureRunning: () => host.start(),
  });
  const dispatcher = new ExtensionCommandDispatcher({ host, activation });
  host.onEvent((event) => {
    dispatcher.handleHostEvent(event);
    activation.handleHostEvent(event);
  });

  await host.start();

  // Exactly what the command palette does.
  await dispatcher.execute('helloworld.helloWorld');

  assert.deepEqual(shown, [{
    severity: 'info',
    message: 'Hello World from HelloWorld!',
    items: [],
    modal: false,
  }]);
  assert.equal(activation.stateOf(descriptor.id), 'active');
  assert.equal(activation.metrics()[0].reason, 'onCommand:helloworld.helloWorld');
  assert.deepEqual(activation.failures(), []);

  await host.stop();

  assert.equal(host.state.status, 'stopped');
  assert.deepEqual(dispatcher.registered(), [], 'its command left with it');
  assert.equal(activation.stateOf(descriptor.id), 'idle');
});

// ── Aislamiento demostrado (incremento 3.5) ─────────────────────────────
// Las fixtures hostiles no comprueban que Forge les impida hacer daño
// dentro de su proceso —el modelo de VS Code tampoco lo hace— sino que el
// daño no sale de ahí y queda diagnosticado.

function createHostFor(names, hostOptions = {}) {
  const descriptors = names.map(hostDescriptor);
  const timers = createFakeTimers();
  const launcher = createFakeLauncher(timers);
  const events = [];
  const host = new UtilityProcessExtensionHost({
    launcher,
    timers,
    initialize: () => ({
      apiVersion: '1.90.0',
      extensions: descriptors,
      workspace: null,
      trust: true,
      configuration: {},
    }),
    warn: () => {},
    ...hostOptions,
  });
  host.onEvent((event) => events.push(event));
  return { host, timers, launcher, events, descriptors };
}

test('an extension that hangs in activate times out without taking the host down', async () => {
  const h = createHostFor(['hanging', 'commanding']);
  await h.host.start();

  const hung = assert.rejects(
    h.host.request('lifecycle.activate', { id: 'forge-tests.hanging' }, {
      extensionId: 'forge-tests.hanging',
    }),
    (err) => {
      assert.equal(err.code, 'TIMEOUT');
      return true;
    },
  );
  // `lifecycle.activate` budgets 10 s (design §3.4).
  await h.timers.advance(10_000);
  await hung;

  assert.equal(h.host.state.status, 'running', 'one timeout does not kill the host');
  const timeout = h.events.find((event) => event.type === 'request-timeout');
  assert.equal(timeout.extensionId, 'forge-tests.hanging', 'the culprit is named');

  // Its neighbour is untouched.
  const answer = await h.host.request('lifecycle.activate', { id: 'forge-tests.commanding' });
  assert.equal(answer.status, 'active');
});

test('an extension that kills the process loses its generation, not Forge', async () => {
  const h = createHostFor(['crasher']);
  await h.host.start();
  const first = h.launcher.latest();

  // The fixture calls `process.exit`; the fake process models that as an exit.
  first.exit(7);
  await flush();

  assert.equal(h.host.state.status, 'restarting');
  assert.match(h.host.state.lastError.message, /terminó \(código 7\)/);

  await h.timers.advance(500);
  assert.equal(h.host.state.status, 'running');
  assert.equal(h.host.state.generation, 2, 'a fresh generation, not a dead one');
});

test('killing the host mid-request rejects what was in flight instead of hanging it', async () => {
  const h = createHostFor(['hanging']);
  await h.host.start();

  const inFlight = assert.rejects(
    h.host.request('lifecycle.activate', { id: 'forge-tests.hanging' }),
    (err) => {
      assert.equal(err.code, 'HOST_UNAVAILABLE');
      return true;
    },
  );
  h.launcher.latest().exit(1);
  await flush();
  await inFlight;
});

test('a log storm is trimmed per extension without silencing its neighbours', async () => {
  const h = createHostFor(['log-storm', 'commanding']);
  await h.host.start();
  const child = h.launcher.latest();

  const line = (extensionId, message) => ({
    v: 1,
    gen: 1,
    id: 0,
    kind: 'event',
    method: 'diagnostics.log',
    extensionId,
    payload: { level: 'info', message, extensionId },
  });

  for (let i = 0; i < 400; i += 1) child.deliver(line('forge-tests.log-storm', `ruido ${i}`));
  child.deliver(line('forge-tests.commanding', 'algo importante'));
  await h.timers.advance(100);

  const entries = h.events.filter((event) => event.type === 'logs').flatMap((event) => event.entries);
  const noisy = entries.filter((entry) => entry.extensionId === 'forge-tests.log-storm');
  assert.ok(noisy.length < 400, 'the flood is trimmed');
  assert.ok(
    entries.some((entry) => entry.message === 'algo importante'),
    'the quiet extension is still heard',
  );
  assert.ok(
    entries.some((entry) => /rate exceeded/i.test(entry.message)),
    'and the trimming is stated, not silent',
  );
});

test('an extension cannot hijack a command id another one owns', async () => {
  const h = createHostFor(['commanding', 'hijacker']);
  await h.host.start();

  await h.host.request('lifecycle.activate', { id: 'forge-tests.commanding' });
  await assert.rejects(
    h.host.request('lifecycle.activate', { id: 'forge-tests.hijacker' }),
    (err) => {
      assert.equal(err.code, 'ACTIVATION_FAILED');
      assert.match(err.message, /ya está registrado/);
      return true;
    },
  );

  // The original owner keeps its command, and it still works.
  const answer = await h.host.request('commands.execute', {
    command: 'fixture.greet',
    args: ['Forge'],
  });
  assert.equal(answer.result, 'hola, Forge');
});

// ── workspace.fs de punta a punta (incremento 4.0) ──────────────────────

test('a fixture reads and writes inside the workspace, and is refused outside', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ws-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'existente.txt'), 'ya estaba');

  const descriptor = hostDescriptor('filesystem');
  const timers = createFakeTimers();
  const launcher = createFakeLauncher(timers);
  const {
    ExtensionFileSystem,
    ExtensionFileSystemError,
  } = require('../../dist-electron/extensions/application/extension-file-system.js');
  const {
    NodeExtensionFileSystem,
  } = require('../../dist-electron/extensions/infrastructure/node-extension-file-system.js');

  const fileSystem = new ExtensionFileSystem({
    fs: new NodeExtensionFileSystem(),
    scopesFor: () => ({
      workspace,
      extensionDir: descriptor.dir,
      storagePaths: [descriptor.globalStoragePath],
    }),
  });

  const host = new UtilityProcessExtensionHost({
    launcher,
    timers,
    initialize: () => ({
      apiVersion: '1.90.0',
      extensions: [descriptor],
      workspace,
      trust: true,
      configuration: {},
    }),
    onRequest: async (envelope) => {
      assert.equal(ExtensionFileSystem.owns(envelope.method), true);
      try {
        return await fileSystem.handle(
          envelope.extensionId,
          ExtensionFileSystem.operationOf(envelope.method),
          envelope.payload,
        );
      } catch (err) {
        if (err instanceof ExtensionFileSystemError) {
          throw new RpcError('INVALID_PAYLOAD', err.message, { code: err.code });
        }
        throw err;
      }
    },
    warn: () => {},
  });

  await host.start();
  const answer = await host.request('lifecycle.activate', { id: descriptor.id }, {
    extensionId: descriptor.id,
  });

  assert.equal(answer.status, 'active');
  // The fixture returned what it saw; `exports` only carries the keys, so
  // the effects are asserted on disk and through a second read.
  assert.equal(
    fs.readFileSync(path.join(workspace, 'generado.txt'), 'utf8'),
    'hola disco',
    'the write landed in the workspace',
  );
  assert.deepEqual(answer.exports.sort(), [
    'content', 'escaped', 'inWorkspace', 'names', 'relative', 'size',
  ]);

  await host.stop();
});

// ── Documentos de punta a punta (incremento 4.1) ────────────────────────

test('an extension sees the dirty buffer and the whole document lifecycle', async () => {
  const {
    DocumentMirror,
  } = require('../../dist-electron/extensions/application/document-mirror.js');

  const host = createLoadingResponder();
  const descriptor = hostDescriptor('documents');

  // Main's mirror, wired to the host exactly as the composition root does.
  const mirror = new DocumentMirror({
    notifyHost: (event, document) => {
      void host.request('documents.sync', {
        kind: event.kind,
        uri: document?.uri ?? event.uri,
        document,
      });
    },
  });

  // A file already open when the generation starts is state, not an event.
  mirror.apply({
    kind: 'open',
    document: {
      uri: '/w/preexistente.txt',
      languageId: 'plaintext',
      version: 1,
      content: 'ya estaba',
      isDirty: false,
    },
  });

  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [descriptor],
    workspace: '/w',
    configuration: {},
    documents: mirror.snapshot(),
  });
  await host.request('lifecycle.activate', { id: descriptor.id });

  // Now the user works: opens a file, types, saves, closes.
  mirror.apply({
    kind: 'open',
    document: {
      uri: '/w/a.txt',
      languageId: 'plaintext',
      version: 1,
      content: 'en disco',
      isDirty: false,
    },
  });
  mirror.apply({ kind: 'change', uri: '/w/a.txt', version: 2, content: 'sin guardar' });
  mirror.apply({ kind: 'save', uri: '/w/a.txt', version: 3, content: 'sin guardar' });
  mirror.apply({ kind: 'close', uri: '/w/a.txt' });
  await new Promise((resolve) => setImmediate(resolve));

  const loaded = require(path.join(HOST_FIXTURES, 'documents', 'out', 'extension.js'));
  assert.deepEqual(loaded.trace, [
    'open:/w/a.txt:en disco',
    'change:/w/a.txt:v2:sin guardar',
    'save:/w/a.txt:clean',
    'close:/w/a.txt',
  ], 'the extension saw the buffer, including the unsaved revision');

  // And the mirror is what answers about content, not the disk.
  assert.equal(mirror.contentOf('/w/preexistente.txt'), 'ya estaba');
});

// ── Editores de punta a punta (incremento 4.2) ──────────────────────────

test('facade getters follow documents and editors opened after extension activation', async () => {
  const host = createLoadingResponder();
  const descriptor = hostDescriptor('documents');
  await host.request('lifecycle.initialize', {
    protocol: 1, apiVersion: '1.90.0', extensions: [descriptor],
    workspace: '/w', configuration: {}, documents: [],
    editors: { editors: [], activeUri: null },
  });
  await host.request('lifecycle.activate', { id: descriptor.id });
  const loaded = require(path.join(HOST_FIXTURES, 'documents', 'out', 'extension.js'));
  assert.deepEqual(loaded.snapshot(), { documents: [], active: null, visible: [] });
  await host.request('documents.sync', { kind: 'open', document: {
    uri: '/w/late.ts', languageId: 'typescript', version: 1,
    content: 'disk', isDirty: false,
  } });
  await host.request('editors.sync', { activeUri: '/w/late.ts', editors: [{
    uri: '/w/late.ts', viewColumn: 1,
    selections: [{ anchorLine: 0, anchorCharacter: 0, activeLine: 0, activeCharacter: 0 }],
  }] });
  await host.request('documents.sync', { kind: 'change', uri: '/w/late.ts', document: {
    uri: '/w/late.ts', version: 2, content: 'dirty buffer', isDirty: true,
  } });
  assert.deepEqual(loaded.snapshot(), {
    documents: [{ fileName: '/w/late.ts', content: 'dirty buffer', version: 2 }],
    active: '/w/late.ts', visible: ['/w/late.ts'],
  });
  await host.request('documents.sync', { kind: 'close', uri: '/w/late.ts' });
  await host.request('editors.sync', { activeUri: null, editors: [] });
  assert.deepEqual(loaded.snapshot(), { documents: [], active: null, visible: [] });
});

test('an extension follows the focus and reads the selected text', async () => {
  const host = createLoadingResponder();
  const descriptor = hostDescriptor('editors');

  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [descriptor],
    workspace: '/w',
    configuration: {},
    documents: [{
      uri: '/w/a.txt',
      languageId: 'plaintext',
      version: 1,
      content: 'const nombre = valor;',
      isDirty: false,
    }],
    editors: {
      editors: [{
        uri: '/w/a.txt',
        viewColumn: 1,
        selections: [{
          anchorLine: 0, anchorCharacter: 6, activeLine: 0, activeCharacter: 12,
        }],
      }],
      activeUri: '/w/a.txt',
    },
  });
  await host.request('lifecycle.activate', { id: descriptor.id });

  // The editor that already existed is state, so no event fired for it, but
  // the extension can read it — including the text under the selection.
  const loaded = require(path.join(HOST_FIXTURES, 'editors', 'out', 'extension.js'));
  assert.deepEqual(loaded.trace, []);
  assert.equal(loaded.readSelectedText(), 'nombre');

  // Now the user moves the caret and switches focus away.
  await host.request('editors.sync', {
    editors: [{
      uri: '/w/a.txt',
      viewColumn: 1,
      selections: [{ anchorLine: 0, anchorCharacter: 0, activeLine: 0, activeCharacter: 5 }],
    }],
    activeUri: '/w/a.txt',
  });
  await host.request('editors.sync', { editors: [], activeUri: null });

  assert.deepEqual(loaded.trace, [
    'selection:/w/a.txt:0:5',
    'active:none',
  ]);
});

test('showTextDocument reaches main with preserveFocus, without opening a tab itself', async () => {
  const host = createLoadingResponder();
  const descriptor = hostDescriptor('editors');
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [descriptor],
    workspace: '/w',
    configuration: {},
    documents: [],
    editors: { editors: [], activeUri: null },
  });
  await host.request('lifecycle.activate', { id: descriptor.id });

  const api = require('node:module')._load(
    'vscode',
    { filename: path.join(HOST_FIXTURES, 'editors', 'out', 'extension.js') },
    false,
  );
  const shown = api.window.showTextDocument('/w/b.txt', { preserveFocus: true });
  await new Promise((resolve) => setImmediate(resolve));

  const outbound = host.lastOutbound();
  assert.equal(outbound.method, 'editors.show');
  assert.deepEqual(outbound.payload, { uri: '/w/b.txt', preserveFocus: true });

  host.send({
    v: 1,
    gen: 7,
    id: outbound.id,
    kind: 'response',
    method: 'editors.show',
    payload: { shown: true },
  });
  await shown;
});

// ── Edición multiarchivo de punta a punta (incremento 4.3) ──────────────

test('a refactor across two files applies whole, and a stale version rejects it whole', async () => {
  const {
    DocumentMirror,
  } = require('../../dist-electron/extensions/application/document-mirror.js');
  const {
    WorkspaceEditService,
  } = require('../../dist-electron/extensions/application/workspace-edit-service.js');

  const disk = { '/w/cerrado.ts': 'const viejo = 2;' };
  const rendererApplied = [];
  const mirror = new DocumentMirror({});
  mirror.apply({
    kind: 'open',
    document: {
      uri: '/w/abierto.ts',
      languageId: 'typescript',
      version: 3,
      content: 'const viejo = 1;',
      isDirty: true,
    },
  });

  const edits = new WorkspaceEditService({
    mirror,
    authorise: async () => undefined,
    readFile: async (uri) => disk[uri],
    writeFile: async (uri, content) => { disk[uri] = content; },
    applyInRenderer: async (uri, applied) => {
      rendererApplied.push({ uri, count: applied.length });
      return true;
    },
  });

  const host = createLoadingResponder();
  const descriptor = hostDescriptor('editing');
  await host.request('lifecycle.initialize', {
    protocol: 1,
    apiVersion: '1.90.0',
    extensions: [descriptor],
    workspace: '/w',
    configuration: {},
    documents: mirror.snapshot(),
    editors: { editors: [], activeUri: null },
  });
  await host.request('lifecycle.activate', { id: descriptor.id });

  const fixture = require(path.join(HOST_FIXTURES, 'editing', 'out', 'extension.js'));

  // The host talks to main through `hostRequest`; answer its calls as the
  // composition root would.
  const serveOutbound = async () => {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      const outbound = host.lastOutbound();
      if (!outbound || outbound.answered) return;
      outbound.answered = true;
      let payload;
      if (outbound.method === 'documents.open') {
        const uri = outbound.payload.uri;
        payload = mirror.get(uri) ?? {
          uri,
          languageId: 'typescript',
          version: 1,
          content: disk[uri] ?? '',
          isDirty: false,
        };
      } else if (outbound.method === 'workspace.applyEdit') {
        payload = await edits.apply(outbound.payload, descriptor.id);
      } else {
        payload = {};
      }
      host.send({
        v: 1,
        gen: 7,
        id: outbound.id,
        kind: 'response',
        method: outbound.method,
        payload,
      });
    }
  };

  const running = fixture.renameAcrossFiles(['/w/abierto.ts', '/w/cerrado.ts']);
  await serveOutbound();
  assert.equal(await running, true, 'the refactor applied');

  assert.equal(disk['/w/cerrado.ts'], 'const nuevo = 2;', 'the closed file was rewritten');
  assert.deepEqual(rendererApplied, [{ uri: '/w/abierto.ts', count: 1 }], 'one undo step');

  // Now the user types: the version moves, and the same edit is refused.
  mirror.apply({ kind: 'change', uri: '/w/abierto.ts', version: 9, content: 'const viejo = 1;' });
  const stale = await edits.apply({
    files: [{
      uri: '/w/abierto.ts',
      version: 3,
      edits: [{ startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11, newText: 'nuevo' }],
    }],
  }, descriptor.id);

  assert.equal(stale.applied, false);
  assert.match(stale.reason, /cambió mientras/);
});
