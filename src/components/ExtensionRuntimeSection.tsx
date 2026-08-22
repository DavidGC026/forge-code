import { Activity, CheckCircle2, Ban, AlertTriangle } from 'lucide-react';
import { useStore } from '../store';
import {
  describeActivationReason,
  formatDuration,
  summarizeExtensionRuntime,
} from '../extensions/hostStatus';

/**
 * What the Extension Host has actually done with this extension: whether it
 * activated, what woke it up, how long it took, and why it failed if it did.
 *
 * This is the section that lets the detail view stop speaking in futures.
 * It only claims what main measured — an extension that has never been
 * triggered says exactly that, rather than being painted as broken or as
 * fine.
 */
export default function ExtensionRuntimeSection({ extensionId }: { extensionId: string }) {
  const report = useStore((s) => s.extensionActivation);
  const hostState = useStore((s) => s.extensionHostState);
  const safeMode = useStore((s) => s.safeMode);

  // Outside Electron there is no host, and no honest thing to report.
  if (!hostState) return null;

  const runtime = summarizeExtensionRuntime(report, extensionId);
  const reason = describeActivationReason(runtime.reason);

  return (
    <div className="mb-5">
      <div className="text-[11px] uppercase tracking-wide text-forge-text/50 mb-1">
        Runtime
      </div>

      {safeMode.active ? (
        <div className="flex items-start gap-1.5 py-1 text-[12px] text-amber-200/80">
          <Ban size={12} className="mt-0.5 flex-shrink-0" />
          <span>Modo seguro: no se ejecuta.</span>
        </div>
      ) : runtime.state === 'active' ? (
        <div className="flex items-start gap-1.5 py-1 text-[12px] text-forge-text-strong">
          <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0 text-emerald-400/80" />
          <span>
            Activa{reason ? `, ${reason}` : ''}
            {runtime.durationMs !== null && (
              <span className="text-forge-text/45">
                {' · '}
                {formatDuration(runtime.durationMs)}
              </span>
            )}
          </span>
        </div>
      ) : runtime.state === 'failed' ? (
        <div className="py-1">
          <div className="flex items-start gap-1.5 text-[12px] text-red-300/90">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>Falló al activarse{reason ? ` ${reason}` : ''}.</span>
          </div>
          {runtime.error && (
            <p className="mt-1 ml-[18px] text-[11px] leading-snug text-forge-text/60 break-words">
              {runtime.error.message}
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-1.5 py-1 text-[12px] text-forge-text/60">
          <Activity size={12} className="mt-0.5 flex-shrink-0 text-forge-text/35" />
          <span>
            Sin activar todavía: se activará cuando ocurra uno de sus activation events.
          </span>
        </div>
      )}
    </div>
  );
}
