'use strict';
// Watches the user's buffers: what it records is what an extension would
// react to. The trace is what the test asserts on.
const vscode = require('vscode');

const trace = [];

function activate(context) {
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      trace.push(`open:${doc.fileName}:${doc.getText()}`);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      trace.push(`change:${event.document.fileName}:v${event.document.version}:${event.document.getText()}`);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      trace.push(`save:${doc.fileName}:${doc.isDirty ? 'dirty' : 'clean'}`);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      trace.push(`close:${doc.fileName}`);
    }),
  );

  return {
    initial: vscode.workspace.textDocuments.map((doc) => doc.fileName),
    trace,
  };
}

module.exports = { activate, trace };
