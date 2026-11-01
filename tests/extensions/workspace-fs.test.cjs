'use strict';

// `workspace.fs`: the policy that decides what an extension may touch, the
// adapter that touches it, and the round trip through a real fixture.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkFileAccess,
  isInside,
} = require('../../dist-electron/extensions/domain/file-access.js');
const {
  ExtensionFileSystem,
  ExtensionFileSystemError,
} = require('../../dist-electron/extensions/application/extension-file-system.js');
const {
  NodeExtensionFileSystem,
} = require('../../dist-electron/extensions/infrastructure/node-extension-file-system.js');
const {
  createFileSystemApi,
  toFileSystemError,
} = require('../../dist-electron/extension-host/vscode-api/workspace-fs.js');

// ── Policy ──────────────────────────────────────────────────────────────

const scopes = (overrides = {}) => ({
  workspace: '/home/dev/project',
  extensionDir: '/store/acme.demo/1.0.0',
  storagePaths: ['/storage/global/acme.demo', null],
  ...overrides,
});

test('containment needs a separator boundary, not a string prefix', () => {
  assert.equal(isInside('/home/dev/project', '/home/dev/project/src/a.ts'), true);
  assert.equal(isInside('/home/dev/project', '/home/dev/project'), true);
  assert.equal(
    isInside('/home/dev/project', '/home/dev/project-2/secret'),
    false,
    'a sibling whose name starts the same is not inside',
  );
  assert.equal(isInside('/home/dev/project/', '/home/dev/project/a'), true);
  assert.equal(isInside('', '/anything'), false);
});

test('the workspace is readable and writable', () => {
  assert.deepEqual(checkFileAccess('/home/dev/project/src/a.ts', 'read', scopes()), {
    allowed: true,
    scope: 'workspace',
  });
  assert.deepEqual(checkFileAccess('/home/dev/project/out.txt', 'write', scopes()), {
    allowed: true,
    scope: 'workspace',
  });
});

test('an extension may read its own directory but never write to it', () => {
  assert.equal(checkFileAccess('/store/acme.demo/1.0.0/media/i.svg', 'read', scopes()).allowed, true);

  const write = checkFileAccess('/store/acme.demo/1.0.0/out/extension.js', 'write', scopes());
  assert.equal(write.allowed, false);
  assert.equal(write.code, 'NoPermissions');
  assert.match(write.message, /actualización/, 'because an update replaces it wholesale');
});

test('storage is read-write, and a null scope is simply skipped', () => {
  assert.equal(checkFileAccess('/storage/global/acme.demo/state.json', 'write', scopes()).allowed, true);
  assert.equal(
    checkFileAccess('/storage/workspace/other/state.json', 'read', scopes()).allowed,
    false,
  );
});

test('everything else is refused, and the message says why', () => {
  const verdict = checkFileAccess('/etc/passwd', 'read', scopes());

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'NoPermissions');
  assert.match(verdict.message, /fuera del workspace/);

  const noWorkspace = checkFileAccess('/etc/passwd', 'read', scopes({ workspace: null }));
  assert.match(noWorkspace.message, /no hay ningún workspace/);
});

// ── Service ─────────────────────────────────────────────────────────────

function createService({ workspace = '/w', realpath } = {}) {
  const calls = [];
  const refusals = [];
  const service = new ExtensionFileSystem({
    fs: {
      realpath: async (target) => (realpath ? realpath(target) : target),
      stat: async (target) => { calls.push(['stat', target]); return { type: 1, ctime: 0, mtime: 0, size: 3 }; },
      readFile: async (target) => { calls.push(['readFile', target]); return new Uint8Array([1, 2, 3]); },
      writeFile: async (target, data, options) => { calls.push(['writeFile', target, [...data], options]); },
      readDirectory: async (target) => { calls.push(['readDirectory', target]); return [{ name: 'a', type: 1 }]; },
      createDirectory: async (target) => { calls.push(['createDirectory', target]); },
      delete: async (target, options) => { calls.push(['delete', target, options]); },
      rename: async (from, to, options) => { calls.push(['rename', from, to, options]); },
      copy: async (from, to, options) => { calls.push(['copy', from, to, options]); },
    },
    scopesFor: () => ({ workspace, extensionDir: '/store/ext', storagePaths: ['/storage/ext'] }),
    onRefused: (extensionId, target, message) => refusals.push({ extensionId, target, message }),
  });
  return { service, calls, refusals };
}

