import { useEffect, useRef } from 'react';
import { Command, X } from 'lucide-react';

const shortcuts = [
  ['Paleta de comandos', 'Ctrl+Shift+P'],
  ['Buscar archivo', 'Ctrl+P'],
  ['Guardar archivo', 'Ctrl+S'],
  ['Mostrar u ocultar explorador', 'Ctrl+B'],
  ['Mostrar u ocultar panel', 'Ctrl+`'],
  ['Cerrar pestaña', 'Ctrl+W'],
  ['Cambiar pestaña', 'Ctrl+Tab'],
  ['Tamaño de fuente', 'Ctrl+= / Ctrl+-'],
  ['Restablecer tamaño', 'Ctrl+0'],
];

export default function WorkbenchHelp({ mode, onClose }: { mode: 'about' | 'shortcuts'; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-[200] no-drag bg-black/60 flex items-center justify-center px-5" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="workbench-help-title" className="w-full max-w-[450px] rounded-lg border border-forge-border bg-forge-sidebar shadow-2xl" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === 'Tab') { e.preventDefault(); closeRef.current?.focus(); }
      }}>
        <header className="flex items-center justify-between border-b border-forge-border px-5 py-3">
          <h2 id="workbench-help-title" className="text-[13px] font-medium text-forge-text-strong">{mode === 'about' ? 'Acerca de Forge Code' : 'Atajos de teclado'}</h2>
          <button ref={closeRef} onClick={onClose} className="forge-toolbar-button" aria-label="Cerrar"><X size={15} /></button>
        </header>
        {mode === 'about' ? <div className="px-5 py-7"><Command size={26} className="mb-4 text-forge-gold" /><h3 className="text-xl font-semibold tracking-tight text-forge-text-strong">Forge Code</h3><p className="mt-2 text-[13px] leading-6 text-forge-text-dim">Editor de código con terminal, Git, extensiones y agentes integrados.</p></div> : <dl className="px-5 py-4 space-y-3 text-[12px]">{shortcuts.map(([label, key]) => <div key={label} className="flex justify-between items-center gap-4"><dt className="text-forge-text">{label}</dt><dd><kbd className="forge-kbd">{key}</kbd></dd></div>)}</dl>}
      </section>
    </div>
  );
}
