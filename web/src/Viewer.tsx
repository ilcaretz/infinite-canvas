import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClickGate } from './clickGate';
import { InfoPanel } from './InfoPanel';
import { AudioViewer, PdfViewer, TextViewer } from './ViewerDocs';
import { normalizeWheelDelta, wheelZoomFactor } from './geometry';
import type { Item } from './types';
import {
  boardOrder, docViewKind, fitScale, formatTimecode, frameIndex, frameMidTime, isViewable, neighbour, PIXELATE_ABOVE, safeFps,
  stepFrame, toggleFit100, totalFrames, zoomAt, zoomLabel, type View,
} from './viewerLogic';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const CLICK_SLOP = 3;

function fmtBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Local blob URL while uploading, else the playable preview, else the original (direct media). */
export const viewerSrc = (it: Item): string | null => it.src ?? it.previewUrl ?? it.originalUrl ?? null;

interface Props {
  items: Record<string, Item>;
  startId: string;
  /** Seek the first (video) item to this time on open . */
  startMs?: number;
  onClose: () => void;
}

export function Viewer({ items, startId, startMs, onClose }: Props) {
  const [id, setId] = useState(startId);
  const order = useMemo(
    () => boardOrder(Object.values(items).filter(isViewable)).map((i) => i.id),
    [items],
  );
  const item = items[id];

  const go = useCallback((dir: 1 | -1) => {
    const n = neighbour(order, id, dir);
    if (n) setId(n);
  }, [order, id]);

  // Item vanished (deleted elsewhere): close.
  useEffect(() => {
    if (!item || !isViewable(item)) onClose();
  }, [item, onClose]);

  if (!item || !isViewable(item)) return null;
  const body = item.kind === 'audio'
    ? <AudioViewer key={item.id} item={item} onClose={onClose} onNav={go} />
    : item.kind === 'document'
      ? docViewKind(item) === 'pdf'
        ? <PdfViewer key={item.id} item={item} onClose={onClose} onNav={go} />
        : <TextViewer key={item.id} item={item} onClose={onClose} onNav={go} />
      : <ViewerBody key={item.id} item={item} onClose={onClose} onNav={go} startMs={item.id === startId ? startMs : undefined} />;
  return createPortal(body, document.body);
}

