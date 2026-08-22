/**
 * Value types of the `vscode` API that carry no workbench behaviour:
 * `Disposable`, `EventEmitter`, `Uri` and cancellation. They are pure data
 * and plain callbacks, so they live entirely inside the host — no RPC, no
 * main-side state — and every extension gets the same implementations
 * (design §4: what is per-extension is the *facade*, not these classes).
 */

export interface DisposableLike {
  dispose(): unknown;
}

/** Same shape VS Code exposes: a class, a `from` combinator and a no-op. */
export class Disposable implements DisposableLike {
  private callOnDispose: (() => unknown) | undefined;

  constructor(callOnDispose: () => unknown) {
    this.callOnDispose = callOnDispose;
  }

  static from(...disposables: DisposableLike[]): Disposable {
    const items = disposables.slice();
    return new Disposable(() => {
      // One failing disposable must not strand the rest: extensions routinely
      // push half-initialised objects into `context.subscriptions`.
      const errors: unknown[] = [];
      for (const item of items) {
        try {
          item?.dispose();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) throw errors[0];
    });
  }

  /** VS Code's `Disposable.None`: safe to dispose repeatedly. Not frozen —
   *  `dispose()` clears its own callback, and freezing would make that throw. */
  static readonly None: Disposable = new Disposable(() => undefined);

  dispose(): void {
    const callback = this.callOnDispose;
    // Idempotent by construction: a second dispose must be a no-op, not a
    // second `unregister` on the other side of the wire.
    this.callOnDispose = undefined;
    if (callback) callback();
  }
}

export type Event<T> = (
  listener: (value: T) => unknown,
  thisArgs?: unknown,
  disposables?: DisposableLike[],
) => Disposable;

/**
 * `vscode.EventEmitter`. Listener exceptions are reported and swallowed:
 * an extension listening to its own event must not be able to break the
 * emitter for the others, and there is nobody above to catch it.
 */
export class EventEmitter<T> {
  private listeners: { callback: (value: T) => unknown; thisArgs: unknown }[] = [];
  private disposed = false;
  private readonly onError: (err: unknown) => void;

  constructor(onError?: (err: unknown) => void) {
    this.onError = onError ?? (() => undefined);
  }

  get event(): Event<T> {
    return (listener, thisArgs, disposables) => {
      if (this.disposed) return Disposable.None;
      const entry = { callback: listener, thisArgs };
      this.listeners.push(entry);
      const subscription = new Disposable(() => {
        const index = this.listeners.indexOf(entry);
        if (index !== -1) this.listeners.splice(index, 1);
      });
      if (disposables) disposables.push(subscription);
      return subscription;
    };
  }

