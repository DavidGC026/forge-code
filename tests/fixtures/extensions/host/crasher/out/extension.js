'use strict';
// Takes the whole process down, the way a native crash or an OOM would.
// Forge must survive this: only the host generation dies.
function activate() {
  process.exit(7);
}

module.exports = { activate };
