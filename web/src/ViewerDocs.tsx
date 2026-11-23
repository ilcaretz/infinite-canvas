import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, type DocPayload } from './api';
import { pauseOtherAudio } from './audioControl';
import { fmtDur, seekBy } from './format';
import { normalizeWheelDelta } from './geometry';
import { InfoPanel } from './InfoPanel';
import { renderMarkdown } from './markdown';
import { parseFountain, type ScreenplayElement } from './screenplay';
import { boardStore } from './store';
import type { Item } from './types';

/** Viewers for audio, PDF and text / script documents (images and videos live in Viewer.tsx). */

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};
const noFocus = (e: React.MouseEvent) => e.preventDefault();

interface ChromeProps {
  item: Item;
  onClose: () => void;
  onNav: (d: 1 | -1) => void;
  /** First look at every key; return true when handled (the shell then ignores it). */
  onKey?: (e: KeyboardEvent) => boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

/** Close button, prev/next, info card, keyboard (Esc, I, PageUp/PageDown) and footer shared by the document viewers. */
function ViewerChrome({ item, onClose, onNav, onKey, footer, children }: ChromeProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef(false);
  infoRef.current = infoOpen;
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  const act = useRef({ onClose, onNav });
  act.current = { onClose, onNav };

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      if (keyRef.current?.(e)) {
        stop();
        return;
      }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) {
        e.stopPropagation();
        return;
      }
      const k = e.key;
      if (k === 'Escape') {
        if (infoRef.current) setInfoOpen(false);
        else act.current.onClose();
      } else if (k === 'i' || k === 'I') setInfoOpen((o) => !o);
      else if (k === 'PageUp') act.current.onNav(-1);
      else if (k === 'PageDown') act.current.onNav(1);
      else if (k === 'Enter' || k === 'Delete' || k === 'Backspace' || k === 'Tab') { /* swallowed: the board must not act under the viewer */ }
      else {
        e.stopPropagation();
        return;
      }
      stop();
    };
    window.addEventListener('keydown', onDown, true);
    return () => window.removeEventListener('keydown', onDown, true);
  }, []);

  return (
    <div className="viewer" onContextMenu={(e) => e.preventDefault()}>
      <button className="viewer-close" onMouseDown={noFocus} onClick={onClose} title="Close (Esc)" aria-label="Close">×</button>
      {children}
      <button className="viewer-nav prev" onMouseDown={noFocus} onClick={() => onNav(-1)} title="Previous (PageUp)" aria-label="Previous">‹</button>
      <button className="viewer-nav next" onMouseDown={noFocus} onClick={() => onNav(1)} title="Next (PageDown)" aria-label="Next">›</button>
      {infoOpen && <InfoPanel mediaId={item.mediaId} name={item.name} />}
      <div className="viewer-footer">
        <span className="viewer-name">{item.name}</span>
        {footer}
        <a className="viewer-dl" href={`/api/items/${item.id}/original`} download onMouseDown={noFocus}>Download original</a>
      </div>
    </div>
  );
}

interface BodyProps { item: Item; onClose: () => void; onNav: (d: 1 | -1) => void }

// ---- audio -----------------------------------------------------------------------------------

