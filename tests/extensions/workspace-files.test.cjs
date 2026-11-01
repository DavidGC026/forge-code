'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceFilesService } = require('../../dist-electron/extensions/application/workspace-files-service.js');
const { ExtensionFileSystem, ExtensionFileSystemError } = require('../../dist-electron/extensions/application/extension-file-system.js');
const { NodeExtensionFileSystem } = require('../../dist-electron/extensions/infrastructure/node-extension-file-system.js');
const { compileWorkspaceGlob, joinResource } = require('../../dist-electron/extensions/domain/workspace-glob.js');
const { scanWorkspaceFiles } = require('../../dist-electron/extensions/application/workspace-file-scan.js');
const { HostWorkspaceFiles, RelativePattern, resourcePath, resourceUri } = require('../../dist-electron/extension-host/vscode-api/workspace-files.js');
const { CancellationTokenSource, CancellationError, Uri } = require('../../dist-electron/extension-host/vscode-api/primitives.js');
const { UtilityProcessExtensionHost } = require('../../dist-electron/extensions/infrastructure/hosts/utility-process-host.js');
const { createFakeLauncher, createFakeTimers, flush } = require('./helpers/rpc-harness.cjs');

const settle = async () => { for (let i = 0; i < 12; i++) await flush(); };
function manualTimers() {
  const pending = new Map(); let next = 0;
  return {
    pending,
    setTimer(callback) { const id = ++next; pending.set(id, callback); return id; },
    clearTimer(id) { pending.delete(id); },
    async tick(wait = true) {
      const callbacks = [...pending.values()]; pending.clear();
      const jobs = callbacks.map(callback => callback());
      if (wait) await Promise.all(jobs);
      await settle();
    },
  };
}
function memoryFs(root = '/w') {
  const entries = new Map([[root, { type: 2, mtime: 1 }]]);
  const calls = [];
  const port = {
    realpath: async uri => uri,
    stat: async uri => {
      calls.push(['stat', uri]);
      const entry = entries.get(uri);
      if (!entry) throw new ExtensionFileSystemError('FileNotFound', uri);
      return { ctime: 1, size: 1, ...entry };
    },
    readDirectory: async uri => {
      calls.push(['readDirectory', uri]);
      return [...entries].filter(([candidate]) => candidate.startsWith(uri + '/')
        && !candidate.slice(uri.length + 1).includes('/'))
        .map(([candidate, entry]) => ({ name: candidate.slice(uri.length + 1), type: entry.type }));
    },
  };
  return { port, entries, calls };
}
function serviceFor(port, overrides = {}) {
  const timers = manualTimers(); const events = []; const warnings = [];
  const workspace = overrides.workspace ?? '/w';
  const access = new ExtensionFileSystem({ fs: port, scopesFor: () => ({ workspace,
    extensionDir: '/extension', storagePaths: ['/storage'] }) });
  const service = new WorkspaceFilesService({ fs: port, access, workspace: () => workspace,
    ...timers, emit: (owner, event) => events.push({ owner, ...event }), warn: message => warnings.push(message),
    ...overrides, workspace: () => workspace });
  return { service, timers, events, warnings, access };
}

test('glob supports root/nested **, braces, ?, character classes and literal regex characters', () => {
  const glob = compileWorkspaceGlob('**/*.{ts,js}');
  assert(glob.test('a.ts')); assert(glob.test('src/a.js')); assert(!glob.test('a.css'));
  assert(compileWorkspaceGlob('src/[a-c]?.ts').test('src/b1.ts'));
  assert(!compileWorkspaceGlob('src/[!a-c]?.ts').test('src/b1.ts'));
  assert(compileWorkspaceGlob('a(1).txt').test('a(1).txt'));
  assert(!compileWorkspaceGlob('a(1).txt').test('a1.txt'));
  assert(!compileWorkspaceGlob('*a'.repeat(24) + 'b').test('a'.repeat(36)), 'adversarial glob completes without regex backtracking');
  for (const pattern of ['../secret', '/etc/*', '{a,b', '**/'.repeat(100), '[broken']) {
    assert.throws(() => compileWorkspaceGlob(pattern), err => err.code === 'INVALID_PAYLOAD');
  }
});

