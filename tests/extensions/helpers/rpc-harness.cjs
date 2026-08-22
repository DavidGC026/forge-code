'use strict';

// Test doubles for the Extension Host kernel: a controllable clock, a fake
// transport and a fake launcher whose "process" runs the real bootstrap
// responder. Nothing here waits in real time and nothing loads Electron.

const fs = require('node:fs');
const path = require('node:path');

const { createBootstrapResponder } = require('../../../dist-electron/extension-host/bootstrap.js');
const {
  ExtensionRuntime,
} = require('../../../dist-electron/extension-host/extension-runtime.js');

/**
 * Runtime for the fake processes.
 *
 * Identical to the shipped one except for the `require` cache: every fake
 * "process" lives in the *same* Node instance as the test runner, so a
 * cached module would keep the `vscode` facade of a previous generation and
 * register its commands there. In production each generation is a real
 * process and the question does not arise.
 */
function createTestRuntime(input) {
  return new ExtensionRuntime({
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
  });
}

/** Lets queued promise callbacks run before assertions. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createFakeTimers(startAt = 1_000) {
  let now = startAt;
  let sequence = 1;
  const scheduled = new Map();

  return {
    now: () => now,
    setTimer(handler, delayMs) {
      const handle = sequence++;
      scheduled.set(handle, { at: now + delayMs, handler });
      return handle;
    },
    clearTimer(handle) {
      scheduled.delete(handle);
    },
    /** Fires every timer due within `ms`, letting promises settle between them. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [handle, timer] of scheduled) {
          if (timer.at <= target && (next === null || timer.at < next[1].at)) {
            next = [handle, timer];
          }
        }
        if (!next) break;
        scheduled.delete(next[0]);
        now = next[1].at;
        next[1].handler();
        await flush();
      }
      now = target;
      await flush();
    },
    pendingTimers: () => scheduled.size,
  };
}

function createFakeTransport() {
  const sent = [];
  const listeners = new Set();
  const state = { closed: false, failSend: null };

  return {
    sent,
    state,
    transport: {
      send(envelope) {
        if (state.failSend) throw new Error(state.failSend);
        sent.push(envelope);
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        state.closed = true;
      },
    },
    /** Simulates a message arriving from the other side. */
    deliver(message) {
      for (const listener of [...listeners]) listener(message);
    },
    lastSent() {
      return sent[sent.length - 1];
    },
  };
}

/** Builds the answer the peer would send for `request`. */
function responseTo(request, payload, overrides = {}) {
  return {
    v: 1,
    gen: request.gen,
    id: request.id,
    kind: 'response',
    method: request.method,
    payload,
    ...overrides,
  };
}

function errorTo(request, code, message, overrides = {}) {
  return {
    v: 1,
    gen: request.gen,
    id: request.id,
    kind: 'error',
    method: request.method,
    payload: { code, message },
    ...overrides,
  };
}

function eventEnvelope(method, payload, overrides = {}) {
  return { v: 1, gen: 1, id: 0, kind: 'event', method, payload, ...overrides };
}

/**
 * Launcher whose processes answer with the real `bootstrap.ts` responder, so
 * the host policy is exercised against the protocol implementation that ships
 * — the in-process half of the contract battery (design §9).
 */
function createFakeLauncher(timers, options = {}) {
  const generations = [];

  return {
    generations,
    /** Last spawned generation. */
    latest: () => generations[generations.length - 1],
    spawn(generation) {
      const exitListeners = new Set();
      const brokerListeners = new Set();
      const sent = [];
      const child = {
        generation,
        sent,
        killed: false,
        alive: true,
        closed: false,
        /** While true the process receives messages and never answers. */
        hung: false,
        /** Pushes a message from the process to the broker. */
        deliver(message) {
          for (const listener of [...brokerListeners]) listener(message);
        },
        exit(code = 1) {
          if (!child.alive) return;
          child.alive = false;
          for (const listener of [...exitListeners]) listener(code);
        },
      };

      const respond = createBootstrapResponder({
        now: timers.now,
        nodeVersion: options.nodeVersion ?? '20.0.0',
        exit: () => child.exit(0),
        warn: () => {},
        // Host-originated notifications (logs, command registrations) travel
        // the same channel as answers, so the fake process delivers them the
        // same way the real port would.
        notify: (envelope) => {
          if (child.alive && !child.hung) child.deliver(envelope);
        },
        createRuntime: options.createRuntime ?? createTestRuntime,
      });

      generations.push(child);
      if (options.failSpawn?.(generation)) throw new Error(`spawn failed for gen ${generation}`);

      return {
        transport: {
          send(envelope) {
            sent.push(envelope);
            if (child.hung || !child.alive) return;
            const scripted = options.respond?.(envelope, child);
            const answer = scripted === undefined ? respond(envelope) : scripted;
            // The real responder answers asynchronously for anything that runs
            // extension code (`lifecycle.activate`); lifecycle handshakes stay
            // synchronous, so timing-sensitive tests are unaffected.
            if (answer && typeof answer.then === 'function') {
              answer.then((resolved) => {
                if (resolved && child.alive && !child.hung) child.deliver(resolved);
              });
            } else if (answer) {
              child.deliver(answer);
            }
          },
          onMessage(listener) {
            brokerListeners.add(listener);
            return () => brokerListeners.delete(listener);
          },
          close() {
            child.closed = true;
          },
        },
        kill() {
          child.killed = true;
          child.exit(0);
        },
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
      };
    },
  };
}

module.exports = {
  createTestRuntime,
  flush,
  createFakeTimers,
  createFakeTransport,
  createFakeLauncher,
  responseTo,
  errorTo,
  eventEnvelope,
};