export function AudioViewer({ item, onClose, onNav }: BodyProps) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(item.durationMs ? item.durationMs / 1000 : 0);
  const waveRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    pauseOtherAudio(ref.current);
    ref.current?.play().catch(() => {});
  }, []);
  // smooth playhead while playing
  useEffect(() => {
    const a = ref.current;
    if (!a || !playing) return;
    let h = 0;
    const tick = () => {
      setTime(a.currentTime);
      h = requestAnimationFrame(tick);
    };
    h = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(h);
  }, [playing]);

  const toggle = useCallback(() => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }, []);
  const seek = useCallback((delta: number) => {
    const a = ref.current;
    if (!a) return;
    a.currentTime = seekBy(a.currentTime, delta, a.duration);
    setTime(a.currentTime);
  }, []);
  const seekAt = (clientX: number) => {
    const a = ref.current;
    const w = waveRef.current;
    if (!a || !w || !(a.duration > 0)) return;
    const r = w.getBoundingClientRect();
    a.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * a.duration;
    setTime(a.currentTime);
  };

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return false;
    if (e.code === 'Space' || e.key === ' ') {
      if (!e.repeat) toggle();
      return true;
    }
    if (e.key === 'ArrowLeft') { seek(e.shiftKey ? -5 : -1); return true; }
    if (e.key === 'ArrowRight') { seek(e.shiftKey ? 5 : 1); return true; }
    return false;
  }, [toggle, seek]);

  const pct = dur > 0 ? Math.min(100, (time / dur) * 100) : 0;
  const src = item.previewUrl ?? null;
  return (
    <ViewerChrome item={item} onClose={onClose} onNav={onNav} onKey={onKey}>
      <div className="viewer-stage audio-stage" style={{ cursor: 'default' }}>
        {src ? (
          <audio
            ref={ref}
            src={src}
            preload="auto"
            onPlay={(e) => { pauseOtherAudio(e.currentTarget); setPlaying(true); }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
            onDurationChange={(e) => isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
            onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          />
        ) : <div className="viewer-empty">Not available</div>}
        <div className="audio-big">
          <div className="audio-big-title">{item.name}</div>
          <div
            className="audio-big-wave"
            ref={waveRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              scrubbing.current = true;
              seekAt(e.clientX);
            }}
            onPointerMove={(e) => scrubbing.current && seekAt(e.clientX)}
            onPointerUp={() => (scrubbing.current = false)}
            onPointerCancel={() => (scrubbing.current = false)}
          >
            {item.thumbUrl && <img src={item.thumbUrl} alt="" draggable={false} />}
            <div className="audio-big-played" style={{ width: `${pct}%` }} />
            <div className="audio-big-head" style={{ left: `${pct}%` }} />
          </div>
          <div className="audio-big-controls" onMouseDown={noFocus}>
            <button onClick={() => seek(-5)} title="Back 5 s (Shift+Left)">−5</button>
            <button className="audio-big-play" onClick={toggle} title="Play / pause (Space)">{playing ? '❚❚' : '▶'}</button>
            <button onClick={() => seek(5)} title="Forward 5 s (Shift+Right)">+5</button>
            <span className="audio-big-time">{fmtDur(time * 1000)} / {dur > 0 ? fmtDur(dur * 1000) : '--'}</span>
          </div>
        </div>
      </div>
    </ViewerChrome>
  );
}

// ---- PDF -------------------------------------------------------------------------------------

type PdfLib = typeof import('pdfjs-dist');
let pdfLib: Promise<PdfLib> | null = null;
function loadPdfjs(): Promise<PdfLib> {
  return (pdfLib ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  }));
}

