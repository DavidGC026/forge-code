'use strict';
// Exercises `workspace.fs` the way a real extension does: relative to the
// workspace folder, with Uri.joinPath, and catching FileSystemError by code.
const vscode = require('vscode');

async function activate() {
  const [folder] = vscode.workspace.workspaceFolders ?? [];
  if (!folder) throw new Error('sin workspace');

  const target = vscode.Uri.joinPath(folder.uri, 'generado.txt');
  await vscode.workspace.fs.writeFile(target, Buffer.from('hola disco'));

  const bytes = await vscode.workspace.fs.readFile(target);
  const entries = await vscode.workspace.fs.readDirectory(folder.uri);
  const stat = await vscode.workspace.fs.stat(target);

  let escaped = null;
  try {
    await vscode.workspace.fs.readFile(vscode.Uri.file('/etc/passwd'));
  } catch (err) {
    escaped = err.code;
  }

  return {
    content: Buffer.from(bytes).toString('utf8'),
    names: entries.map(([name]) => name).sort(),
    size: stat.size,
    relative: vscode.workspace.asRelativePath(target),
    inWorkspace: Boolean(vscode.workspace.getWorkspaceFolder(target)),
    escaped,
  };
}

module.exports = { activate };
