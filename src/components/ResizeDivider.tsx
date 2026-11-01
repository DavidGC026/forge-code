import { useRef, useState } from 'react';

interface ResizeDividerProps {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  onDrag: (position: number) => void;
}

/** Pointer capture keeps a resize alive outside the narrow handle. */
export default function ResizeDivider({ orientation, label, value, onDrag }: ResizeDividerProps) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);
  const vertical = orientation === 'vertical';
  const position = (event: React.PointerEvent) => vertical ? event.clientX : event.clientY;

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      title={`${label} · arrastra o usa las flechas`}
      className={`group relative z-10 shrink-0 touch-none select-none outline-none ${vertical ? 'h-full w-full cursor-col-resize' : 'h-[6px] w-full cursor-row-resize'} focus-visible:bg-forge-accent/20`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dragging.current = true;
        setActive(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        onDrag(position(event));
      }}
      onPointerMove={(event) => {
        if (dragging.current) onDrag(position(event));
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        setActive(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { dragging.current = false; setActive(false); }}
      onLostPointerCapture={() => { dragging.current = false; setActive(false); }}
      onKeyDown={(event) => {
        const negative = vertical ? 'ArrowLeft' : 'ArrowUp';
        const positive = vertical ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const center = vertical ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
        onDrag(center + (event.key === negative ? -16 : 16));
      }}
    >
      <span className={`pointer-events-none absolute transition-colors ${vertical ? 'inset-y-0 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-0 top-1/2 h-0.5 -translate-y-1/2'} ${active ? 'bg-forge-accent' : 'bg-transparent group-hover:bg-forge-accent/70 group-focus-visible:bg-forge-accent'}`} />
    </div>
  );
}