function PdfPage({ pdf, n, width, root, ratio0 }: { pdf: PDFDocumentProxy; n: number; width: number; root: HTMLElement | null; ratio0: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(n <= 2);
  const [ratio, setRatio] = useState(ratio0);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !root) return;
    const io = new IntersectionObserver(([en]) => setVisible(en.isIntersecting), { root, rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (!visible) {
      c.width = 0;
      c.height = 0; // free the bitmap of pages far from the viewport
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      const page = await pdf.getPage(n);
      if (cancelled) return;
      const v1 = page.getViewport({ scale: 1 });
      setRatio(v1.height / v1.width);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (width / v1.width) * dpr });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = page.render({ canvas: c, viewport: vp });
      await task.promise.catch(() => {}); // a cancelled render rejects
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, n, width, visible]);

  return (
    <div className="pdf-page" ref={wrap} data-page={n} style={{ width, height: width * ratio }}>
      <canvas ref={canvas} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

export function PdfViewer({ item, onClose, onNav }: BodyProps) {
  const url = item.previewUrl ?? item.originalUrl ?? null;
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ratio0, setRatio0] = useState(1.4142);
  const [stageW, setStageW] = useState(900);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const pending = useRef<{ k: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    if (!url) return;
    let dead = false;
    let loading: { destroy: () => Promise<void> } | null = null;
    void loadPdfjs().then(async (lib) => {
      const task = lib.getDocument({ url, useSystemFonts: true });
      loading = task;
      try {
        const doc = await task.promise;
        if (dead) return;
        const p1 = await doc.getPage(1);
        const v = p1.getViewport({ scale: 1 });
        setRatio0(v.height / v.width);
        setPdf(doc);
      } catch (e) {
        if (!dead) setErr(e instanceof Error ? e.message : 'cannot open this PDF');
      }
    });
    return () => {
      dead = true;
      void loading?.destroy();
    };
  }, [url]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setRoot(el);
    const measure = () => setStageW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomBy = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = scroller.current;
    setZoom((z) => {
      const nz = Math.min(5, Math.max(0.25, z * factor));
      if (el && nz !== z) pending.current = { k: nz / z, cx: cx ?? el.clientWidth / 2, cy: cy ?? el.clientHeight / 2 };
      return nz;
    });
  }, []);

  // Ctrl+wheel = zoom (page never zooms); plain wheel = native scroll.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = normalizeWheelDelta(e.deltaY, e.deltaMode, r.height);
      zoomBy(Math.exp(-dy * 0.0025), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const pageW = Math.max(120, Math.min(stageW - 48, 1000) * zoom);
  // keep the point under the cursor fixed after a zoom step
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pending.current;
    if (!el || !p) return;
    pending.current = null;
    el.scrollTop = (el.scrollTop + p.cy) * p.k - p.cy;
    el.scrollLeft = (el.scrollLeft + p.cx) * p.k - p.cx;
  }, [pageW]);

  // page counter from the scroll position
  const raf = useRef(0);
  const onScroll = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = scroller.current;
      if (!el) return;
      const mark = el.getBoundingClientRect().top + el.clientHeight / 3;
      let cur = 1;
      el.querySelectorAll<HTMLElement>('.pdf-page').forEach((p) => {
        if (p.getBoundingClientRect().top <= mark) cur = Number(p.dataset.page);
      });
      setPage(cur);
    });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => { scroller.current?.focus(); }, [pdf]);

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return false;
    if (e.key === '+' || e.key === '=') { zoomBy(1.25); return true; }
    if (e.key === '-' || e.key === '_') { zoomBy(0.8); return true; }
    if (e.key === '0') { setZoom(1); return true; }
    return false;
  }, [zoomBy]);

  const total = pdf?.numPages ?? item.pages ?? 0;
  const pages = useMemo(() => (pdf ? Array.from({ length: pdf.numPages }, (_, i) => i + 1) : []), [pdf]);
  return (
    <ViewerChrome
      item={item} onClose={onClose} onNav={onNav} onKey={onKey}
      footer={
        <>
          <span>Page {page} / {total || '…'}</span>
          <span className="viewer-zoom">
            <button className="viewer-mini" onClick={() => zoomBy(0.8)} onMouseDown={noFocus} title="Zoom out (-)">−</button>
            {' '}{Math.round(zoom * 100)}%{' '}
            <button className="viewer-mini" onClick={() => zoomBy(1.25)} onMouseDown={noFocus} title="Zoom in (+)">+</button>
            {' '}
            <button className="viewer-mini" onClick={() => setZoom(1)} onMouseDown={noFocus} title="Fit width (0)">fit</button>
          </span>
        </>
      }
    >
      <div className="pdf-scroll" ref={scroller} tabIndex={-1} onScroll={onScroll}>
        {err && <div className="viewer-empty">{err}</div>}
        {!pdf && !err && <div className="viewer-empty">Loading…</div>}
        <div className="pdf-pages" style={{ minWidth: pageW + 48 }}>
          {pdf && pages.map((n) => <PdfPage key={n} pdf={pdf} n={n} width={pageW} root={root} ratio0={ratio0} />)}
        </div>
      </div>
    </ViewerChrome>
  );
}

// ---- text / script documents -----------------------------------------------------------------

export function ScreenplayView({ elements }: { elements: ScreenplayElement[] }) {
  return (
    <div className="sp">
      {elements.map((e, i) => {
        if (e.type === 'section') return <div key={i} className="sp-section">{e.text}</div>;
        return <div key={i} className={`sp-${e.type}`}>{e.text}</div>;
      })}
    </div>
  );
}

const fmtWhen = (t: number) => new Date(t).toLocaleString();

