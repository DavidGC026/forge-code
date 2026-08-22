import { useState } from 'react';
import { Cpu, RefreshCw, ShieldOff, AlertTriangle } from 'lucide-react';
import { useStore } from '../store';
import { describeHostStatus } from '../extensions/hostStatus';
import type { HostTone } from '../extensions/hostStatus';

/**
 * Extension Host state in the Extensions panel.
 *
 * Two rules keep this from becoming decoration:
 *
 * - **A healthy host says almost nothing.** One quiet line with the running
 *   generation. Everything else — restarts, crash-loop, failures — earns
 *   its space by being actionable.
 * - **Safe Mode is loud, always.** Extensions being inert is precisely the
 *   kind of state a user forgets they are in, and then spends an afternoon
 *   wondering why nothing works.
 */

const TONE: Record<HostTone, { border: string; text: string }> = {
  neutral: { border: 'border-forge-border/60', text: 'text-forge-text/60' },
  busy: { border: 'border-sky-400/30', text: 'text-sky-300/90' },
  warning: { border: 'border-amber-400/30', text: 'text-amber-200/90' },
  danger: { border: 'border-red-400/35', text: 'text-red-300/90' },
};

export default function ExtensionHostStatus() {
  const hostState = useStore((s) => s.extensionHostState);
  const restartExtensionHost = useStore((s) => s.restartExtensionHost);
  const safeMode = useStore((s) => s.safeMode);
  const safeModeError = useStore((s) => s.safeModeError);
  const setSafeMode = useStore((s) => s.setSafeMode);
  const [busy, setBusy] = useState<'restart' | 'safe-mode' | null>(null);

  const status = describeHostStatus(hostState);
  const tone = TONE[status.tone];

  const run = async (kind: 'restart' | 'safe-mode', action: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  // Outside Electron there is no host and never will be: saying so once, in
  // the detail line, beats an empty banner.
  if (!hostState && !safeMode.active) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {safeMode.active && (
        <div className="rounded border border-amber-400/25 bg-amber-400/10 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-amber-200/90">
            <ShieldOff size={12} className="flex-shrink-0" />
            <span className="uppercase tracking-wide">Modo seguro</span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-forge-text/70">
            Ninguna extensión se está ejecutando.{safeMode.reason ? ` ${safeMode.reason}` : ''}
          </p>
          {safeMode.canDisable ? (
            <button
              onClick={() => void run('safe-mode', () => setSafeMode(false))}
              disabled={busy !== null}
              className="mt-1.5 w-full rounded bg-forge-input px-2 py-1 text-[11px] text-forge-text border border-forge-border/70 hover:border-forge-accent/60 hover:text-forge-accent transition-colors disabled:opacity-50"
            >
              {busy === 'safe-mode' ? 'Aplicando…' : 'Salir del modo seguro'}
            </button>
          ) : (
            <p className="mt-1.5 text-[11px] leading-snug text-forge-text/45">
              Reinicia Forge sin <code>--disable-extensions</code> para salir.
            </p>
          )}
          {safeModeError && (
            <p className="mt-1.5 text-[11px] leading-snug text-red-400/90">{safeModeError}</p>
          )}
        </div>
      )}

      {!safeMode.active && hostState && (
        <div className={`rounded border ${tone.border} bg-forge-input/40 px-2 py-1.5`}>
          <div className="flex items-center gap-1.5">
            {status.tone === 'danger'
              ? <AlertTriangle size={12} className={`${tone.text} flex-shrink-0`} />
              : <Cpu size={12} className={`${tone.text} flex-shrink-0`} />}
            <span className={`text-[11px] ${tone.text}`}>Extension Host · {status.label}</span>
            {hostState.status === 'running' && (
              <span className="ml-auto text-[10px] text-forge-text/30">
                gen {hostState.generation}
              </span>
            )}
          </div>

          {status.detail && (
            <p className="mt-1 text-[11px] leading-snug text-forge-text/60">{status.detail}</p>
          )}

          {(status.tone === 'danger' || (hostState.restartsInWindow > 0 && status.canRestart)) && (
            <button
              onClick={() => void run('restart', restartExtensionHost)}
              disabled={busy !== null}
              className="mt-1.5 w-full flex items-center justify-center gap-1.5 rounded bg-forge-input px-2 py-1 text-[11px] text-forge-text border border-forge-border/70 hover:border-forge-accent/60 hover:text-forge-accent transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={busy === 'restart' ? 'animate-spin' : undefined} />
              {busy === 'restart' ? 'Reiniciando…' : 'Reiniciar Extension Host'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
