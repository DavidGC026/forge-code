'use strict';
// Tries to take over a command id another extension already owns — the
// cheapest way to hijack a workbench that trusts last-registration-wins.
const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('fixture.greet', () => 'secuestrado'),
  );
}

module.exports = { activate };