export function TextViewer({ item, onClose, onNav }: BodyProps) {
  const id = item.mediaId!;
  const [doc, setDoc] = useState<DocPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    api.document(id).then((d) => live && setDoc(d)).catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [id]);

  const dirty = editing && !!doc && draft !== doc.text;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const guard = useCallback(() => !dirtyRef.current || window.confirm('Discard unsaved changes?'), []);
  const close = useCallback(() => { if (guard()) onClose(); }, [guard, onClose]);
  const nav = useCallback((d: 1 | -1) => { if (guard()) onNav(d); }, [guard, onNav]);

  const adopt = (p: DocPayload) => {
    setDoc(p);
    boardStore.patchEverywhere(item.id, (it) => ({ ...it, textPreview: p.textPreview })); // refresh the board card
  };
  const save = useCallback(async () => {
    if (!doc || busy) return;
    setBusy(true);
    setNote('');
    try {
      adopt(await api.saveDocument(id, draft));
      setEditing(false);
      setNote('Saved');
    } catch (e) {
      setNote(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, busy, id, draft]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const latest = doc?.versions[0]?.id;
  const viewingOld = !!doc && doc.current !== latest;

  const pick = async (versionId: string) => {
    if (!doc || versionId === doc.current || !guard()) return;
    setEditing(false);
    setNote('');
    try {
      setDoc(await api.document(id, versionId));
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const restore = async () => {
    if (!doc || busy) return;
    setBusy(true);
    try {
      adopt(await api.restoreDocument(id, doc.current));
      setNote('Restored as a new version');
    } catch (e) {
      setNote(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const startEdit = () => {
    if (!doc) return;
    setDraft(doc.text);
    setEditing(true);
    setNote('');
    setTimeout(() => ta.current?.focus(), 0);
  };
  const cancelEdit = useCallback(() => { if (guard()) setEditing(false); }, [guard]);

  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      if (editing) void saveRef.current();
      return true; // never the browser's "save page"
    }
    if (e.key === 'Escape' && editing) {
      cancelEdit();
      return true;
    }
    return false;
  }, [editing, cancelEdit]);

  const body = useMemo(() => {
    if (!doc) return null;
    if (doc.format === 'fdx') return <ScreenplayView elements={(doc.elements ?? []) as ScreenplayElement[]} />;
    if (doc.format === 'fountain') return <ScreenplayView elements={parseFountain(doc.text)} />;
    if (doc.format === 'md') return <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.text) }} />;
    return <pre className="txt-body">{doc.text}</pre>;
  }, [doc]);

  const nSaved = doc ? doc.versions.length - 1 : 0;
  return (
    <ViewerChrome
      item={item} onClose={close} onNav={nav} onKey={onKey}
      footer={doc && <span>{doc.format.toUpperCase()}{doc.lines != null ? ` · ${doc.lines.toLocaleString('en-US')} lines · ${doc.words?.toLocaleString('en-US')} words` : ''}</span>}
    >
      <div className="doc-bar" onMouseDown={(e) => !isTyping(e.target) && e.preventDefault()}>
        {doc?.editable && !editing && !viewingOld && <button onClick={startEdit}>Edit</button>}
        {editing && (
          <>
            <button className="primary" onClick={() => void save()} disabled={busy || !dirty} title="Save (Ctrl+S)">Save</button>
            <button onClick={cancelEdit} title="Cancel (Esc)">Cancel</button>
          </>
        )}
        {viewingOld && <button className="primary" onClick={() => void restore()} disabled={busy}>Restore this version</button>}
        {doc && doc.editable && (
          <label className="doc-versions">
            Versions
            <select value={doc.current} onChange={(e) => void pick(e.target.value)} disabled={editing || busy}>
              {doc.versions.map((v, i) => (
                <option key={v.id} value={v.id}>
                  {v.id === 'original' ? 'Original upload' : `v${nSaved - i}`} · {fmtWhen(v.createdAt)}{v.id === latest ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {doc && !doc.editable && <span className="doc-note">Read-only (Final Draft)</span>}
        {dirty && <span className="doc-note">Unsaved changes</span>}
        {note && <span className="doc-note">{note}</span>}
      </div>
      <div className="doc-scroll" onWheel={(e) => e.stopPropagation()}>
        {err && <div className="viewer-empty">{err}</div>}
        {!doc && !err && <div className="viewer-empty">Loading…</div>}
        {doc && editing && (
          <textarea
            ref={ta}
            className="doc-edit"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
        {doc && !editing && <div className="doc-page">{body}</div>}
      </div>
    </ViewerChrome>
  );
}
