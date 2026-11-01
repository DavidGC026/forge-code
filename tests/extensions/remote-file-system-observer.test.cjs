'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRemoteFileSystemObserver } = require('../../dist-electron/extensions/infrastructure/remote-file-system-observer.js');
const { joinResource } = require('../../dist-electron/extensions/domain/workspace-glob.js');
const exec = promisify(execFile);
const parse = uri => {
  const [, target, filePath] = /^ssh:\/\/([^/]+)(\/.*)$/.exec(uri);
  return { target: decodeURIComponent(target), path: decodeURI(filePath) };
};

test('SSH observer executes quoted GNU commands with newlines, quotes, dollars, percent and trailing spaces', async t => {
  if (process.platform !== 'linux') return t.skip('GNU SSH host contract');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-remote-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "work' $HOME\n "); fs.mkdirSync(folder);
  const name = "file' $(touch INJECTION)\n%.txt "; fs.writeFileSync(path.join(folder, name), 'safe');
  fs.mkdirSync(path.join(folder, 'dir')); fs.symlinkSync('/etc', path.join(folder, 'link'));
  const uri = 'ssh://dev%40host' + encodeURI(folder); const calls = [];
  // Only the transport is replaced: run the production observer's exact
  // shell commands against a synthetic local filesystem, without SSH.
  const observer = createRemoteFileSystemObserver({ parse, run: async (target, command) => {
    calls.push([target, command]);
    const { stdout } = await exec('/bin/sh', ['-c', command], { encoding: 'buffer', cwd: root });
    return stdout;
  } });
  assert.equal(await observer.realpath(uri), uri, 'canonical path preserves trailing whitespace');
  const entries = await observer.readDirectory(uri);
  assert.deepEqual(entries.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'dir', type: 2 }, { name, type: 1 }, { name: 'link', type: 64 },
  ].sort((a, b) => a.name.localeCompare(b.name)));
  const stat = await observer.stat(joinResource(uri, name)); assert.equal(stat.type, 1); assert.equal(stat.size, 4); assert(stat.mtime > 0);
  assert.equal((await observer.stat(joinResource(uri, 'link'))).type, 64);
  assert.equal(await observer.realpath(joinResource(uri, 'link')), 'ssh://dev%40host/etc');
  assert(calls.every(([target]) => target === 'dev@host'));
  assert(!fs.existsSync(path.join(root, 'INJECTION')), 'shell payload remains a literal filename');
});

test('SSH observer rejects malformed/truncated provider output and maps transport failures', async () => {
  const make = output => createRemoteFileSystemObserver({ parse, run: async () => Buffer.from(output) });
  await assert.rejects(make('d\0bad').readDirectory('ssh://host/w'), err => err.code === 'Unavailable');
  await assert.rejects(make('not an absolute path\0').realpath('ssh://host/w'), err => err.code === 'Unavailable');
  await assert.rejects(make('file|oops').stat('ssh://host/w'), err => err.code === 'Unavailable');
  const offline = createRemoteFileSystemObserver({ parse, run: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.realpath('ssh://host/w'), err => err.code === 'Unavailable' && /offline/.test(err.message));
  const neverRun = createRemoteFileSystemObserver({ parse: () => ({ target: 'host', path: '/w\0payload' }), run: async () => { throw new Error('must not run'); } });
  await assert.rejects(neverRun.realpath('ssh://host/w'), err => err.code === 'NoPermissions');
});
