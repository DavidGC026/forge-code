// ── Extension Host status, as the workbench states it ───────────────────
//
// Pure functions over what main publishes (`ExtensionHostState` and the
// activation report). They live outside React so the wording and the
// derivation are testable without a DOM — the UI decides colours, not what
// is true.
//
// The vocabulary is deliberately plain: "reiniciando" and "deshabilitado"
// describe what the user can observe. A status nobody can act on is noise,
// so `running` with nothing wrong renders no banner at all (see `tone`).

export type HostTone = 'neutral' | 'busy' | 'warning' | 'danger';

export interface HostStatusDescription {
  label: string;
  tone: HostTone;
  /** One sentence explaining what it means for the user, or null. */
  detail: string | null;
  /** Whether a manual restart is worth offering right now. */
  canRestart: boolean;
}

export interface HostStateLike {
  status: 'stopped' | 'starting' | 'running' | 'restarting' | 'disabled';
  generation: number;
  restartsInWindow: number;
  lastError: { code: string; message: string } | null;
}

export function describeHostStatus(state: HostStateLike | null): HostStatusDescription {
  if (!state) {
    return {
      label: 'No disponible',
      tone: 'neutral',
      detail: 'El Extension Host sólo existe en la aplicación de escritorio.',
      canRestart: false,
    };
  }

  switch (state.status) {
    case 'running':
      return {
        label: 'En ejecución',
        tone: 'neutral',
        // Only worth saying when there have been restarts: otherwise it is
        // a "you are fine" badge, which stops meaning anything.
        detail: state.restartsInWindow > 0
          ? `Se reinició ${state.restartsInWindow} ${state.restartsInWindow === 1 ? 'vez' : 'veces'} recientemente.`
          : null,
        canRestart: true,
      };
    case 'starting':
      return { label: 'Arrancando', tone: 'busy', detail: null, canRestart: false };
    case 'restarting':
      return {
        label: 'Reiniciando',
        tone: 'busy',
        detail: state.lastError?.message ?? 'La generación anterior terminó de forma inesperada.',
        canRestart: false,
      };
    case 'disabled':
      return {
        label: 'Deshabilitado',
        tone: 'danger',
        detail: 'El host se reinició demasiadas veces seguidas y se detuvo para no entrar en bucle. '
          + 'Reinícialo a mano cuando sepas qué extensión lo provoca.',
        canRestart: true,
      };
    case 'stopped':
    default:
      return {
        label: 'Detenido',
        tone: 'neutral',
        detail: state.lastError
          ? state.lastError.message
          : 'No hay ninguna extensión que necesite ejecutarse.',
        canRestart: true,
      };
  }
}

// ── Activation, per extension ───────────────────────────────────────────

export interface ActivationMetricLike {
  id: string;
  reason: string;
  durationMs: number;
  at: number;
}

export interface ActivationFailureLike {
  id: string;
  reason: string;
  code: string;
  message: string;
  at: number;
}

export interface ActivationReportLike {
  metrics: ActivationMetricLike[];
  failures: ActivationFailureLike[];
}

export type ExtensionRuntimeState = 'idle' | 'active' | 'failed';

export interface ExtensionRuntimeSummary {
  state: ExtensionRuntimeState;
  /** What woke it up (`onCommand:x`), or null when it never activated. */
  reason: string | null;
  durationMs: number | null;
  error: { code: string; message: string } | null;
}

/**
 * What the detail view can honestly say about one extension right now.
 *
 * The *latest* entry wins, and a failure only counts while it is the last
 * word: an extension that failed and was later activated successfully (a
 * new generation, say) is active, not failed.
 */
export function summarizeExtensionRuntime(
  report: ActivationReportLike | null,
  extensionId: string,
): ExtensionRuntimeSummary {
  const idle: ExtensionRuntimeSummary = {
    state: 'idle',
    reason: null,
    durationMs: null,
    error: null,
  };
  if (!report) return idle;

  const metric = latest(report.metrics.filter((entry) => entry.id === extensionId));
  const failure = latest(report.failures.filter((entry) => entry.id === extensionId));

  if (failure && (!metric || failure.at >= metric.at)) {
    return {
      state: 'failed',
      reason: failure.reason,
      durationMs: null,
      error: { code: failure.code, message: failure.message },
    };
  }
  if (metric) {
    return { state: 'active', reason: metric.reason, durationMs: metric.durationMs, error: null };
  }
  return idle;
}

function latest<T extends { at: number }>(entries: T[]): T | null {
  return entries.reduce<T | null>(
    (best, entry) => (best === null || entry.at >= best.at ? entry : best),
    null,
  );
}

/** Milliseconds as a person reads them: precise while small, rounded once
 *  the precision stops mattering. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  if (durationMs < 1) return '<1 ms';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

/** `onCommand:acme.run` → `acme.run`, for a label that fits. The prefix is
 *  the mechanism; the user cares about the trigger. */
export function describeActivationReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'onStartupFinished' || reason === '*') return 'al arrancar Forge';
  if (reason.startsWith('onCommand:')) return `por el comando ${reason.slice('onCommand:'.length)}`;
  if (reason.startsWith('onLanguage:')) return `al abrir ${reason.slice('onLanguage:'.length)}`;
  if (reason.startsWith('workspaceContains:')) {
    return `porque el workspace contiene ${reason.slice('workspaceContains:'.length)}`;
  }
  return reason;
}
