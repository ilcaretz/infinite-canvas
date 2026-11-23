import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { pauseOtherAudio } from './audioControl';
import { toCard } from './files';
import { fmtClock } from './format';
import { boardStore } from './store';
import type { Item, UploadInfo } from './types';
import { retryUpload } from './uploads';
import { FRAME_PRESENTED } from './videoStep';
import { GROUP_COLORS, GROUP_TITLE_H, groupProps, hexA } from './groupLogic';
import { TEXT_LINE_HEIGHT, textProps } from './textLogic';
import { frameIndex, safeFps, totalFrames } from './viewerLogic';

interface Props {
  item: Item;
  selected: boolean;
  /** false = far outside the viewport: media src is removed to free decoders/memory. */
  live: boolean;
  /** 0 = small on screen (thumb), 2 = large (full preview), 1 = in between (keep whatever is showing). */
  lod: 0 | 1 | 2;
  upload?: UploadInfo;
  /** Show the small source badge (item is big enough on screen). */
  showSource?: boolean;
  /** text item: in edit mode; group: title being renamed. */
  editing?: boolean;
  /** Finish an edit (text content or group title). Enter, Esc and blur all commit. */
  onEditDone?: (id: string, value: string) => void;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'mxf', 'm4v']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'heic', 'heif', 'psd', 'exr', 'hdr', 'webp', 'gif', 'avif', 'svg', 'bmp']);

