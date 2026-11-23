import { useSyncExternalStore } from 'react';

export interface ToastLink { label: string; href: string; download?: string }
export interface ToastState { id: number; text: string; link?: ToastLink }

let current: ToastState | null = null;
let seq = 0;
let timer = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** One message at a time, bottom centre. Longer when it carries a link. */
export function toast(text: string, opts: { link?: ToastLink; ms?: number } = {}) {
  window.clearTimeout(timer);
  current = { id: ++seq, text, link: opts.link };
  emit();
  const id = current.id;
  timer = window.setTimeout(() => {
    if (current?.id === id) dismissToast();
  }, opts.ms ?? (opts.link ? 14000 : 7000));
}

export function dismissToast() {
  window.clearTimeout(timer);
  current = null;
  emit();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

export function ToastHost() {
  const t = useSyncExternalStore(subscribe, () => current);
  if (!t) return null;
  return (
    <div className="toast" role="status" data-nodrag onPointerDown={(e) => e.stopPropagation()}>
      <span>{t.text}</span>
      {t.link && <a href={t.link.href} download={t.link.download}>{t.link.label}</a>}
      <button className="toast-x" title="Dismiss" onClick={dismissToast}>×</button>
    </div>
  );
}
