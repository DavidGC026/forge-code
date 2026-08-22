'use strict';
// Floods diagnostics. The broker must trim it per extension, without
// silencing anybody else's output.
function activate() {
  for (let i = 0; i < 5000; i += 1) {
    console.log(`ruido ${i}`);
  }
}

module.exports = { activate };