function TypeIcon({ ext }: { ext: string }) {
  const common = { width: 40, height: 40, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (VIDEO_EXT.has(ext)) {
    return (
      <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9.5v5l4.5-2.5z" /></svg>
    );
  }
  if (AUDIO_EXT.has(ext)) {
    return (
      <svg {...common}><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></svg>
    );
  }
  if (IMAGE_EXT.has(ext)) {
    return (
      <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="M21 16l-5-5-8 9" /></svg>
    );
  }
  return (
    <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></svg>
  );
}

/**
 * Shows `url`, but when it changes keeps the previous picture on screen until the new one is decoded
 * (thumb -> full, object URL -> server URL): no blank frame, no visible jump.
 */
function useSwapped(url: string | null): string | null {
  const [shown, setShown] = useState<string | null>(url);
  useEffect(() => {
    if (url === shown) return;
    if (!url) {
      setShown(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = img.onerror = () => {
      if (!cancelled) setShown(url);
    };
    img.src = url;
    return () => {
      cancelled = true;
      img.onload = img.onerror = null;
    };
  }, [url, shown]);
  return shown;
}

/**
 * Once the server copy of the picture is loadable, drop the local object URL (and revoke it).
 * The server tier is preloaded first so the swap is invisible.
 */
function useDropLocalSrc(item: Item, live: boolean, tierUrl: string | null) {
  const { id, src } = item;
  useEffect(() => {
    if (!src || !tierUrl) return;
    let cancelled = false;
    const drop = () => {
      if (cancelled) return;
      boardStore.patchEverywhere(id, (it) => (it.src === src ? { ...it, src: null } : it));
      window.setTimeout(() => URL.revokeObjectURL(src), 3000);
    };
    if (!live) {
      drop();
      return;
    }
    const img = new Image();
    img.onload = drop;
    img.onerror = drop;
    img.src = tierUrl;
    return () => {
      cancelled = true;
      img.onload = img.onerror = null;
    };
  }, [id, src, tierUrl, live]);
}

function useFull(lod: 0 | 1 | 2): boolean {
  const prev = useRef(false);
  const full = lod === 2 || (lod === 1 && prev.current);
  prev.current = full;
  return full;
}

function ImageBody({ item, live, lod }: { item: Item; live: boolean; lod: 0 | 1 | 2 }) {
  const full = useFull(lod);
  const tier = full ? item.previewUrl ?? item.thumbUrl ?? null : item.thumbUrl ?? item.previewUrl ?? null;
  useDropLocalSrc(item, live, tier);
  const shown = useSwapped(live ? item.src ?? tier : null);
  return (
    <img
      src={shown ?? undefined}
      alt=""
      draggable={false}
      onError={(e) => {
        if (e.currentTarget.getAttribute('src') && !item.mediaId) boardStore.patchEverywhere(item.id, toCard);
      }}
    />
  );
}

function VideoBody({ item, live, lod, selected }: { item: Item; live: boolean; lod: 0 | 1 | 2; selected: boolean }) {
  const full = useFull(lod);
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [stepped, setStepped] = useState(false); // paused on a frame the user stepped to
  const [fc, setFc] = useState<{ cur: number; total: number } | null>(null);
  const poster = full ? item.posterUrl ?? item.thumbUrl ?? null : item.thumbUrl ?? item.posterUrl ?? null;
  useDropLocalSrc(item, live, poster);
  const local = !!item.src;
  const posterShown = useSwapped(live && !local ? poster : null);
  const fps = safeFps(item.fps);

  // The <video> is loaded whenever the item is near the viewport (so it can play / step) and unloaded far away.
  // '#t=0.001' makes a local object URL show its first frame.
  const wanted = live ? (item.src ? `${item.src}#t=0.001` : item.previewUrl ?? null) : null;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (wanted) {
      if (v.getAttribute('src') !== wanted) v.src = wanted;
    } else if (v.getAttribute('src')) {
      v.pause();
      v.removeAttribute('src');
      v.load();
      setPlaying(false);
      setStepped(false);
      setFc(null);
    }
  }, [wanted]);

  // Frame counter bookkeeping.
  const sync = useCallback((t?: number) => {
    const v = ref.current;
    if (!v || !(v.duration > 0)) return;
    const total = totalFrames(v.duration, fps);
    const cur = frameIndex(t ?? v.currentTime, fps, total) + 1;
    setFc((p) => (p && p.cur === cur && p.total === total ? p : { cur, total }));
  }, [fps]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onPresented = (e: Event) => {
      setStepped(true);
      sync((e as CustomEvent<number>).detail);
    };
    const onSeeked = () => sync();
    const onPlayEv = () => setStepped(false);
    v.addEventListener(FRAME_PRESENTED, onPresented);
    for (const n of ['loadedmetadata', 'durationchange', 'seeked', 'pause', 'timeupdate']) v.addEventListener(n, onSeeked);
    v.addEventListener('play', onPlayEv);
    return () => {
      v.removeEventListener(FRAME_PRESENTED, onPresented);
      for (const n of ['loadedmetadata', 'durationchange', 'seeked', 'pause', 'timeupdate']) v.removeEventListener(n, onSeeked);
      v.removeEventListener('play', onPlayEv);
    };
  }, [sync]);
  // While selected and playing: follow every presented frame.
  useEffect(() => {
    const v = ref.current;
    if (!v || !selected || !playing) return;
    const hasRvfc = 'requestVideoFrameCallback' in v;
    let stop = false;
    let h = 0;
    const tick = (_n?: number, m?: { mediaTime: number }) => {
      if (stop) return;
      sync(m?.mediaTime);
      h = hasRvfc ? v.requestVideoFrameCallback(tick as never) : requestAnimationFrame(() => tick());
    };
    tick();
    return () => {
      stop = true;
      if (hasRvfc) v.cancelVideoFrameCallback(h);
      else cancelAnimationFrame(h);
    };
  }, [selected, playing, sync]);

  const ready = !!wanted;
  const iconSize = `clamp(calc(32px / var(--z)), ${0.25 * Math.min(item.w, item.h)}px, calc(72px / var(--z)))`;
  return (
    <div className="media">
      <video
        ref={ref}
        poster={posterShown ?? undefined}
        muted
        loop
        playsInline
        preload="metadata"
        draggable={false}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={(e) => {
          if (local && e.currentTarget.getAttribute('src') && !item.mediaId) boardStore.patchEverywhere(item.id, toCard);
        }}
      />
      {ready && !playing && (
        <div className="play-icon" style={{ width: iconSize, height: iconSize }}>
          <svg viewBox="0 0 24 24"><path d="M6 3.5v17l14-8.5z" /></svg>
        </div>
      )}
      {fc && (selected || stepped) && <div className="frame-counter">f {fc.cur} / {fc.total}</div>}
      <div className="badge">
        <span>{playing ? '❚❚' : '▶'}</span>
        {item.durationMs != null && <span>{fmtDuration(item.durationMs)}</span>}
      </div>
    </div>
  );
}

