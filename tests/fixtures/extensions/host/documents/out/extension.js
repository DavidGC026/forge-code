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

function snapshot() {
  return {
    documents: vscode.workspace.textDocuments.map(doc => ({
      fileName: doc.fileName, content: doc.getText(), version: doc.version,
    })),
    active: vscode.window.activeTextEditor?.document.fileName ?? null,
    visible: vscode.window.visibleTextEditors.map(editor => editor.document.fileName),
  };
}

module.exports = { activate, trace, snapshot };
