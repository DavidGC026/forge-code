/**
 * `vscode.WorkspaceEdit`, `vscode.TextEdit` and the `TextEditorEdit` builder.
 *
 * These are containers: extensions build them and hand them back, so the
 * only thing that matters here is that they collect exactly what was asked,
 * in order, and serialise to what main validates.
 *
 * File operations (`createFile`, `deleteFile`, `renameFile`) are **not**
 * implemented in this increment. They throw with an explanation instead of
 * being collected and quietly ignored, which would leave an extension
 * believing it renamed something.
 */
import { Position, Range, Uri } from './primitives';

export class TextEdit {
  readonly range: Range;
  readonly newText: string;

  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }

  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }

  static setEndOfLine(): TextEdit {
    throw new Error('TextEdit.setEndOfLine todavía no está soportado en Forge.');
  }
}

/** Wire shape main validates. */
export interface SerializedTextEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

export function serializeEdit(edit: TextEdit): SerializedTextEdit {
  return {
    startLine: edit.range.start.line,
    startCharacter: edit.range.start.character,
    endLine: edit.range.end.line,
    endCharacter: edit.range.end.character,
    newText: edit.newText,
  };
}

const pathOf = (uri: Uri | string): string => (typeof uri === 'string' ? uri : uri.fsPath);

export class WorkspaceEdit {
  /** Insertion order is preserved: two edits at the same position apply in
   *  the order the extension declared them. */
  private readonly byUri = new Map<string, TextEdit[]>();

  get size(): number {
    return this.byUri.size;
  }

  replace(uri: Uri | string, range: Range, newText: string): void {
    this.push(pathOf(uri), TextEdit.replace(range, newText));
  }

  insert(uri: Uri | string, position: Position, newText: string): void {
    this.push(pathOf(uri), TextEdit.insert(position, newText));
  }

  delete(uri: Uri | string, range: Range): void {
    this.push(pathOf(uri), TextEdit.delete(range));
  }

  has(uri: Uri | string): boolean {
    return this.byUri.has(pathOf(uri));
  }

  set(uri: Uri | string, edits: TextEdit[]): void {
    const key = pathOf(uri);
    if (!edits || edits.length === 0) this.byUri.delete(key);
    else this.byUri.set(key, [...edits]);
  }

  get(uri: Uri | string): TextEdit[] {
    return [...(this.byUri.get(pathOf(uri)) ?? [])];
  }

  entries(): [Uri, TextEdit[]][] {
    return [...this.byUri].map(([uri, edits]) => [Uri.file(uri), [...edits]]);
  }

  createFile(): void {
    throw new Error(
      'WorkspaceEdit.createFile todavía no está soportado en Forge: usa workspace.fs.writeFile.',
    );
  }

  deleteFile(): void {
    throw new Error(
      'WorkspaceEdit.deleteFile todavía no está soportado en Forge: usa workspace.fs.delete.',
    );
  }

  renameFile(): void {
    throw new Error(
      'WorkspaceEdit.renameFile todavía no está soportado en Forge: usa workspace.fs.rename.',
    );
  }

  /** What crosses to main. Versions are attached by the caller, which is the
   *  only side that knows which document revision each edit was built on. */
  serialize(versionOf: (uri: string) => number | null): {
    files: { uri: string; version: number | null; edits: SerializedTextEdit[] }[];
  } {
    return {
      files: [...this.byUri].map(([uri, edits]) => ({
        uri,
        version: versionOf(uri),
        edits: edits.map(serializeEdit),
      })),
    };
  }

  private push(uri: string, edit: TextEdit): void {
    const edits = this.byUri.get(uri);
    if (edits) edits.push(edit);
    else this.byUri.set(uri, [edit]);
  }
}

/**
 * The builder `editor.edit(builder => …)` hands out.
 *
 * VS Code's contract: the callback runs synchronously, the edits are
 * collected and applied as one; using the builder after the callback
 * returned is an error, and saying so beats silently dropping the edit.
 */
export class TextEditorEdit {
  private readonly edits: TextEdit[] = [];
  private closed = false;

  replace(target: Range | Position, newText: string): void {
    this.assertOpen();
    const range = target instanceof Range ? target : new Range(target, target);
    this.edits.push(TextEdit.replace(range, newText));
  }

  insert(position: Position, newText: string): void {
    this.assertOpen();
    this.edits.push(TextEdit.insert(position, newText));
  }

  delete(range: Range): void {
    this.assertOpen();
    this.edits.push(TextEdit.delete(range));
  }

  setEndOfLine(): void {
    this.assertOpen();
    throw new Error('setEndOfLine todavía no está soportado en Forge.');
  }

  /** Closes the builder and returns what it collected. */
  close(): TextEdit[] {
    this.closed = true;
    return [...this.edits];
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        'El editor builder ya se cerró: sólo puede usarse dentro del callback de edit().',
      );
    }
  }
}
