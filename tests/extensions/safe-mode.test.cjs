'use strict';

// Safe Mode: the way out of a crash loop. Its rules are about recovery, so
// what matters is that entering works without the host's cooperation and
// that leaving never lies about having worked.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISABLE_EXTENSIONS_FLAG,
  hasDisableExtensionsFlag,
  resolveSafeMode,
} = require('../../dist-electron/extensions/domain/safe-mode.js');
const {
  SafeModeService,
  SafeModeError,
} = require('../../dist-electron/extensions/application/safe-mode-service.js');
const {
  ForgeSafeModeStore,
} = require('../../dist-electron/extensions/infrastructure/forge-safe-mode-store.js');

// ── Policy ──────────────────────────────────────────────────────────────

test('the flag is matched exactly, never by prefix', () => {
  assert.equal(hasDisableExtensionsFlag(['forge', DISABLE_EXTENSIONS_FLAG]), true);
  assert.equal(hasDisableExtensionsFlag(['forge', '--disable-extensions-foo']), false);
  assert.equal(hasDisableExtensionsFlag(['forge', '--disable', 'extensions']), false);
  assert.equal(hasDisableExtensionsFlag([]), false);
});

test('the command line wins over the persisted decision and cannot be undone in-process', () => {
  const fromFlag = resolveSafeMode({ commandLine: true, persisted: false });
  assert.equal(fromFlag.active, true);
  assert.equal(fromFlag.source, 'command-line');
  assert.equal(fromFlag.canDisable, false, 'only a relaunch without the flag helps');

  const fromUser = resolveSafeMode({ commandLine: false, persisted: true, persistedReason: 'crash' });
  assert.equal(fromUser.source, 'user');
  assert.equal(fromUser.canDisable, true);
  assert.equal(fromUser.reason, 'crash');

  assert.deepEqual(resolveSafeMode({ commandLine: false, persisted: false }), {
    active: false,
    source: 'off',
    canDisable: true,
    reason: null,
  });
});

// ── Service ─────────────────────────────────────────────────────────────

function createService({ argv = ['forge'], stored = { enabled: false }, failRead = false } = {}) {
  let record = stored;
  const warnings = [];
  const service = new SafeModeService({
    store: {
      read: () => {
        if (failRead) throw new Error('config corrupta');
        return record;
      },
      write: (value) => { record = value; },
    },
    argv: () => argv,
    now: () => 1_000,
    warn: (message) => warnings.push(message),
  });
  return { service, warnings, current: () => record };
}

test('entering safe mode persists it and notifies', () => {
  const s = createService();
  const seen = [];
  s.service.onDidChange((status) => seen.push(status.source));

  const status = s.service.set(true, 'la extensión X reventaba');

  assert.equal(status.active, true);
  assert.equal(status.source, 'user');
  assert.equal(status.reason, 'la extensión X reventaba');
  assert.deepEqual(s.current(), { enabled: true, reason: 'la extensión X reventaba', at: 1_000 });
  assert.deepEqual(seen, ['user']);
});

test('leaving clears the record instead of writing a false', () => {
  const s = createService({ stored: { enabled: true, reason: 'x', at: 1 } });

  const status = s.service.set(false);

  assert.equal(status.active, false);
  assert.deepEqual(s.current(), { enabled: false, reason: null });
});

test('leaving is refused while the command line holds safe mode on', () => {
  const s = createService({ argv: ['forge', DISABLE_EXTENSIONS_FLAG] });

  assert.throws(() => s.service.set(false), (err) => {
    assert.ok(err instanceof SafeModeError);
    assert.match(err.message, /--disable-extensions/);
    return true;
  });
  assert.equal(s.service.active, true, 'and it really is still on');
});

test('unreadable configuration reads as off, with a diagnostic', () => {
  const s = createService({ failRead: true });

  assert.equal(s.service.active, false, 'a corrupt file must not strand the user');
  assert.equal(s.warnings.length, 1);
});

test('a throwing subscriber does not break the recovery mechanism', () => {
  const s = createService();
  s.service.onDidChange(() => { throw new Error('suscriptor roto'); });

  const status = s.service.set(true);

  assert.equal(status.active, true);
  assert.match(s.warnings.at(-1), /suscriptor/);
});

// ── Store ───────────────────────────────────────────────────────────────

test('the store round-trips, tolerates garbage and removes the key on exit', () => {
  let config = {};
  const store = new ForgeSafeModeStore({
    readConfig: () => config,
    writeConfig: (value) => { config = value; },
  });

  store.write({ enabled: true, reason: 'crash loop', at: 42 });
  assert.deepEqual(config.extensionSafeMode, { enabled: true, reason: 'crash loop', at: 42 });
  assert.deepEqual(store.read(), { enabled: true, reason: 'crash loop', at: 42 });

  store.write({ enabled: false });
  assert.equal('extensionSafeMode' in config, false, 'absence is the natural state');

  // Only an explicit `true` counts: anything else must not strand the user.
  config = { extensionSafeMode: { enabled: 'sí' } };
  assert.equal(store.read().enabled, false);
  config = { extensionSafeMode: 'on' };
  assert.equal(store.read().enabled, false);
  config = {};
  assert.equal(store.read().enabled, false);
});

test('safe mode does not depend on the extension registry it protects from', () => {
  // The record lives under its own key, so a registry that fails to parse
  // cannot take the recovery switch down with it.
  let config = { extensions: '💥 no es JSON válido para el registry' };
  const store = new ForgeSafeModeStore({
    readConfig: () => config,
    writeConfig: (value) => { config = value; },
  });

  store.write({ enabled: true, reason: 'registry roto' });

  assert.equal(store.read().enabled, true);
  assert.equal(config.extensions, '💥 no es JSON válido para el registry');
});
