/**
 * `workspace.applyEdit`, main side.
 *
 * The contract is the one the design fixes (§5): **all or nothing**.
 * Applying half of a multi-file refactor is worse than applying none of it,
 * because the user is left with code that no longer compiles and no way to
 * tell what happened.
 *
 * So the whole edit is checked before anything is written:
 *
 * 1. every path passes the same policy as `workspace.fs` — editing must not
 *    become the way around what the filesystem refuses;
 * 2. every version matches the buffer the extension computed against;
 * 3. every edit resolves and none overlaps.
 *
 * Only then is anything applied. Open files go to the renderer (one undo
 * step, so the user can take it back in one go); closed files are written to
 * disk through the same filesystem port as everything else.
 */
import { applyTextEdits, isTextEditPayload } from '../domain/text-edits';
import type { TextEditPayload } from '../domain/text-edits';
import { RpcError } from '../domain/rpc-protocol';
import type { DocumentMirror } from './document-mirror';

export interface WorkspaceEditFile {
  uri: string;
  /** Version the extension computed against; `null` means "do not check",
   *  which VS Code allows for files that were not open. */
  version: number | null;
  edits: TextEditPayload[];
}

export interface WorkspaceEditResult {
  applied: boolean;
  /** Files actually changed, in application order. */
  files: string[];
  /** Why nothing was applied, when it was refused. */
  reason?: string;
}

export interface WorkspaceEditServiceOptions {
  mirror: DocumentMirror;
  /** Authorises a path under the `workspace.fs` policy. Throws when refused. */
  authorise: (uri: string, extensionId: string) => Promise<void>;
  /** Reads a closed file, under the calling extension's own policy. */
  readFile: (uri: string, extensionId: string) => Promise<string>;
  /** Writes a closed file, likewise. */
  writeFile: (uri: string, content: string, extensionId: string) => Promise<void>;
  /** Applies edits to an open buffer, in one undo step. Resolves false when
   *  the renderer could not do it. */
  applyInRenderer: (uri: string, edits: TextEditPayload[]) => Promise<boolean>;
  log?: (message: string) => void;
}

export class WorkspaceEditService {
  constructor(private readonly options: WorkspaceEditServiceOptions) {}

  async apply(payload: unknown, extensionId: string): Promise<WorkspaceEditResult> {
    const files = parseWorkspaceEdit(payload);
    if (files === null) {
      throw new RpcError('INVALID_PAYLOAD', 'La edición no tiene una forma válida.');
    }
    if (files.length === 0) return { applied: true, files: [] };

    // ── Phase 1: check everything ────────────────────────────────────────
    const plans: { uri: string; content: string; isOpen: boolean; edits: TextEditPayload[] }[] = [];

    for (const file of files) {
      await this.options.authorise(file.uri, extensionId);

      const mirrored = this.options.mirror.get(file.uri);
      if (mirrored && file.version !== null && file.version !== mirrored.version) {
        // The user typed while the extension was thinking. Refusing is the
        // point of carrying versions at all.
        return {
          applied: false,
          files: [],
          reason: `"${file.uri}" cambió mientras se preparaba la edición `
            + `(versión ${mirrored.version}, se esperaba ${file.version}).`,
        };
      }

      const content = mirrored
        ? mirrored.content
        : await this.options.readFile(file.uri, extensionId);

      // Resolved now, against the same content that will be edited, so a
      // failure here costs nothing.
      const result = applyTextEdits(content, file.edits);
      if (!result.ok) {
        return { applied: false, files: [], reason: result.failure.message };
      }
      plans.push({
        uri: file.uri,
        content: result.content,
        isOpen: mirrored !== null,
        edits: file.edits,
      });
    }

    // ── Phase 2: apply ───────────────────────────────────────────────────
    // Everything validated. A failure from here on is an I/O failure, not a
    // decision, and it is reported with what was already applied — there is
    // no transaction across the editor and the disk, and pretending there is
    // one would be the actual lie.
    const applied: string[] = [];
    for (const plan of plans) {
      try {
        if (plan.isOpen) {
          const ok = await this.options.applyInRenderer(plan.uri, plan.edits);
          if (!ok) {
            return {
              applied: false,
              files: applied,
              reason: `El editor no pudo aplicar los cambios en "${plan.uri}".`,
            };
          }
        } else {
          await this.options.writeFile(plan.uri, plan.content, extensionId);
        }
        applied.push(plan.uri);
      } catch (err) {
        this.options.log?.(`edición fallida en "${plan.uri}": ${(err as Error).message}`);
        return {
          applied: false,
          files: applied,
          reason: `No se pudo escribir "${plan.uri}": ${(err as Error).message}`,
        };
      }
    }

    return { applied: true, files: applied };
  }
}

/** Validates the wire shape. Returns null when it is not usable at all. */
export function parseWorkspaceEdit(value: unknown): WorkspaceEditFile[] | null {
  const body = value as { files?: unknown } | null;
  const files = body?.files;
  if (!Array.isArray(files)) return null;

  const parsed: WorkspaceEditFile[] = [];
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object') return null;
    const file = entry as Record<string, unknown>;
    if (typeof file.uri !== 'string' || !file.uri) return null;
    if (!Array.isArray(file.edits) || !file.edits.every(isTextEditPayload)) return null;
    parsed.push({
      uri: file.uri,
      version: typeof file.version === 'number' ? file.version : null,
      edits: file.edits,
    });
  }
  return parsed;
}