test('findFiles includes only files, excludes/prunes directories, and applies maxResults', async () => {
  const { port, entries, calls } = memoryFs();
  entries.set('/w/root.ts', { type: 1 }); entries.set('/w/src', { type: 2 });
  entries.set('/w/src/a.js', { type: 1 }); entries.set('/w/src/other.css', { type: 1 });
  entries.set('/w/skip', { type: 2 }); entries.set('/w/skip/a.ts', { type: 1 });
  const { service } = serviceFor(port);
  const result = await service.handle('a', 'find', { id: 'one', include: '**/*.{ts,js}', exclude: '**/skip/**' });
  assert.deepEqual(result.uris, ['/w/root.ts', '/w/src/a.js']);
  assert(!calls.some(([op, uri]) => op === 'readDirectory' && uri === '/w/skip'));
  assert.equal((await service.handle('a', 'find', { id: 'two', include: '**/*', maxResults: 1 })).uris.length, 1);
  assert.deepEqual((await service.handle('a', 'find', { id: 'zero', include: '**/*', maxResults: 0 })).uris, []);
  await assert.rejects(service.handle('a', 'find', { id: 'bad', include: '**/*', maxResults: -1 }), /maxResults/);
});

test('undefined excludes honor files.exclude, null disables them, explicit replaces them', async () => {
  const { port, entries } = memoryFs();
  entries.set('/w/a.txt', { type: 1 }); entries.set('/w/b.txt', { type: 1 });
  const { service } = serviceFor(port, { configuration: () => ({ 'files.exclude': { 'a.txt': true, 'b.txt': false } }) });
  const run = (id, rest = {}) => service.handle('a', 'find', { id, include: '*.txt', ...rest });
  assert.deepEqual((await run('a')).uris, ['/w/b.txt']);
  assert.deepEqual((await run('b', { exclude: null })).uris, ['/w/a.txt', '/w/b.txt']);
  assert.deepEqual((await run('c', { exclude: 'b.txt' })).uris, ['/w/a.txt']);
});

test('RelativePattern searches from its base and rejects outside roots, traversal and sibling prefix', async () => {
  const { port, entries, calls } = memoryFs();
  entries.set('/w/src', { type: 2 }); entries.set('/w/src/a.ts', { type: 1 });
  const { service } = serviceFor(port);
  assert.deepEqual((await service.handle('a', 'find', { id: 'a', include: { base: '/w/src', pattern: '*.ts' } })).uris, ['/w/src/a.ts']);
  for (const base of ['/w-else', '/w/../etc', '/extension', '/storage']) {
    await assert.rejects(service.handle('a', 'find', { id: base, include: { base, pattern: '**/*' } }), err => err.code === 'NoPermissions');
  }
  assert(!calls.some(([op, uri]) => op === 'readDirectory' && uri === '/etc'));
});

test('search without a workspace returns no matches', async () => {
  const { port } = memoryFs(); const access = new ExtensionFileSystem({ fs: port, scopesFor: () => ({ workspace: null, extensionDir: '', storagePaths: [] }) });
  const service = new WorkspaceFilesService({ fs: port, access, workspace: () => null, emit() {} });
  assert.deepEqual(await service.handle('a', 'find', { id: 'a', include: '**/*' }), { uris: [] });
});

test('watcher baseline is silent, diffs create/change/delete, and ignores selected event kinds', async () => {
  const { port, entries } = memoryFs(); entries.set('/w/a.txt', { type: 1, mtime: 1 });
  const { service, timers, events } = serviceFor(port);
  await service.handle('a', 'watch', { id: 'all', glob: '**/*.txt' });
  await service.handle('b', 'watch', { id: 'all', glob: '**/*.txt', ignorecreate: true, ignoredelete: true });
  assert.deepEqual(events, []);
  entries.set('/w/b.txt', { type: 1, mtime: 1 }); await timers.tick();
  entries.set('/w/a.txt', { type: 1, mtime: 2 }); await timers.tick();
  entries.delete('/w/b.txt'); await timers.tick();
  assert.deepEqual(events.map(e => [e.owner, e.kind, e.uri]), [
    ['a', 'create', '/w/b.txt'], ['a', 'change', '/w/a.txt'], ['b', 'change', '/w/a.txt'], ['a', 'delete', '/w/b.txt'],
  ]);
  service.dispose(); assert.equal(timers.pending.size, 0);
});

