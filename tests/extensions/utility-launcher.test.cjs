const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function fixture(env) {
  const filename = path.resolve(__dirname, '../../dist-electron/extensions/infrastructure/hosts/utility-process-host.js');
  const realRequire = createRequire(filename);
  const child = Object.assign(new EventEmitter(), { postMessage() {}, kill() {} });
  let forkOptions;
  class Port extends EventEmitter {
    start() {}
    postMessage() {}
    close() {}
  }
  const electron = {
    MessageChannelMain: class { port1 = new Port(); port2 = new Port(); },
    utilityProcess: {
      fork(_entry, _args, options) {
        // Electron validates optional fields by presence, before spawning.
        if ('env' in options && (!options.env || typeof options.env !== 'object')) {
          throw new TypeError('Invalid value for env');
        }
        forkOptions = options;
        return child;
      },
    },
  };
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require, module, exports) {${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  load((id) => id === 'electron' ? electron : realRequire(id), module, module.exports);
  const launcher = module.exports.createUtilityProcessLauncher({ entryPoint: '/host/bootstrap.js', env });
  return { launcher, options: () => forkOptions };
}

test('launcher inherits environment by omitting env when no override is supplied', () => {
  const { launcher, options } = fixture();
  const handle = launcher.spawn(1);
  assert.equal('env' in options(), false);
  assert.equal(options().serviceName, 'forge-extension-host-1');
  handle.transport.close();
  handle.kill();
});

test('launcher forwards an explicit environment override to Electron', () => {
  const env = { FORGE_HOST_TEST: '1' };
  const { launcher, options } = fixture(env);
  const handle = launcher.spawn(2);
  assert.equal(options().env, env);
  handle.kill();
});
