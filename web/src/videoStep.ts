import { stepTarget } from './viewerLogic';

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

/** Fired on the <video> when a stepped frame has actually been presented (detail = media time). */
export const FRAME_PRESENTED = 'framepresented';

/**
 * Pause and step `delta` frames (seek to the middle of the target frame). Uses requestVideoFrameCallback,
 * when the browser has it, to announce the frame that was really presented.
 */
export function stepVideoElement(v: HTMLVideoElement, fps: number | null | undefined, delta: number): number | null {
  if (!(v.duration > 0)) return null;
  v.pause();
  const s = stepTarget(v.currentTime, v.duration, fps, delta);
  v.currentTime = s.time;
  const r = v as RvfcVideo;
  const announce = (mediaTime: number) => v.dispatchEvent(new CustomEvent(FRAME_PRESENTED, { detail: mediaTime }));
  if (r.requestVideoFrameCallback) r.requestVideoFrameCallback((_n, meta) => announce(meta.mediaTime));
  else v.addEventListener('seeked', () => announce(v.currentTime), { once: true });
  return s.frame;
}

/** The <video> element currently rendered for a board item (null when it is not loaded). */
export function boardVideo(itemId: string): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(`[data-item-id="${CSS.escape(itemId)}"] video`);
}

export function toggleBoardVideo(itemId: string) {
  const v = boardVideo(itemId);
  if (!v || !v.getAttribute('src')) return;
  if (v.paused) v.play().catch(() => {});
  else v.pause();
}
