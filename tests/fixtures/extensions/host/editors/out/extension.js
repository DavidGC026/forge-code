'use strict';
// Reads the caret and follows the focus, which is what an extension that
// acts on "what the user is looking at" does.
const vscode = require('vscode');

const trace = [];

function activate(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      trace.push(`active:${editor ? editor.document.fileName : 'none'}`);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const { active } = event.selections[0];
      trace.push(`selection:${event.textEditor.document.fileName}:${active.line}:${active.character}`);
    }),
  );

  return { trace, initial: vscode.window.activeTextEditor?.document.fileName ?? null };
}

/** Called by the test through a command-free path: the fixture exposes it. */
function readSelectedText() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  return editor.document.getText(editor.selection);
}

module.exports = { activate, trace, readSelectedText };
