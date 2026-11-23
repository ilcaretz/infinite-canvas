import { spawn } from 'node:child_process';

export interface Tools { ffmpeg: string; ffprobe: string; soffice?: string | null }

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  bits_per_raw_sample?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: Array<{ rotation?: number }>;
  tags?: Record<string, string>;
}
export interface Probe {
  format: { format_name?: string; format_long_name?: string; duration?: string; size?: string; bit_rate?: string; tags?: Record<string, string> };
  streams: ProbeStream[];
}

function run(cmd: string, args: string[], opts: { onStdoutLine?: (l: string) => void } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      if (opts.onStdoutLine) {
        buf += d.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          opts.onStdoutLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      } else out += d.toString('utf8');
    });
    p.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
      if (err.length > 20000) err = err.slice(-10000);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

/** ffprobe as JSON. Returns null when ffprobe cannot read the file. */
export async function ffprobe(tools: Tools, file: string): Promise<Probe | null> {
  try {
    const r = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    if (r.code !== 0) return null;
    const j = JSON.parse(r.out) as Probe;
    if (!j.streams) j.streams = [];
    return j;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`ffprobe not found (${tools.ffprobe}); set FFPROBE_PATH in .env`);
    return null;
  }
}

export async function ffmpeg(tools: Tools, args: string[], onProgress?: (outTimeMs: number) => void): Promise<void> {
  try {
    const full = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
    const r = await run(tools.ffmpeg, full, {
      onStdoutLine: onProgress
        ? (l) => {
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
            // out_time_ms is (confusingly) microseconds in ffmpeg; out_time_us is the same value.
            if (m) onProgress(Number(m[1]) / 1000);
          }
        : undefined,
    });
    if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.err.trim().split('\n').slice(-3).join(' | ')}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`ffmpeg not found (${tools.ffmpeg}); set FFMPEG_PATH in .env`);
    throw e;
  }
}

export function parseFps(s?: string): number | null {
  if (!s) return null;
  const [a, b] = s.split('/').map(Number);
  if (!a || !isFinite(a)) return null;
  const v = b ? a / b : a;
  return v > 0 && v < 1000 ? Math.round(v * 1000) / 1000 : null;
}

/** Display size of a video stream (swaps width/height for 90/270 degree rotation metadata). */
export function displaySize(s: ProbeStream): { width: number; height: number } | null {
  if (!s.width || !s.height) return null;
  const rot = Math.abs(Math.round(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
  return rot === 90 ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
}