test('directories emit watcher events while findFiles excludes them', async () => {
  const { port, entries } = memoryFs(); const { service, timers, events } = serviceFor(port);
  await service.handle('a', 'watch', { id: 'a', glob: '**/*' });
  entries.set('/w/folder', { type: 2, mtime: 1 }); await timers.tick();
  assert.equal(events[0].uri, '/w/folder');
  assert.deepEqual((await service.handle('a', 'find', { id: 'a', include: '**/*' })).uris, []);
  service.dispose();
});

test('disposing one owner leaves another owner watcher active and no future IO for disposed owner', async () => {
  const { port, entries } = memoryFs(); const { service, timers, events } = serviceFor(port);
  await service.handle('a', 'watch', { id: 'same', glob: '*.txt' });
  await service.handle('b', 'watch', { id: 'same', glob: '*.txt' });
  service.disposeOwner('a'); assert.equal(timers.pending.size, 1);
  // Cross-owner unwatch cannot remove b's resource.
  await service.handle('a', 'unwatch', { id: 'same' });
  entries.set('/w/new.txt', { type: 1 }); await timers.tick();
  assert.deepEqual(events.map(e => e.owner), ['b']);
  service.dispose(); assert.equal(timers.pending.size, 0);
});

test('pending registration cannot resurrect a timer after owner disposal', async () => {
  const { port } = memoryFs(); let release;
  const original = port.realpath; port.realpath = uri => new Promise(resolve => { release = () => resolve(uri); });
  const { service, timers } = serviceFor(port);
  const pending = service.handle('a', 'watch', { id: 'a', glob: '**/*' });
  service.disposeOwner('a'); port.realpath = original; release();
  await assert.rejects(pending, err => err.code === 'CANCELLED');
  assert.equal(timers.pending.size, 0);
});

test('generation cleanup frees search IDs immediately while old IO is still pending', async () => {
  const { port } = memoryFs(); let release;
  const realpath = port.realpath;
  port.realpath = uri => new Promise(resolve => { release = () => resolve(uri); });
  const { service } = serviceFor(port);
  const old = service.handle('a', 'find', { id: 'find-1', include: '**/*' });
  service.dispose(); port.realpath = realpath;
  assert.deepEqual((await service.handle('a', 'find', { id: 'find-1', include: '**/*' })).uris, []);
  release(); await assert.rejects(old, err => err.code === 'CANCELLED');
});

test('bounded scans fail explicitly instead of returning incomplete results', async () => {
  const { port, entries } = memoryFs();
  for (let i = 0; i < 3; i++) entries.set(`/w/${i}.txt`, { type: 1 });
  await assert.rejects(scanWorkspaceFiles({ fs: port, root: '/w', include: { pattern: '*.txt' },
    excludes: [], authorise: async uri => uri, cancelled: () => false, maxEntries: 2 }),
    err => err.code === 'Unavailable');
});

test('search cancellation stops traversal after current IO and is isolated by owner', async () => {
  const { port, entries, calls } = memoryFs(); entries.set('/w/dir', { type: 2 }); entries.set('/w/dir/a.txt', { type: 1 });
  const read = port.readDirectory; let release;
  port.readDirectory = async uri => { if (uri === '/w') await new Promise(resolve => { release = resolve; }); return read(uri); };
  const { service } = serviceFor(port);
  const pending = service.handle('a', 'find', { id: 'a', include: '**/*' });
  await settle(); assert(release);
  await service.handle('b', 'cancel', { id: 'a' });
  await service.handle('a', 'cancel', { id: 'a' }); release();
  await assert.rejects(pending, err => err.code === 'CANCELLED');
  assert(!calls.some(([op, uri]) => op === 'readDirectory' && uri === '/w/dir'));
});

