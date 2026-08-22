'use strict';
// Never returns control: `activate` awaits a promise nobody resolves. The
// timeout is the guarantee here, not the extension's cooperation.
function activate() {
  return new Promise(() => {});
}

module.exports = { activate };
