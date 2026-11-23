import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { writePsd } from 'ag-psd';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function ff(args: string[]) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr}`);
}

export const ffmpegAvailable = (() => {
  try {
    return spawnSync(FFMPEG, ['-version']).status === 0;
  } catch {
    return false;
  }
})();

const V = (d = 1, r = 12) => ['-f', 'lavfi', '-i', `testsrc=s=320x240:r=${r}:d=${d}`];
const A = (d = 1) => ['-f', 'lavfi', '-i', `sine=frequency=440:d=${d}`];

/** Generates a set of sample files into a fresh temp dir. Returns name -> absolute path. */
export async function makeSamples(): Promise<{ dir: string; files: Record<string, string> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-samples-'));
  const f = (n: string) => path.join(dir, n);
  ff([...V(), '-frames:v', '1', f('a.png')]);
  ff([...V(), '-frames:v', '1', f('a.jpg')]);
  ff([...V(), '-frames:v', '1', f('a.tif')]);
  ff([...V(), '-frames:v', '1', f('a.bmp')]);
  ff([...V(1, 10), f('a.gif')]);
  ff([...V(1, 10), '-c:v', 'libwebp_anim', '-loop', '0', f('anim.webp')]);
  ff(['-f', 'lavfi', '-i', 'gradients=s=320x180:d=1:n=3,format=gbrpf32le,lutrgb=r=val*8', '-frames:v', '1', '-c:v', 'exr', f('a.exr')]);
  ff([...V(2, 24), ...A(2), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('h264.mp4')]);
  ff([...V(2, 24), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('h264_noaudio.mov')]);
  ff([...V(2, 24), ...A(2), '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('hevc.mp4')]);
  ff([...V(2, 24), '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', f('prores.mov')]);
  ff([...V(2, 24), ...A(2), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-c:a', 'libopus', '-shortest', f('vp9.webm')]);
  ff([...V(2, 24), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('h264.mkv')]);
  ff([...V(2, 24), '-vf', 'scale=321:241', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', f('odd444.mp4')]);
  await sharp({ create: { width: 200, height: 120, channels: 3, background: '#3366cc' } }).avif().toFile(f('a.avif'));
  fs.writeFileSync(f('clean.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>');
  fs.writeFileSync(
    f('evil.svg'),
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" onload="alert(1)">' +
      '<script>alert(1)</script><rect width="100" height="100" fill="blue" onclick="alert(2)" style="fill:url(http://evil.test/x)"/>' +
      '<image xlink:href="http://evil.test/p.png" width="10" height="10"/><a xlink:href="javascript:alert(3)"><circle r="5"/></a>' +
      '<foreignObject><div>hi</div></foreignObject></svg>',
  );
  const px = new Uint8ClampedArray(64 * 48 * 4).fill(200);
  const psd = writePsd({ width: 64, height: 48, imageData: { width: 64, height: 48, data: px } as unknown as ImageData }, { generateThumbnail: false });
  fs.writeFileSync(f('a.psd'), Buffer.from(psd));
  fs.writeFileSync(f('notes.txt'), 'hello world\n');
  fs.writeFileSync(f('random.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)));
  const files: Record<string, string> = {};
  for (const n of fs.readdirSync(dir)) files[n] = path.join(dir, n);
  return { dir, files };
}