test('polling failure preserves last complete snapshot and never overlaps polls', async () => {
  const { port, entries } = memoryFs(); entries.set('/w/a.txt', { type: 1 });
  const { service, timers, events, warnings } = serviceFor(port);
  await service.handle('a', 'watch', { id: 'a', glob: '*.txt' });
  const read = port.readDirectory; let release;
  port.readDirectory = () => new Promise((_, reject) => { release = () => reject(new ExtensionFileSystemError('Unavailable', 'offline')); });
  await timers.tick(false); assert.equal(timers.pending.size, 0, 'no next timer during IO');
  release(); await settle(); assert.equal(timers.pending.size, 1); assert.equal(warnings.length, 1); assert.deepEqual(events, []);
  port.readDirectory = read; await timers.tick(); assert.deepEqual(events, []);
  service.dispose();
});

test('deleting watched root emits deletes and recreating it emits creates', async () => {
  const { port, entries } = memoryFs(); entries.set('/w/a.txt', { type: 1 });
  const { service, timers, events } = serviceFor(port);
  await service.handle('a', 'watch', { id: 'a', glob: '*.txt' });
  entries.delete('/w'); entries.delete('/w/a.txt'); await timers.tick();
  entries.set('/w', { type: 2 }); entries.set('/w/a.txt', { type: 1 }); await timers.tick();
  assert.deepEqual(events.map(e => e.kind), ['delete', 'create']); service.dispose();
});

test('real local filesystem skips symlinks, retains strange names, and blocks a missing child via symlink parent', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-file-watch-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'workspace'); const outside = path.join(temp, 'outside'); fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'escape')); fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'));
  fs.symlinkSync(path.join(outside, 'missing.txt'), path.join(root, 'dangling.txt'));
  const strange = "quote' dollar$ newline\n tail .txt"; fs.writeFileSync(path.join(root, strange), 'safe');
  const adapter = new NodeExtensionFileSystem(); const { service, access, timers, events } = serviceFor(adapter, { workspace: root });
  assert.deepEqual((await service.handle('a', 'find', { id: 'a', include: '**/*.txt' })).uris, [path.join(root, strange)]);
  await assert.rejects(access.handle('a', 'writeFile', { uri: path.join(root, 'escape', 'new.txt'), content: 'eA==' }), err => err.code === 'NoPermissions');
  assert(!fs.existsSync(path.join(outside, 'new.txt')));
  await assert.rejects(access.handle('a', 'writeFile', { uri: path.join(root, 'dangling.txt'), content: 'eA==' }), err => err.code === 'NoPermissions');
  assert(!fs.existsSync(path.join(outside, 'missing.txt')));
  await service.handle('a', 'watch', { id: 'local', glob: '*.txt' });
  fs.appendFileSync(path.join(root, strange), ' changed'); await timers.tick();
  fs.writeFileSync(path.join(root, 'new.txt'), 'new'); await timers.tick();
  fs.unlinkSync(path.join(root, 'new.txt')); await timers.tick();
  assert.deepEqual(events.map(event => event.kind), ['change', 'create', 'delete']);
  service.dispose(); assert.equal(timers.pending.size, 0);
  const alias = path.join(temp, 'alias'); fs.symlinkSync(root, alias);
  const viaAlias = serviceFor(adapter, { workspace: alias });
  assert.deepEqual((await viaAlias.service.handle('a', 'find', { id: 'alias', include: '*.txt' })).uris, [path.join(root, strange)]);
});

test('malformed provider names and canonical escapes are never statted or traversed', async () => {
  const { port, calls } = memoryFs();
  port.readDirectory = async () => [{ name: '../secret', type: 2 }, { name: 'back\\slash', type: 2 }, { name: 'link', type: 2 }];
  port.realpath = async uri => uri.endsWith('/link') ? '/etc' : uri;
  const { service } = serviceFor(port);
  assert.deepEqual((await service.handle('a', 'find', { id: 'a', include: '**/*' })).uris, []);
  assert(!calls.some(([, uri]) => uri === '/etc' || uri.includes('secret')));
});

