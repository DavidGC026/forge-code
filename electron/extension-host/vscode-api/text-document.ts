/**
 * `vscode.TextDocument`, host side.
 *
 * Built over a plain string that main mirrors from the renderer. Everything
 * an extension asks — `getText`, `lineAt`, `offsetAt`, `positionAt` — is
 * computed here, in the host, because those are the calls that happen in
 * loops: making them round-trips would turn a linter over a 2000-line file
 * into 2000 IPC calls.
 *
 * The line index is computed once per content change and cached. That is
 * the whole reason this class exists instead of a plain object.
 */
import { Position, Range, Uri } from './primitives';

export interface TextLine {
  lineNumber: number;
  text: string;
  range: Range;
  rangeIncludingLineBreak: Range;
  firstNonWhitespaceCharacterIndex: number;
  isEmptyOrWhitespace: boolean;
}

export interface TextDocumentState {
  /** Absolute path or remote URI, as main knows it. */
  uri: string;
  languageId: string;
  version: number;
  content: string;
  isDirty: boolean;
  isClosed?: boolean;
}

export class TextDocument {
  private state: TextDocumentState;
  /** Start offset of each line. Rebuilt on content change, not per call. */
  private lineStarts: number[];
  private readonly onSave: ((document: TextDocument) => Promise<boolean>) | null;

  constructor(
    state: TextDocumentState,
    onSave?: (document: TextDocument) => Promise<boolean>,
  ) {
    this.state = state;
    this.lineStarts = computeLineStarts(state.content);
    this.onSave = onSave ?? null;
  }

  /** Applies a new revision from main. Same object, new content: extensions
   *  hold on to the document they were handed, and swapping it for another
   *  instance would silently freeze their view. */
  update(state: Partial<TextDocumentState>): void {
    const next = { ...this.state, ...state };
    if (next.content !== this.state.content) {
      this.lineStarts = computeLineStarts(next.content);
    }
    this.state = next;
  }

  get uri(): Uri {
    return Uri.file(this.state.uri);
  }

  get fileName(): string {
    return this.state.uri;
  }

  get languageId(): string {
    return this.state.languageId;
  }

  get version(): number {
    return this.state.version;
  }

  get isDirty(): boolean {
    return this.state.isDirty;
  }

  get isClosed(): boolean {
    return this.state.isClosed === true;
  }

  get isUntitled(): boolean {
    return this.state.uri.startsWith('untitled:');
  }

  get eol(): number {
    // 1 = LF, 2 = CRLF, matching `vscode.EndOfLine`.
    return this.state.content.includes('\r\n') ? 2 : 1;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  getText(range?: Range): string {
    if (!range) return this.state.content;
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    return this.state.content.slice(start, end);
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const lineNumber = typeof lineOrPosition === 'number'
      ? lineOrPosition
      : lineOrPosition.line;
    const clamped = Math.min(Math.max(0, Math.floor(lineNumber)), this.lineCount - 1);

    const start = this.lineStarts[clamped];
    const nextStart = clamped + 1 < this.lineStarts.length
      ? this.lineStarts[clamped + 1]
      : this.state.content.length;

    // The stored text excludes the line break; the "including" range does not.
    const raw = this.state.content.slice(start, nextStart);
    const text = raw.replace(/\r?\n$/, '');
    const firstNonWhitespace = text.search(/\S/);

    return {
      lineNumber: clamped,
      text,
      range: new Range(clamped, 0, clamped, text.length),
      rangeIncludingLineBreak: new Range(clamped, 0, clamped, raw.length),
      firstNonWhitespaceCharacterIndex: firstNonWhitespace === -1 ? text.length : firstNonWhitespace,
      isEmptyOrWhitespace: firstNonWhitespace === -1,
    };
  }

  offsetAt(position: Position): number {
    const line = Math.min(Math.max(0, position.line), this.lineCount - 1);
    const start = this.lineStarts[line];
    const nextStart = line + 1 < this.lineStarts.length
      ? this.lineStarts[line + 1]
      : this.state.content.length;
    // Clamped to the line: a character past its end must not spill into the
    // next one, which is how off-by-one bugs in extensions corrupt edits.
    const lineLength = Math.max(0, nextStart - start - lineBreakLength(this.state.content, nextStart));
    return start + Math.min(position.character, lineLength);
  }

  positionAt(offset: number): Position {
    const target = Math.min(Math.max(0, Math.floor(offset) || 0), this.state.content.length);
    // Binary search: `positionAt` is called per diagnostic, per match, per
    // token — linear scanning shows up immediately on a large file.
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] > target) high = middle - 1;
      else low = middle;
    }
    return new Position(low, target - this.lineStarts[low]);
  }

  validateRange(range: Range): Range {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  validatePosition(position: Position): Position {
    return this.positionAt(this.offsetAt(position));
  }

  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
    const line = this.lineAt(position.line);
    const pattern = regex ?? /[A-Za-z_$][\w$]*/g;
    const search = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

    for (let match = search.exec(line.text); match; match = search.exec(line.text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return new Range(position.line, start, position.line, end);
      }
      // A zero-length match would loop forever on the same index.
      if (match[0].length === 0) search.lastIndex += 1;
    }
    return undefined;
  }

  save(): Promise<boolean> {
    return this.onSave ? this.onSave(this) : Promise.resolve(false);
  }
}

/** Offsets where each line begins. A document always has at least one line,
 *  even when empty — that is what makes `lineCount` never zero. */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Length of the line break that precedes `offset` (0, 1 or 2). */
function lineBreakLength(content: string, offset: number): number {
  if (offset <= 0 || offset > content.length) return 0;
  if (content[offset - 1] !== '\n') return 0;
  return offset >= 2 && content[offset - 2] === '\r' ? 2 : 1;
}
