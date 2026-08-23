/**
 * Applying text edits, as pure computation.
 *
 * This is the part of `WorkspaceEdit` that must be exactly right, so it
 * lives here with no filesystem, no editor and no IPC around it:
 *
 * - **Edits address the document as it was**, not as it becomes. Applying
 *   them back-to-front is what makes a set of positions computed against one
 *   revision remain valid while the text shifts underneath.
 * - **Overlapping edits are rejected, not merged.** Two edits over the same
 *   span have no defined outcome; picking one silently would corrupt a
 *   refactor in a way nobody can see until much later.
 */

export interface TextEditPayload {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

export type TextEditFailure =
  | { code: 'overlapping'; message: string }
  | { code: 'out-of-range'; message: string }
  | { code: 'invalid'; message: string };

export type TextEditResult =
  | { ok: true; content: string }
  | { ok: false; failure: TextEditFailure };

/** Offsets where each line starts. Mirrors the host's `TextDocument`, and
 *  is duplicated on purpose: main must not depend on host code. */
export function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Line/character to absolute offset, clamped to the line and to the
 *  document — a position past the end is a caller bug, and clamping keeps it
 *  from spilling into the next line. */
export function offsetAt(
  content: string,
  starts: number[],
  line: number,
  character: number,
): number {
  const clampedLine = Math.min(Math.max(0, Math.floor(line) || 0), starts.length - 1);
  const start = starts[clampedLine];
  const nextStart = clampedLine + 1 < starts.length ? starts[clampedLine + 1] : content.length;
  let lineLength = nextStart - start;
  if (nextStart > start && content[nextStart - 1] === '\n') {
    lineLength -= (nextStart >= start + 2 && content[nextStart - 2] === '\r') ? 2 : 1;
  }
  return start + Math.min(Math.max(0, Math.floor(character) || 0), Math.max(0, lineLength));
}

interface ResolvedEdit {
  start: number;
  end: number;
  newText: string;
}

/**
 * Applies every edit to `content`, or none.
 *
 * The result is all-or-nothing by construction: nothing is written until
 * every edit has been resolved and checked, so a rejected set leaves the
 * caller with the original text and a reason.
 */
export function applyTextEdits(content: string, edits: TextEditPayload[]): TextEditResult {
  if (edits.length === 0) return { ok: true, content };

  const starts = lineStarts(content);
  const resolved: ResolvedEdit[] = [];

  for (const edit of edits) {
    if (!edit || typeof edit.newText !== 'string') {
      return { ok: false, failure: { code: 'invalid', message: 'Edición sin texto de reemplazo.' } };
    }
    const start = offsetAt(content, starts, edit.startLine, edit.startCharacter);
    const end = offsetAt(content, starts, edit.endLine, edit.endCharacter);
    if (start > end) {
      // A backwards range is normalised, like VS Code's Range does.
      resolved.push({ start: end, end: start, newText: edit.newText });
    } else {
      resolved.push({ start, end, newText: edit.newText });
    }
  }

  // Sorted by start; ties keep their declaration order so two inserts at the
  // same point land in the order the extension asked for.
  const ordered = resolved
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => (a.edit.start - b.edit.start) || (a.index - b.index))
    .map((entry) => entry.edit);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    // Touching is fine (an insert at the end of a replace); overlapping is
    // not, because the outcome would depend on the order we happened to pick.
    if (current.start < previous.end) {
      return {
        ok: false,
        failure: {
          code: 'overlapping',
          message: 'Dos ediciones se solapan sobre el mismo texto; la edición se rechaza entera.',
        },
      };
    }
  }

  // Back to front: every offset was computed against the original text.
  let result = content;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const edit = ordered[index];
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return { ok: true, content: result };
}

/** Structural validation of what an extension sent. Anything malformed is
 *  refused before a single character is touched. */
export function isTextEditPayload(value: unknown): value is TextEditPayload {
  if (value === null || typeof value !== 'object') return false;
  const edit = value as Record<string, unknown>;
  return ['startLine', 'startCharacter', 'endLine', 'endCharacter'].every(
    (key) => typeof edit[key] === 'number' && Number.isFinite(edit[key] as number),
  ) && typeof edit.newText === 'string';
}