test('SSH traverses injected bridge, preserves authority and names, and skips remote symlinks', async () => {
  const root = 'ssh://dev%40host/work'; const { port, entries } = memoryFs(root);
  const name = "a' $x\n%.txt"; const uri = joinResource(root, name); entries.set(uri, { type: 1 });
  entries.set(root + '/link', { type: 64 }); entries.set(root + '/dir', { type: 2 }); entries.set(root + '/dir/a.txt', { type: 1 });
  const readDirectory = port.readDirectory;
  port.readDirectory = async target => (await readDirectory(target)).map(entry => ({ ...entry, name: decodeURI(entry.name) }));
  const adapter = new NodeExtensionFileSystem({ remote: { isRemote: uri => uri.startsWith('ssh://'), ...port } });
  const { service, timers, events } = serviceFor(adapter, { workspace: root });
  assert.deepEqual((await service.handle('a', 'find', { id: 'a', include: '**/*.txt' })).uris, [uri, root + '/dir/a.txt']);
  assert.deepEqual((await service.handle('a', 'find', { id: 'literal', include: name })).uris, [uri]);
  const revived = resourceUri(uri); assert.equal(revived.scheme, 'ssh'); assert.equal(revived.authority, 'dev@host'); assert.equal(revived.path, '/work/' + name); assert.equal(resourcePath(revived), uri);
  await service.handle('a', 'watch', { id: 'a', glob: '*.txt' });
  entries.set(uri, { type: 1, mtime: 3 }); await timers.tick(); assert.equal(events[0].uri, uri); service.dispose();
});

test('remote traversal without bridge or canonicalization fails Unavailable rather than local fallback', async () => {
  const root = 'ssh://host/work';
  for (const adapter of [new NodeExtensionFileSystem(), new NodeExtensionFileSystem({ remote: { isRemote: () => true } }),
    new NodeExtensionFileSystem({ remote: { isRemote: () => false } })]) {
    const { service } = serviceFor(adapter, { workspace: root });
    await assert.rejects(service.handle('a', 'find', { id: 'a', include: '**/*' }), err => err.code === 'Unavailable');
  }
});

test('host facade serializes RelativePattern and rebuilds real local and remote Uri objects', async () => {
  const sent = []; const files = new HostWorkspaceFiles({ request: async (op, body) => { sent.push([op, body]); return { uris: ['/w/a.txt', 'ssh://dev%40host/work/a.txt'] }; }, warn() {} });
  const pattern = new RelativePattern({ uri: Uri.file('/w/src') }, '*.txt');
  assert.equal(pattern.base, '/w/src');
  const answer = await files.findFiles(pattern, null, 5);
  assert.deepEqual(sent[0], ['find', { id: 'find-1', include: { base: '/w/src', pattern: '*.txt' }, exclude: null, maxResults: 5 }]);
  assert(answer.every(uri => uri instanceof Uri)); assert.equal(answer[1].scheme, 'ssh');
  pattern.base = '/w/next'; assert.equal(pattern.baseUri.fsPath, '/w/next'); await files.dispose();
});

test('host cancellation rejects promptly before main IO completes and disposes token listeners', async () => {
  const sent = []; let finish;
  const files = new HostWorkspaceFiles({ request: (op, body) => { sent.push([op, body]); return op === 'find' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({}); }, warn() {} });
  const source = new CancellationTokenSource();
  const pending = files.findFiles('**/*', undefined, undefined, source.token); source.cancel();
  await assert.rejects(pending, err => err instanceof CancellationError);
  assert.deepEqual(sent.map(([op]) => op), ['find', 'cancel']); finish({ uris: ['/late'] }); await settle();
  await assert.rejects(files.findFiles('**/*', undefined, undefined, source.token), err => err instanceof CancellationError);
  assert.equal(sent.length, 2); await files.dispose(); source.dispose();
  await assert.rejects(files.findFiles('**/*'), err => err instanceof CancellationError);
  assert.throws(() => files.createFileSystemWatcher('*'), err => err instanceof CancellationError);
});

test('host watcher ignores requested events, disposes idempotently and drops stale events', async () => {
  const sent = []; const seen = [];
  const files = new HostWorkspaceFiles({ request: async (op, body) => { sent.push([op, body]); return {}; }, warn() {} });
  const watcher = files.createFileSystemWatcher('*.txt', true);
  watcher.onDidCreate(uri => seen.push(['create', uri])); watcher.onDidChange(uri => seen.push(['change', uri]));
  files.accept({ id: watcher.id, kind: 'create', uri: '/w/a.txt' }); files.accept({ id: watcher.id, kind: 'change', uri: '/w/a.txt' });
  assert.equal(seen.length, 1); assert(seen[0][1] instanceof Uri); assert.equal(watcher.ignoreCreateEvents, true);
  watcher.dispose(); watcher.dispose(); files.accept({ id: watcher.id, kind: 'change', uri: '/w/a.txt' });
  assert.equal(seen.length, 1); assert.equal(sent.filter(([op]) => op === 'unwatch').length, 1); await files.dispose();
});