function AudioBody({ item, live }: { item: Item; live: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const wave = useSwapped(live ? item.thumbUrl ?? null : null);
  const src = live ? item.previewUrl ?? null : null;
  const durS = item.durationMs != null ? item.durationMs / 1000 : null;

  // Load the file only while the card is near the viewport (like videos).
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (src) {
      if (a.getAttribute('src') !== src) a.src = src;
    } else if (a.getAttribute('src')) {
      a.pause();
      a.removeAttribute('src');
      a.load();
      setPlaying(false);
      setCur(0);
    }
  }, [src]);

  // Playhead: a thin line over the waveform, moved straight on the DOM (no React render per frame).
  const place = useCallback(() => {
    const a = ref.current;
    const line = lineRef.current;
    if (!a || !line) return;
    const d = a.duration > 0 ? a.duration : durS ?? 0;
    const f = d > 0 ? Math.min(1, a.currentTime / d) : 0;
    line.style.left = `${f * 100}%`;
    line.style.opacity = f > 0 || !a.paused ? '1' : '0';
  }, [durS]);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onTime = () => {
      place();
      setCur(a.currentTime);
    };
    const evs = ['timeupdate', 'seeked', 'loadedmetadata', 'ended', 'pause'];
    for (const n of evs) a.addEventListener(n, onTime);
    return () => {
      for (const n of evs) a.removeEventListener(n, onTime);
    };
  }, [place]);
  useEffect(() => {
    if (!playing) return;
    let h = 0;
    const tick = () => {
      place();
      h = requestAnimationFrame(tick);
    };
    h = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(h);
  }, [playing, place]);

  return (
    <div className="audio-card">
      <audio
        ref={ref}
        preload="metadata"
        onPlay={(e) => {
          pauseOtherAudio(e.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <div className="audio-wave">
        {wave && <img src={wave} alt="" draggable={false} />}
        <div className="audio-playhead" ref={lineRef} />
      </div>
      <div className="audio-bar">
        <span className="audio-play">{playing ? '❚❚' : '▶'}</span>
        <span className="audio-name" title={item.name}>{item.name}</span>
        <span className="audio-time">
          {playing || cur > 0 ? `${fmtClock(cur)} / ` : ''}
          {durS != null ? fmtClock(durS) : '--:--'}
        </span>
      </div>
    </div>
  );
}

function PdfBody({ item, live }: { item: Item; live: boolean }) {
  const shown = useSwapped(live ? item.thumbUrl ?? null : null);
  return (
    <div className="media">
      <img src={shown ?? undefined} alt="" draggable={false} />
      {!!item.pages && <div className="badge"><span>{item.pages === 1 ? '1 page' : `${item.pages} pages`}</span></div>}
    </div>
  );
}

function TextBody({ item }: { item: Item }) {
  const ext = (item.ext || 'txt').toUpperCase();
  return (
    <div className="doc-text">
      <div className="doc-text-head">
        <span className="doc-text-ext">{ext}</span>
        <span className="doc-text-name" title={item.name}>{item.name}</span>
      </div>
      <pre className={`doc-text-body ${item.ext === 'md' ? 'md' : 'mono'}`}>{item.textPreview}</pre>
    </div>
  );
}

/** Text item: drawn straight on the board (transparent). Height follows the content; the measured height is reported back silently. */
function TextItemBody({ item, editing, onEditDone }: { item: Item; editing: boolean; onEditDone?: (id: string, value: string) => void }) {
  const p = textProps(item.props);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(p.text);
  const done = useRef(false);
  useEffect(() => {
    if (!editing) return;
    done.current = false;
    setDraft(p.text);
    const t = areaRef.current;
    if (t) {
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const hh = el.offsetHeight; // layout px, unaffected by the board's scale transform
      const cur = boardStore.getState().items[item.id];
      if (cur && hh > 0 && Math.abs(cur.h - hh) > 0.5) boardStore.patchEverywhere(item.id, (it) => ({ ...it, h: hh }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.id]);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onEditDone?.(item.id, draft);
  };
  const style: React.CSSProperties = {
    fontSize: p.size, lineHeight: TEXT_LINE_HEIGHT, color: p.color, fontWeight: p.bold ? 700 : 400, textAlign: p.align,
  };
  return (
    <div className="text-box" ref={boxRef} style={style}>
      {editing ? (
        <div className="text-edit" data-nodrag data-v={draft + '\n'}>
          <textarea
            ref={areaRef}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                finish();
                e.currentTarget.blur();
              }
            }}
          />
        </div>
      ) : (
        <div className="text-view">{p.text.endsWith('\n') ? p.text + '\n' : p.text}</div>
      )}
    </div>
  );
}

/** Group: translucent frame + title bar. Only the title bar takes pointer events (the body is click-through). */
function GroupBody({ item, editing, onEditDone }: { item: Item; editing: boolean; onEditDone?: (id: string, value: string) => void }) {
  const p = groupProps(item.props);
  const done = useRef(false);
  const [draft, setDraft] = useState(p.title);
  useEffect(() => {
    if (editing) {
      done.current = false;
      setDraft(p.title);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onEditDone?.(item.id, draft);
  };
  const recolor = (value: string) => {
    if (value === p.color) return;
    boardStore.edit('color', { [item.id]: { props: { ...p, color: value } } });
  };
  return (
    <>
      <div className="group-frame" style={{ background: hexA(p.color, 0.18), borderColor: hexA(p.color, 0.5) }} />
      <div
        className="group-title"
        data-item-id={item.id}
        style={{ height: Math.min(GROUP_TITLE_H, item.h), background: hexA(p.color, 0.7) }}
      >
        {editing ? (
          <input
            className="group-rename"
            data-nodrag
            autoFocus
            value={draft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                finish();
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span className="group-title-text">{p.title || 'Group'}</span>
        )}
        <span className="group-dots" data-nodrag>
          {GROUP_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`group-dot${c.value === p.color ? ' active' : ''}`}
              style={{ background: c.value }}
              title={c.name}
              aria-label={`Group colour ${c.name}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => recolor(c.value)}
            />
          ))}
        </span>
      </div>
    </>
  );
}

function Overlay({ upload }: { upload: UploadInfo }) {
  const pct = Math.round(upload.progress * 100);
  if (upload.state === 'uploading' || upload.state === 'queued') {
    return (
      <div className="ov-bar" title={upload.state === 'queued' ? 'Queued' : `Uploading ${pct}%`}>
        <div className="ov-fill" style={{ width: `${upload.state === 'queued' ? 0 : pct}%` }} />
      </div>
    );
  }
  if (upload.state === 'processing') {
    return (
      <>
        <div className="ov-bar">
          {upload.progress > 0 ? <div className="ov-fill proc" style={{ width: `${pct}%` }} /> : <div className="ov-fill indet" />}
        </div>
        <div className="ov-chip">{upload.progress > 0 ? `Transcoding ${pct}%` : 'Processing…'}</div>
      </>
    );
  }
  if (upload.state === 'downloading') {
    return (
      <div className="ov-bar">
        <div className="ov-fill indet" />
      </div>
    );
  }
  return null;
}

function Card({ item, upload }: { item: Item; upload?: UploadInfo }) {
  const failedMedia = item.status === 'failed';
  let meta = `${(item.ext || 'file').toUpperCase()} · ${fmtSize(item.sizeBytes)}`;
  if (upload?.state === 'downloading') meta = 'Downloading…';
  if (failedMedia) meta = "Can't be previewed";
  return (
    <div className={`card${failedMedia ? ' failed' : ''}`}>
      <TypeIcon ext={item.ext} />
      <div className="card-name" title={item.name}>{item.name}</div>
      {upload?.state === 'dlfailed' ? (
        <>
          <div className="card-meta err" title={upload.error}>Download failed{upload.error ? `: ${upload.error}` : ''}</div>
          <button
            className="card-btn"
            data-nodrag
            onClick={() => window.dispatchEvent(new CustomEvent('board:replace-file', { detail: item.id }))}
          >
            Upload file instead
          </button>
        </>
      ) : (
        <div className="card-meta">{meta}</div>
      )}
      {failedMedia && !!item.mediaId && (
        <a className="card-btn" data-nodrag href={`/api/items/${item.id}/original`} download>Download original</a>
      )}
    </div>
  );
}

function ItemViewImpl({ item, selected, live, lod, upload, showSource, editing = false, onEditDone }: Props) {
  if (item.kind === 'group') {
    return (
      <div
        className={`item item-group${selected ? ' selected' : ''}`}
        style={{ transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, height: item.h, zIndex: item.z }}
      >
        <GroupBody item={item} editing={editing} onEditDone={onEditDone} />
      </div>
    );
  }
  if (item.kind === 'text') {
    return (
      <div
        className={`item item-text${selected ? ' selected' : ''}${editing ? ' editing' : ''}`}
        data-item-id={item.id}
        style={{ transform: `translate(${item.x}px, ${item.y}px)`, width: item.w, zIndex: item.z }}
      >
        <TextItemBody item={item} editing={editing} onEditDone={onEditDone} />
      </div>
    );
  }
  const ready = item.status === 'ready';
  const audio = item.kind === 'audio' && ready;
  const pdf = item.kind === 'document' && ready && !!item.thumbUrl;
  const text = item.kind === 'document' && ready && item.textPreview != null;
  const asCard = !(item.kind === 'image' || item.kind === 'video' || audio || pdf || text) || item.status === 'failed';
  return (
    <div
      className={`item item-${item.kind}${selected ? ' selected' : ''}`}
      data-item-id={item.id}
      style={{
        transform: `translate(${item.x}px, ${item.y}px)`,
        width: item.w,
        height: item.h,
        zIndex: item.z,
      }}
    >
      {!asCard && item.kind === 'image' && <ImageBody item={item} live={live} lod={lod} />}
      {!asCard && item.kind === 'video' && <VideoBody item={item} live={live} lod={lod} selected={selected} />}
      {audio && <AudioBody item={item} live={live} />}
      {pdf && <PdfBody item={item} live={live} />}
      {text && <TextBody item={item} />}
      {asCard && <Card item={item} upload={upload} />}
      {showSource && item.source === 'ComfyUI' && <img className="src-badge" src="/comfyui-logo.svg" alt="ComfyUI" title="Made in ComfyUI" draggable={false} />}
      {upload && <Overlay upload={upload} />}
      {upload?.state === 'failed' && (
        <div className="ov-fail">
          <button
            className="card-btn"
            data-nodrag
            title={upload.error}
            onClick={() => retryUpload(item.id)}
          >
            Upload failed — retry
          </button>
        </div>
      )}
    </div>
  );
}

export const ItemView = memo(ItemViewImpl);
