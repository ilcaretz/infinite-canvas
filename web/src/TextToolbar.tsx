import { boardStore } from './store';
import { TEXT_COLORS, TEXT_SIZES, sizeLabel, textProps, type TextAlign, type TextProps } from './textLogic';
import type { Item } from './types';

const ALIGNS: Array<{ a: TextAlign; title: string; d: string }> = [
  { a: 'left', title: 'Align left', d: 'M3 5h14M3 9h9M3 13h14M3 17h9' },
  { a: 'center', title: 'Align center', d: 'M3 5h14M6 9h8M3 13h14M6 17h8' },
  { a: 'right', title: 'Align right', d: 'M3 5h14M8 9h9M3 13h14M8 17h9' },
];

/** Apply a style change to every given text item as ONE undo step. */
function apply(texts: Item[], patch: Partial<TextProps>) {
  const patches: Record<string, Partial<Item>> = {};
  for (const it of texts) patches[it.id] = { props: { ...textProps(it.props), ...patch } };
  boardStore.edit('text style', patches);
}

/** Floating style bar over the selected text item(s): size S/M/L/XL, colour, bold, alignment. */
export function TextToolbar({ texts, left, top }: { texts: Item[]; left: number; top: number }) {
  const first = textProps(texts[0].props);
  const same = <K extends keyof TextProps>(k: K) => texts.every((t) => textProps(t.props)[k] === first[k]);
  const keepFocus = (e: React.MouseEvent) => e.preventDefault(); // never steal focus from the text being edited
  return (
    <div
      className="text-toolbar"
      data-nodrag
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={keepFocus}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="tt-group">
        {TEXT_SIZES.map((s) => (
          <button
            key={s.label}
            className={`tt-btn${same('size') && first.size === s.size ? ' on' : ''}`}
            title={`Size ${s.label} (${s.size})`}
            onClick={() => apply(texts, { size: s.size })}
          >
            {s.label}
          </button>
        ))}
        {same('size') && sizeLabel(first.size) === null && <span className="tt-size">{first.size}</span>}
      </span>
      <span className="tt-sep" />
      <span className="tt-group">
        {TEXT_COLORS.map((c) => (
          <button
            key={c.value}
            className={`tt-dot${same('color') && first.color === c.value ? ' on' : ''}`}
            style={{ background: c.value }}
            title={c.name}
            aria-label={`Text colour ${c.name}`}
            onClick={() => apply(texts, { color: c.value })}
          />
        ))}
      </span>
      <span className="tt-sep" />
      <button
        className={`tt-btn tt-bold${same('bold') && first.bold ? ' on' : ''}`}
        title="Bold"
        onClick={() => apply(texts, { bold: !(same('bold') && first.bold) })}
      >
        B
      </button>
      <span className="tt-sep" />
      <span className="tt-group">
        {ALIGNS.map((al) => (
          <button
            key={al.a}
            className={`tt-btn${same('align') && first.align === al.a ? ' on' : ''}`}
            title={al.title}
            onClick={() => apply(texts, { align: al.a })}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d={al.d} />
            </svg>
          </button>
        ))}
      </span>
    </div>
  );
}