test('host synchronous watcher registration failure is reported without an unhandled rejection', async () => {
  const warnings = []; const files = new HostWorkspaceFiles({ request: async op => { if (op === 'watch') throw new Error('denied'); return {}; }, warn: msg => warnings.push(msg) });
  const watcher = files.createFileSystemWatcher('*.txt'); let count = 0; watcher.onDidCreate(() => count++);
  await settle(); files.accept({ id: watcher.id, kind: 'create', uri: '/w/a.txt' });
  assert.equal(count, 0); assert.match(warnings[0], /denied/); await files.dispose();
});

function fullHost(configuration = {}) {
  const clock = createFakeTimers(); const launcher = createFakeLauncher(clock); const { port, entries } = memoryFs();
  let host;
  const setup = serviceFor(port, { emit: (owner, event) => { void host.request('workspace.files.changed', event, { extensionId: owner }); } });
  host = new UtilityProcessExtensionHost({ launcher, timers: clock, warn() {},
    initialize: () => ({ apiVersion: '1.90.0', workspace: '/w', trust: true, configuration,
      extensions: [{ id: 'forge-tests.watching', version: '1.0.0', dir: path.resolve(__dirname, '../fixtures/extensions/host/watching'), main: './extension.cjs', globalStoragePath: '/storage', workspaceStoragePath: null, extensionMode: 'test' }] }),
    onRequest: envelope => setup.service.handle(envelope.extensionId, envelope.method.slice('workspace.files.'.length), envelope.payload),
  });
  host.onEvent(event => { if (event.type === 'state' && event.state.status !== 'running') setup.service.dispose(); });
  return { ...setup, host, launcher, entries };
}

test('real fixture watches and searches over RPC; deactivate releases forgotten watcher despite hook throwing', async () => {
  const { host, timers, events, entries } = fullHost();
  try {
    await host.start(); await host.request('lifecycle.activate', { id: 'forge-tests.watching' }); await settle();
    assert.equal(timers.pending.size, 1);
    entries.set('/w/new.txt', { type: 1 }); await timers.tick();
    const observed = await host.request('commands.execute', { command: 'watching.events' });
    assert.deepEqual(observed.result, [['create', 'file:///w/new.txt']]);
    const found = await host.request('commands.execute', { command: 'watching.find' });
    assert.equal(found.result[0].fsPath, '/w/new.txt');
    await host.request('lifecycle.deactivate', { id: 'forge-tests.watching' });
    assert.equal(timers.pending.size, 0);
    entries.set('/w/after.txt', { type: 1 }); await timers.tick(); assert.deepEqual(events, []);
    await host.request('lifecycle.activate', { id: 'forge-tests.watching' }); await settle();
    assert.equal(timers.pending.size, 1, 'same-generation reactivation starts with fresh watchers');
  } finally { await host.stop(); }
});

test('failed activation cleans pending watcher registrations through complete protocol', async () => {
  const { host, timers } = fullHost({ 'watching.fail': true });
  try {
    await host.start(); await assert.rejects(host.request('lifecycle.activate', { id: 'forge-tests.watching' }), err => err.code === 'ACTIVATION_FAILED');
    await settle(); assert.equal(timers.pending.size, 0);
  } finally { await host.stop(); }
});

test('restart and stop clean main-side resources and generations cannot send stale events', async () => {
  const { host, timers, launcher } = fullHost();
  try {
    await host.start(); await host.request('lifecycle.activate', { id: 'forge-tests.watching' }); await settle(); assert.equal(timers.pending.size, 1);
    const old = launcher.latest(); await host.restart(); assert(old.killed); assert.equal(timers.pending.size, 0);
    await host.request('lifecycle.activate', { id: 'forge-tests.watching' }); await settle(); assert.equal(timers.pending.size, 1);
    launcher.latest().exit(1); assert.equal(timers.pending.size, 0, 'crash also releases resources');
  } finally { await host.stop(); assert.equal(timers.pending.size, 0); }
});
