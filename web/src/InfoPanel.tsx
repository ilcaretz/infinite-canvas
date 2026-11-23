import { useEffect, useState } from 'react';
import { api, type MediaInfo } from './api';
import { fmtDur } from './format';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
const fmtBitrate = (bps: number) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mb/s` : `${Math.round(bps / 1000)} kb/s`);

const fmtSampleRate = (hz: number) => `${Number.isInteger(hz / 1000) ? hz / 1000 : (hz / 1000).toFixed(1)} kHz`;
const fmtChannels = (n: number) => (n === 1 ? 'Mono' : n === 2 ? 'Stereo' : `${n} channels`);
const fmtCount = (n: number) => n.toLocaleString('en-US');

export function infoRows(i: MediaInfo, nameOverride?: string): Array<[string, string]> {
  const c = i.compression;
  const comp = [c.codec, c.pixFmt, c.bitDepth ? `${c.bitDepth}-bit` : null, c.bitRate ? fmtBitrate(c.bitRate) : null].filter(Boolean).join(' · ');
  const rows: Array<[string, string | null]> = [
    ['Filename', nameOverride || i.filename],
    ['Type', i.kind],
    ['Format', i.kind === 'document' && i.format ? i.format.toUpperCase() : null],
    ['Resolution', i.kind !== 'document' && i.width && i.height ? `${i.width} × ${i.height}` : null],
    ['Pages', i.pages ? String(i.pages) : null],
    ['Lines', i.lines != null && i.kind === 'document' ? fmtCount(i.lines) : null],
    ['Words', i.words != null && i.kind === 'document' ? fmtCount(i.words) : null],
    ['Sample rate', i.kind === 'audio' && i.sampleRate ? fmtSampleRate(i.sampleRate) : null],
    ['Channels', i.kind === 'audio' && i.channels ? fmtChannels(i.channels) : null],
    ['Duration', i.durationMs != null && (i.kind === 'video' || i.kind === 'audio') ? fmtDur(i.durationMs) : null],
    ['FPS', i.fps ? `${Number.isInteger(i.fps) ? i.fps : i.fps.toFixed(3)}` : null],
    [i.kind === 'audio' ? 'Codec' : 'Compression', comp || null],
    ['Container', i.container],
    ['Size', fmtBytes(i.sizeBytes)],
    ['Added', new Date(i.createdAt).toLocaleString()],
    ['Source', i.sourceEvidence ? `${i.source} (${i.sourceEvidence})` : i.source],
  ];
  return rows.filter((r): r is [string, string] => r[1] != null && r[1] !== '');
}

/** Info card for one media row. Closing (Esc / I) is handled by the owner. */
export function InfoPanel({ mediaId, name, style }: { mediaId: string | null | undefined; name?: string; style?: React.CSSProperties }) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setErr(null);
    if (!mediaId) return;
    let live = true;
    api.mediaInfo(mediaId).then((i) => live && setInfo(i)).catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [mediaId]);
  return (
    <div className="info-panel" data-nodrag style={style} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      {!mediaId && <div className="info-msg">Not uploaded yet</div>}
      {mediaId && !info && !err && <div className="info-msg">Loading…</div>}
      {err && <div className="info-msg">{err}</div>}
      {info && (
        <dl>
          {infoRows(info, name).map(([k, v]) => (
            <div key={k} className={k === 'Source' ? 'info-source' : undefined}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Info card for items without media (text, group): a plain list of rows. */
export function RowsPanel({ rows, style }: { rows: Array<[string, string]>; style?: React.CSSProperties }) {
  return (
    <div className="info-panel" data-nodrag style={style} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}