function ViewerBody({ item, onClose, onNav, startMs }: {
  item: Item; onClose: () => void; onNav: (d: 1 | -1) => void; startMs?: number;
}) {
  const isVideo = item.kind === 'video';
  const src = viewerSrc(item);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLImageElement & HTMLVideoElement>(null);

  const [nat, setNat] = useState({ w: item.pxW ?? 0, h: item.pxH ?? 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [fitted, setFitted] = useState(true);
  const fit = fitScale(stage.w, stage.h, nat.w, nat.h);
  const stateRef = useRef({ view, fit, fitted });
  stateRef.current = { view, fit, fitted };

  // Stage size.
  useLayoutEffect(() => {
    const el = stageRef.current!;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While "fitted", track the fit scale (open, resize, natural size arriving).
  useLayoutEffect(() => {
    if (fitted && nat.w > 0) setView({ s: fit, tx: 0, ty: 0 });
  }, [fit, fitted, nat.w]);

  const setZoom = (v: View) => {
    setFitted(false);
    setView(v);
  };

  // ---- wheel zoom (non-passive so the page never scrolls) -----------------------------
  useEffect(() => {
    const el = stageRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      const dy = normalizeWheelDelta(e.deltaY, e.deltaMode, r.height);
      const { view: v, fit: f } = stateRef.current;
      setFitted(false);
      setView(zoomAt(v, wheelZoomFactor(dy), px, py, f));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- pan (left or middle drag); a still left click on a video toggles play -----------
  const drag = useRef<{ pid: number; sx: number; sy: number; tx: number; ty: number; moved: boolean; button: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const v = stateRef.current.view;
    drag.current = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, tx: v.tx, ty: v.ty, moved: false, button: e.button };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    if (!d.moved) setGrabbing(true);
    d.moved = true;
    setFitted(false);
    setView({ ...stateRef.current.view, tx: d.tx + dx, ty: d.ty + dy });
  };
  // A still click on the video toggles play after a short delay; a double click (fit <-> 100 %) cancels it.
  const toggleRef = useRef<() => void>(() => {});
  const [gate] = useState(() => createClickGate<string>(() => toggleRef.current()));
  useEffect(() => () => gate.cancel(), [gate]);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef(false);
  infoRef.current = infoOpen;
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    drag.current = null;
    setGrabbing(false);
    if (!d.moved && d.button === 0 && isVideo && (e.target as HTMLElement).tagName === 'VIDEO') gate.click('v');
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    gate.dblclick('v');
    const r = stageRef.current!.getBoundingClientRect();
    const { view: v, fit: f } = stateRef.current;
    const nv = toggleFit100(v, f, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    if (nv.s === f && nv.tx === 0 && nv.ty === 0) {
      setFitted(true);
      setView(nv);
    } else setZoom(nv);
  };

  // ---- video state ---------------------------------------------------------------------
  const vid = () => (isVideo ? (mediaRef.current as HTMLVideoElement | null) : null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const fps = safeFps(item.fps);
  const total = totalFrames(duration, fps);
  const timeRef = useRef(0);
  timeRef.current = time;

  // Keep the time display in sync: per presented frame (rVFC) when available, else rAF.
  useEffect(() => {
    const v = vid();
    if (!v) return;
    let stop = false;
    let h = 0;
    const hasRvfc = 'requestVideoFrameCallback' in v;
    const tick = (_now?: number, meta?: { mediaTime?: number }) => {
      if (stop) return;
      setTime(meta?.mediaTime ?? v.currentTime);
      h = hasRvfc ? v.requestVideoFrameCallback(tick as never) : requestAnimationFrame(tick as never);
    };
    h = hasRvfc ? v.requestVideoFrameCallback(tick as never) : requestAnimationFrame(tick as never);
    return () => {
      stop = true;
      if (hasRvfc) v.cancelVideoFrameCallback(h);
      else cancelAnimationFrame(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo]);

  const togglePlay = useCallback(() => {
    const v = vid();
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo]);

  toggleRef.current = togglePlay;

  const step = useCallback((delta: number) => {
    const v = vid();
    if (!v) return;
    v.pause();
    const dur = v.duration;
    const tot = totalFrames(dur, fps);
    const n = stepFrame(v.currentTime, fps, tot, delta);
    v.currentTime = frameMidTime(n, fps);
    // Show the frame that was actually presented once the seek lands.
    if ('requestVideoFrameCallback' in v) {
      v.requestVideoFrameCallback((_n, meta) => setTime(meta.mediaTime));
    }
    setTime(frameMidTime(n, fps));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, fps]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const v = vid();
    if (v) v.playbackRate = speed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, isVideo]);

  // ---- keyboard (captured: board shortcuts never see these) -----------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      const big = e.shiftKey ? 10 : 1;
      if (k === 'Escape') {
        if (infoRef.current) setInfoOpen(false);
        else onClose();
      }
      else if (k === 'i' || k === 'I') setInfoOpen((o) => !o);
      else if (k === 'ArrowLeft') isVideo ? step(-big) : onNav(-1);
      else if (k === 'ArrowRight') isVideo ? step(big) : onNav(1);
      else if (k === 'PageUp') onNav(-1);
      else if (k === 'PageDown') onNav(1);
      else if (isVideo && (e.code === 'Space' || k === ' ' || k === 'Spacebar')) {
        if (!e.repeat) togglePlay();
      }
      else if (isVideo && k === ',') step(-1);
      else if (isVideo && k === '.') step(1);
      else if (isVideo && (k === 'f' || k === 'F')) toggleFullscreen();
      else if (isVideo && (k === 'm' || k === 'M')) setMuted((m) => !m);
      else if (isVideo && (k === 'l' || k === 'L')) setLoop((l) => !l);
      else handled = k === 'Enter' || k === 'Delete' || k === 'Backspace' || k === 'Tab' || k === 'PageUp' || k === 'PageDown';
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else e.stopPropagation();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [onClose, onNav, isVideo, togglePlay, step, toggleFullscreen]);

  // ---- scrub bar -------------------------------------------------------------------------
  const barRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const seekTo = (clientX: number) => {
    const v = vid();
    const bar = barRef.current;
    if (!v || !bar || !(v.duration > 0)) return;
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const n = frameIndex(f * v.duration, fps, totalFrames(v.duration, fps));
    v.currentTime = frameMidTime(n, fps);
    setTime(v.currentTime);
  };

  const cur = frameIndex(time, fps, total);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const mediaStyle: React.CSSProperties = {
    width: nat.w || undefined,
    height: nat.h || undefined,
    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`,
    imageRendering: view.s > PIXELATE_ABOVE ? 'pixelated' : 'auto',
    visibility: nat.w ? 'visible' : 'hidden',
  };
  const noFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="viewer" ref={rootRef} onContextMenu={(e) => e.preventDefault()}>
      <button className="viewer-close" onMouseDown={noFocus} onClick={onClose} title="Close (Esc)" aria-label="Close">
        ×
      </button>
      <div
        className={`viewer-stage${grabbing ? ' grabbing' : ''}`}
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onAuxClick={(e) => e.preventDefault()}
      >
        {src &&
          (isVideo ? (
            <video
              ref={mediaRef}
              src={src}
              className="viewer-media"
              style={mediaStyle}
              autoPlay
              muted={muted}
              loop={loop}
              playsInline
              draggable={false}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                setDuration(v.duration);
                if (startMs != null) {
                  v.pause();
                  v.currentTime = startMs / 1000;
                  setTime(startMs / 1000);
                }
                if (v.videoWidth && !(item.pxW && item.pxH)) setNat({ w: v.videoWidth, h: v.videoHeight });
                else if (v.videoWidth) setNat({ w: item.pxW!, h: item.pxH! });
              }}
              onDurationChange={(e) => setDuration(e.currentTarget.duration)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            />
          ) : (
            <img
              ref={mediaRef}
              src={src}
              className="viewer-media"
              style={mediaStyle}
              alt={item.name}
              draggable={false}
              onLoad={(e) => {
                const i = e.currentTarget;
                setNat(item.pxW && item.pxH ? { w: item.pxW, h: item.pxH } : { w: i.naturalWidth, h: i.naturalHeight });
              }}
            />
          ))}
        {!src && <div className="viewer-empty">Not available</div>}
      </div>

      <button className="viewer-nav prev" onMouseDown={noFocus} onClick={() => onNav(-1)} title="Previous (PageUp)" aria-label="Previous">‹</button>
      <button className="viewer-nav next" onMouseDown={noFocus} onClick={() => onNav(1)} title="Next (PageDown)" aria-label="Next">›</button>

      {isVideo && (
        <div className="viewer-controls" onMouseDown={noFocus}>
          <button onClick={togglePlay} title="Play / pause (Space)">{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => step(-1)} title="Previous frame (Left or ,)  Shift = 10">|◀</button>
          <button onClick={() => step(1)} title="Next frame (Right or .)  Shift = 10">▶|</button>
          <span className="viewer-time">{formatTimecode(time, fps)}</span>
          <div
            className="viewer-scrub"
            ref={barRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              scrubbing.current = true;
              seekTo(e.clientX);
            }}
            onPointerMove={(e) => scrubbing.current && seekTo(e.clientX)}
            onPointerUp={() => (scrubbing.current = false)}
            onPointerCancel={() => (scrubbing.current = false)}
          >
            <div className="viewer-scrub-fill" style={{ width: `${pct}%` }} />
            <div className="viewer-scrub-knob" style={{ left: `${pct}%` }} />
          </div>
          <span className="viewer-frame">f {total ? cur + 1 : 0} / {total}</span>
          <button className={loop ? 'on' : ''} onClick={() => setLoop((l) => !l)} title="Loop (L)">⟲</button>
          <button className={muted ? '' : 'on'} onClick={() => setMuted((m) => !m)} title="Mute (M)">{muted ? '🔇' : '🔊'}</button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Speed">
            {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
          </select>
          <button onClick={toggleFullscreen} title="Fullscreen (F)">⛶</button>
        </div>
      )}

      {infoOpen && <InfoPanel mediaId={item.mediaId} name={item.name} />}

      <div className="viewer-footer">
        <span className="viewer-name">{item.name}</span>
        {nat.w > 0 && <span>{nat.w} × {nat.h} px</span>}
        {item.sizeBytes > 0 && <span>{fmtBytes(item.sizeBytes)}</span>}
        {isVideo && <span>{Number.isInteger(fps) ? fps : fps.toFixed(3)} fps</span>}
        <span className="viewer-zoom">{zoomLabel(view.s)}</span>
      </div>
    </div>
  );
}