  fire(value: T): void {
    if (this.disposed) return;
    // Snapshot: a listener that unsubscribes while firing must not shift the
    // array under the loop.
    for (const entry of this.listeners.slice()) {
      try {
        entry.callback.call(entry.thisArgs, value);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners = [];
  }
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<unknown>;
}

export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

export class CancellationTokenSource {
  readonly token: CancellationToken;
  private readonly emitter = new EventEmitter<unknown>();
  private cancelled = false;

  constructor() {
    const source = this;
    // Built here, over closures: the token travels into extension code on its
    // own, so it must not depend on how it is called.
    this.token = {
      // Getter, not a snapshot: extensions capture the token and read it later.
      get isCancellationRequested() {
        return source.cancelled;
      },
      onCancellationRequested: (listener, thisArgs, disposables) =>
        source.emitter.event(listener, thisArgs, disposables),
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

// ── Uri ─────────────────────────────────────────────────────────────────
// A minimal but faithful `vscode.Uri`: extensions compare, join and stringify
// them constantly, and a wrong `fsPath` on Windows silently breaks path math.

const EMPTY = '';
const SLASH = '/';
const WINDOWS_DRIVE = /^\/?[a-zA-Z]:/;

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(
    scheme: string,
    authority: string,
    uriPath: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme || 'file';
    this.authority = authority;
    this.path = uriPath;
    this.query = query;
    this.fragment = fragment;
    Object.freeze(this);
  }

  static file(fsPath: string): Uri {
    let normalized = fsPath.replace(/\\/g, SLASH);
    if (normalized.startsWith('//')) {
      // UNC path: `\\server\share` → authority `server`, path `/share`.
      const separator = normalized.indexOf(SLASH, 2);
      if (separator === -1) return new Uri('file', normalized.slice(2), SLASH, EMPTY, EMPTY);
      return new Uri(
        'file',
        normalized.slice(2, separator),
        normalized.slice(separator) || SLASH,
        EMPTY,
        EMPTY,
      );
    }
    if (WINDOWS_DRIVE.test(normalized)) {
      // Drive letters are lowercased so two spellings of the same file
      // compare equal, exactly as VS Code does.
      const withSlash = normalized.startsWith(SLASH) ? normalized : SLASH + normalized;
      normalized = withSlash[1].toLowerCase() + withSlash.slice(2);
      return new Uri('file', EMPTY, SLASH + normalized, EMPTY, EMPTY);
    }
    return new Uri('file', EMPTY, normalized.startsWith(SLASH) ? normalized : SLASH + normalized, EMPTY, EMPTY);
  }

  static parse(value: string): Uri {
    const match = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/
      .exec(value);
    if (!match) return Uri.file(value);
    const [, scheme, authority, uriPath, query, fragment] = match;
    if (!scheme) return Uri.file(value);
    return new Uri(
      scheme,
      decodeURIComponent(authority ?? EMPTY),
      decodeURIComponent(uriPath ?? EMPTY),
      query ?? EMPTY,
      fragment ?? EMPTY,
    );
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts = [base.path, ...segments.map((segment) => segment.replace(/\\/g, SLASH))];
    const joined = normalizePath(parts.join(SLASH));
    return base.with({ path: joined });
  }

  static from(components: {
    scheme: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? EMPTY,
      components.path ?? EMPTY,
      components.query ?? EMPTY,
      components.fragment ?? EMPTY,
    );
  }

  get fsPath(): string {
    if (this.authority && this.scheme === 'file') return `//${this.authority}${this.path}`;
    if (WINDOWS_DRIVE.test(this.path)) return this.path.slice(1);
    return this.path;
  }

  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(skipEncoding = false): string {
    const encode = skipEncoding ? (part: string) => part : encodeUriComponentMinimal;
    let result = `${this.scheme}:`;
    if (this.authority || this.scheme === 'file') result += `//${encode(this.authority)}`;
    result += encode(this.path);
    if (this.query) result += `?${encode(this.query)}`;
    if (this.fragment) result += `#${encode(this.fragment)}`;
    return result;
  }

  /** Structured clone drops the prototype, so JSON keeps the shape usable. */
  toJSON(): Record<string, unknown> {
    return {
      $mid: 1,
      scheme: this.scheme,
      authority: this.authority || undefined,
      path: this.path,
      query: this.query || undefined,
      fragment: this.fragment || undefined,
      fsPath: this.fsPath,
      external: this.toString(),
    };
  }
}

/** Collapses `.`/`..` and duplicate separators without touching the disk. */
function normalizePath(value: string): string {
  const absolute = value.startsWith(SLASH);
  const out: string[] = [];
  for (const segment of value.split(SLASH)) {
    if (segment === EMPTY || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join(SLASH);
  return absolute ? SLASH + joined : joined;
}

/** Encodes only what breaks a URI; leaves `/`, `:` and friends readable. */
function encodeUriComponentMinimal(value: string): string {
  return value.replace(/[#?\s]/g, (char) => encodeURIComponent(char));
}

// ── Position, Range, Selection ──────────────────────────────────────────
// Value types of the text model. Immutable, like VS Code's: extensions pass
// them around and compare them, and a mutable `Range` turns "the edit I
// requested" into "the edit as somebody else left it".

export class Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    // Negative coordinates are a bug in the caller, not a state to carry:
    // VS Code clamps them, and so do we, rather than producing a range that
    // silently matches nothing.
    this.line = Math.max(0, Math.floor(line) || 0);
    this.character = Math.max(0, Math.floor(character) || 0);
    Object.freeze(this);
  }

  isBefore(other: Position): boolean {
    return this.line < other.line
      || (this.line === other.line && this.character < other.character);
  }

  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }

  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }

  isAfterOrEqual(other: Position): boolean {
    return other.isBeforeOrEqual(this);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: Position): number {
    if (this.isBefore(other)) return -1;
    return this.isEqual(other) ? 0 : 1;
  }

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startOrStartLine: Position | number,
    startCharacterOrEnd: number | Position,
    endLine?: number,
    endCharacter?: number,
  ) {
    // Both overloads VS Code accepts: (Position, Position) and four numbers.
    const start = startOrStartLine instanceof Position
      ? startOrStartLine
      : new Position(startOrStartLine, startCharacterOrEnd as number);
    const end = startOrStartLine instanceof Position
      ? startCharacterOrEnd as Position
      : new Position(endLine ?? 0, endCharacter ?? 0);

    // Normalised so `start` is always the earlier one: extensions build
    // ranges from a selection dragged backwards without thinking about it.
    const inverted = end.isBefore(start);
    this.start = inverted ? end : start;
    this.end = inverted ? start : end;
    // Only when this *is* a Range: `Selection` extends it and still has its
    // own fields to set, and freezing here would make that throw.
    if (new.target === Range) Object.freeze(this);
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    return positionOrRange.isAfterOrEqual(this.start)
      && positionOrRange.isBeforeOrEqual(this.end);
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }

  union(other: Range): Range {
    return new Range(
      this.start.isBefore(other.start) ? this.start : other.start,
      this.end.isAfter(other.end) ? this.end : other.end,
    );
  }

  with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(
    anchorOrAnchorLine: Position | number,
    activeOrAnchorCharacter: Position | number,
    activeLine?: number,
    activeCharacter?: number,
  ) {
    const anchor = anchorOrAnchorLine instanceof Position
      ? anchorOrAnchorLine
      : new Position(anchorOrAnchorLine, activeOrAnchorCharacter as number);
    const active = anchorOrAnchorLine instanceof Position
      ? activeOrAnchorCharacter as Position
      : new Position(activeLine ?? 0, activeCharacter ?? 0);

    super(anchor, active);
    // The range is normalised; anchor and active are not, because their
    // whole point is remembering which end the caret is on.
    this.anchor = anchor;
    this.active = active;
    Object.freeze(this);
  }

  get isReversed(): boolean {
    return this.active.isBefore(this.anchor);
  }
}
