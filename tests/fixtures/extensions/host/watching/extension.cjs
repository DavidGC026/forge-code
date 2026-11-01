const vscode = require('vscode');
exports.activate = () => {
  const events = [];
  // Deliberately omitted from context.subscriptions: Forge must own it.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.txt');
  watcher.onDidCreate(uri => events.push(['create', uri.toString()]));
  watcher.onDidChange(uri => events.push(['change', uri.toString()]));
  watcher.onDidDelete(uri => events.push(['delete', uri.toString()]));
  vscode.commands.registerCommand('watching.events', () => events.slice());
  vscode.commands.registerCommand('watching.find', () => vscode.workspace.findFiles('**/*.txt'));
  if (vscode.workspace.getConfiguration('watching').get('fail')) throw new Error('failed after watcher');
};
exports.deactivate = () => { throw new Error('cleanup must still run'); };