test('each operation reaches the filesystem with its options', async () => {
  const s = createService();

  await s.service.handle('acme.demo', 'stat', { uri: '/w/a.txt' });
  await s.service.handle('acme.demo', 'readDirectory', { uri: '/w' });
  await s.service.handle('acme.demo', 'createDirectory', { uri: '/w/sub' });
  await s.service.handle('acme.demo', 'delete', { uri: '/w/sub', recursive: true });

  assert.deepEqual(s.calls, [
    ['stat', '/w/a.txt'],
    ['readDirectory', '/w'],
    ['createDirectory', '/w/sub'],
    ['delete', '/w/sub', { recursive: true }],
  ]);
});

test('written bytes survive base64, which is how they cross the wire', async () => {
  const s = createService();

  await s.service.handle('acme.demo', 'writeFile', {
    uri: '/w/a.txt',
    content: Buffer.from('hola').toString('base64'),
  });

  assert.deepEqual(s.calls[0], ['writeFile', '/w/a.txt', [...Buffer.from('hola')], {
    create: true,
    overwrite: true,
  }]);
});

test('a path outside the policy is refused and reported, never executed', async () => {
  const s = createService();

  await assert.rejects(s.service.handle('acme.demo', 'readFile', { uri: '/etc/passwd' }), (err) => {
    assert.ok(err instanceof ExtensionFileSystemError);
    assert.equal(err.code, 'NoPermissions');
    return true;
  });
  assert.deepEqual(s.calls, [], 'the filesystem was never touched');
  assert.equal(s.refusals[0].extensionId, 'acme.demo');
});

test('a symlink out of the workspace is caught: the policy sees the real path', async () => {
  const s = createService({
    realpath: (target) => (target === '/w/link' ? '/etc/shadow' : target),
  });

  await assert.rejects(s.service.handle('acme.demo', 'readFile', { uri: '/w/link' }), (err) => {
    assert.equal(err.code, 'NoPermissions');
    return true;
  });
});

test('rename and copy authorise both ends, so nothing escapes through the target', async () => {
  const s = createService();

  await s.service.handle('acme.demo', 'rename', { uri: '/w/a.txt', target: '/w/b.txt' });
  assert.deepEqual(s.calls.at(-1), ['rename', '/w/a.txt', '/w/b.txt', { overwrite: false }]);

  await assert.rejects(
    s.service.handle('acme.demo', 'copy', { uri: '/w/a.txt', target: '/tmp/exfiltrado' }),
    (err) => {
      assert.equal(err.code, 'NoPermissions');
      return true;
    },
  );
});

test('an unknown operation is UNSUPPORTED_API, and an empty path FileNotFound', async () => {
  const s = createService();

  await assert.rejects(s.service.handle('acme.demo', 'watch', {}), (err) => {
    assert.equal(err.code, 'UNSUPPORTED_API');
    return true;
  });
  await assert.rejects(s.service.handle('acme.demo', 'stat', {}), (err) => {
    assert.equal(err.code, 'FileNotFound');
    return true;
  });
});

// ── Adapter ─────────────────────────────────────────────────────────────

function workspaceDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the node adapter round-trips a file and lists a directory', async (t) => {
  const root = workspaceDir(t);
  const adapter = new NodeExtensionFileSystem();
  const file = path.join(root, 'sub', 'a.txt');

  await adapter.createDirectory(path.join(root, 'sub'));
  await adapter.writeFile(file, new Uint8Array(Buffer.from('hola')), {
    create: true,
    overwrite: true,
  });

  assert.equal(Buffer.from(await adapter.readFile(file)).toString('utf8'), 'hola');
  assert.equal((await adapter.stat(file)).type, 1);
  assert.deepEqual(await adapter.readDirectory(root), [{ name: 'sub', type: 2 }]);
});

