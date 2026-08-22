'use strict';

// What the workbench says about the host and about each extension's
// runtime. Pure derivation, so it is tested without a DOM: the UI picks
// colours, these functions decide what is true.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeActivationReason,
  describeHostStatus,
  formatDuration,
  summarizeExtensionRuntime,
} = require('../../src/extensions/hostStatus.ts');

const state = (overrides = {}) => ({
  status: 'running',
  generation: 1,
  restartsInWindow: 0,
  lastError: null,
  ...overrides,
});

// ── Host status ─────────────────────────────────────────────────────────

test('a healthy host has nothing to add beyond being up', () => {
  const description = describeHostStatus(state());

  assert.equal(description.label, 'En ejecución');
  assert.equal(description.tone, 'neutral');
  assert.equal(description.detail, null, 'a permanent "you are fine" line is noise');
  assert.equal(description.canRestart, true);
});

test('recent restarts are stated because they are the symptom worth seeing', () => {
  assert.match(describeHostStatus(state({ restartsInWindow: 1 })).detail, /1 vez/);
  assert.match(describeHostStatus(state({ restartsInWindow: 3 })).detail, /3 veces/);
});

test('the crash-loop breaker reads as danger and offers the manual restart', () => {
  const description = describeHostStatus(state({ status: 'disabled', restartsInWindow: 3 }));

  assert.equal(description.tone, 'danger');
  assert.match(description.detail, /bucle/);
  assert.equal(description.canRestart, true, 'the manual restart is the way out');
});

test('a restart in flight explains itself with the error that caused it', () => {
  const description = describeHostStatus(state({
    status: 'restarting',
    lastError: { code: 'HOST_UNAVAILABLE', message: 'el proceso terminó (código 7)' },
  }));

  assert.equal(description.tone, 'busy');
  assert.match(description.detail, /código 7/);
  assert.equal(description.canRestart, false, 'nothing to restart while it is restarting');
});

test('a stopped host distinguishes "nothing to run" from a failure', () => {
  assert.match(describeHostStatus(state({ status: 'stopped' })).detail, /ninguna extensión/i);
  assert.match(
    describeHostStatus(state({ status: 'stopped', lastError: { code: 'X', message: 'boom' } })).detail,
    /boom/,
  );
});

test('outside Electron there is no host, and it says so', () => {
  const description = describeHostStatus(null);

  assert.equal(description.canRestart, false);
  assert.match(description.detail, /escritorio/);
});

// ── Per-extension runtime ───────────────────────────────────────────────

const report = (metrics = [], failures = []) => ({ metrics, failures });

test('an extension nobody triggered is idle, not broken and not fine', () => {
  const summary = summarizeExtensionRuntime(report(), 'acme.demo');

  assert.deepEqual(summary, { state: 'idle', reason: null, durationMs: null, error: null });
  assert.deepEqual(summarizeExtensionRuntime(null, 'acme.demo').state, 'idle');
});

test('an activated extension reports what woke it up and what it cost', () => {
  const summary = summarizeExtensionRuntime(
    report([{ id: 'acme.demo', reason: 'onCommand:demo.run', durationMs: 12, at: 5 }]),
    'acme.demo',
  );

  assert.equal(summary.state, 'active');
  assert.equal(summary.reason, 'onCommand:demo.run');
  assert.equal(summary.durationMs, 12);
});

test('the latest word wins: a later success clears an earlier failure', () => {
  const entries = report(
    [{ id: 'acme.demo', reason: 'onStartupFinished', durationMs: 4, at: 20 }],
    [{ id: 'acme.demo', reason: 'onCommand:x', code: 'ACTIVATION_FAILED', message: 'boom', at: 10 }],
  );

  assert.equal(summarizeExtensionRuntime(entries, 'acme.demo').state, 'active');

  const stillFailed = report(
    [{ id: 'acme.demo', reason: 'onStartupFinished', durationMs: 4, at: 10 }],
    [{ id: 'acme.demo', reason: 'onCommand:x', code: 'ACTIVATION_FAILED', message: 'boom', at: 20 }],
  );
  const summary = summarizeExtensionRuntime(stillFailed, 'acme.demo');
  assert.equal(summary.state, 'failed');
  assert.deepEqual(summary.error, { code: 'ACTIVATION_FAILED', message: 'boom' });
});

test('one extension\'s runtime never leaks into another\'s', () => {
  const entries = report(
    [{ id: 'acme.one', reason: 'onStartupFinished', durationMs: 4, at: 1 }],
    [{ id: 'acme.two', reason: 'onStartupFinished', code: 'X', message: 'boom', at: 1 }],
  );

  assert.equal(summarizeExtensionRuntime(entries, 'acme.one').state, 'active');
  assert.equal(summarizeExtensionRuntime(entries, 'acme.two').state, 'failed');
  assert.equal(summarizeExtensionRuntime(entries, 'acme.three').state, 'idle');
});

// ── Wording ─────────────────────────────────────────────────────────────

test('durations read as a person reads them', () => {
  assert.equal(formatDuration(0.4), '<1 ms');
  assert.equal(formatDuration(12.6), '13 ms');
  assert.equal(formatDuration(1500), '1.5 s');
  assert.equal(formatDuration(12_000), '12 s');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(Number.NaN), '—');
});

test('activation reasons are translated to what the user recognises', () => {
  assert.equal(describeActivationReason('onStartupFinished'), 'al arrancar Forge');
  assert.equal(describeActivationReason('*'), 'al arrancar Forge');
  assert.equal(describeActivationReason('onCommand:demo.run'), 'por el comando demo.run');
  assert.equal(describeActivationReason('onLanguage:python'), 'al abrir python');
  assert.equal(
    describeActivationReason('workspaceContains:pom.xml'),
    'porque el workspace contiene pom.xml',
  );
  assert.equal(describeActivationReason(null), null);
  // Anything Forge does not know is shown verbatim instead of guessed at.
  assert.equal(describeActivationReason('onWeirdEvent'), 'onWeirdEvent');
});
