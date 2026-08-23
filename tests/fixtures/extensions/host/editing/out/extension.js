'use strict';
// A refactor across two files, the way an extension writes it: build one
// WorkspaceEdit and apply it whole.
const vscode = require('vscode');

async function activate() {
  return { ready: true };
}

/** Renames `viejo` to `nuevo` in both files. */
async function renameAcrossFiles(uris) {
  const edit = new vscode.WorkspaceEdit();
  for (const uri of uris) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    let index = text.indexOf('viejo');
    while (index !== -1) {
      const start = doc.positionAt(index);
      const end = doc.positionAt(index + 'viejo'.length);
      edit.replace(doc.uri, new vscode.Range(start, end), 'nuevo');
      index = text.indexOf('viejo', index + 1);
    }
  }
  return vscode.workspace.applyEdit(edit);
}

/** Two edits over the same span: must be refused, not merged. */
async function overlappingEdit(uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, 0, 5), 'uno');
  edit.replace(doc.uri, new vscode.Range(0, 3, 0, 8), 'dos');
  return vscode.workspace.applyEdit(edit);
}

module.exports = { activate, renameAcrossFiles, overlappingEdit };