test('node errno becomes the FileSystemError code an extension matches on', async (t) => {
  const root = workspaceDir(t);
  const adapter = new NodeExtensionFileSystem();

  await assert.rejects(adapter.readFile(path.join(root, 'nope')), (err) => {
    assert.equal(err.code, 'FileNotFound');
    return true;
  });

  const file = path.join(root, 'a.txt');
  await adapter.writeFile(file, new Uint8Array(), { create: true, overwrite: true });
  await assert.rejects(
    adapter.writeFile(file, new Uint8Array(), { create: true, overwrite: false }),
    (err) => {
      assert.equal(err.code, 'FileExists');
      return true;
    },
  );

  await assert.rejects(adapter.readDirectory(file), (err) => {
    assert.equal(err.code, 'FileNotADirectory');
    return true;
  });
});

test('a non-empty directory needs recursive, and says so', async (t) => {
  const root = workspaceDir(t);
  const adapter = new NodeExtensionFileSystem();
  await adapter.writeFile(path.join(root, 'a.txt'), new Uint8Array(), {
    create: true,
    overwrite: true,
  });

  await assert.rejects(adapter.delete(root, { recursive: false }), (err) => {
    assert.match(err.message, /recursive/);
    return true;
  });

  await adapter.delete(root, { recursive: true });
  assert.equal(fs.existsSync(root), false);
});

test('a remote uri without a bridge fails typed instead of reading the local disk', async () => {
  const adapter = new NodeExtensionFileSystem();

  await assert.rejects(adapter.readFile('ssh://host/etc/passwd'), (err) => {
    assert.equal(err.code, 'Unavailable');
    return true;
  });
});

test('with a bridge, a remote uri goes through it and never through node fs', async () => {
  const seen = [];
  const adapter = new NodeExtensionFileSystem({
    remote: {
      isRemote: (target) => target.startsWith('ssh://'),
      realpath: async (target) => target,
      stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 2 }),
      readFile: async (target) => { seen.push(target); return new Uint8Array([104, 105]); },
      writeFile: async () => undefined,
      readDirectory: async () => [],
      createDirectory: async () => undefined,
      delete: async () => undefined,
      rename: async () => undefined,
      copy: async () => undefined,
    },
  });

  const bytes = await adapter.readFile('ssh://host/project/a.txt');

  assert.equal(Buffer.from(bytes).toString('utf8'), 'hi');
  assert.deepEqual(seen, ['ssh://host/project/a.txt']);
  assert.equal(
    await adapter.realpath('ssh://host/project/a.txt'),
    'ssh://host/project/a.txt',
    'a remote path is not resolved against the local filesystem',
  );
});

// ── Host facade ─────────────────────────────────────────────────────────

test('the host api sends fsPath, decodes bytes and rebuilds FileSystemError', async () => {
  const sent = [];
  const api = createFileSystemApi(async (operation, payload) => {
    sent.push([operation, payload]);
    if (operation === 'readFile') return { data: Buffer.from('hola').toString('base64') };
    if (operation === 'readDirectory') return { entries: [{ name: 'a.txt', type: 1 }] };
    if (operation === 'stat') {
      throw { code: 'INVALID_PAYLOAD', message: 'no existe', data: { code: 'FileNotFound' } };
    }
    return { ok: true };
  });

  const bytes = await api.readFile('/w/a.txt');
  assert.equal(Buffer.from(bytes).toString('utf8'), 'hola');

  // VS Code returns tuples here, and extensions destructure them.
  assert.deepEqual(await api.readDirectory('/w'), [['a.txt', 1]]);

  await api.writeFile('/w/b.txt', new Uint8Array(Buffer.from('hey')));
  assert.equal(sent.at(-1)[1].content, Buffer.from('hey').toString('base64'));

  await assert.rejects(api.stat('/w/nope'), (err) => {
    assert.equal(err.name, 'FileSystemError');
    assert.equal(err.code, 'FileNotFound');
    return true;
  });
});

test('an unknown error code degrades to Unknown instead of being invented', () => {
  assert.equal(toFileSystemError({ code: 'Nonsense', message: 'x' }).code, 'Unknown');
  assert.equal(toFileSystemError(null).code, 'Unknown');
  assert.equal(toFileSystemError({ data: { code: 'NoPermissions' } }).code, 'NoPermissions');
});
