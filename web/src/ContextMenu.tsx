import { useLayoutEffect, useRef, useState } from 'react';

export type MenuEntry =
  | { sep: true }
  | { label: string; run?: () => void; disabled?: boolean; hint?: string; danger?: boolean };

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y, entries]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {entries.map((en, i) =>
        'sep' in en ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item${en.disabled ? ' disabled' : ''}${en.danger ? ' danger' : ''}`}
            disabled={en.disabled}
            onClick={() => {
              onClose();
              en.run?.();
            }}
          >
            <span>{en.label}</span>
            {en.hint && <span className="ctx-hint">{en.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
