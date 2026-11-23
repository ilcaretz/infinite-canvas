import { seekBy } from './format';
import { toggleBoardVideo } from './videoStep';

/** The <audio> element currently rendered for a board item (null when it is not loaded). */
export function boardAudio(itemId: string): HTMLAudioElement | null {
  return document.querySelector<HTMLAudioElement>(`[data-item-id="${CSS.escape(itemId)}"] audio`);
}

/** Pause every playing <audio> except `keep` (one sound at a time: board cards and the viewer). */
export function pauseOtherAudio(keep?: HTMLAudioElement | null) {
  document.querySelectorAll('audio').forEach((a) => {
    if (a !== keep && !a.paused) a.pause();
  });
}

export function toggleBoardAudio(itemId: string) {
  const a = boardAudio(itemId);
  if (!a || !a.getAttribute('src')) return;
  if (a.paused) a.play().catch(() => {});
  else a.pause();
}

/** Click on a board item: play / pause its video or audio. */
export function toggleBoardMedia(itemId: string) {
  if (boardAudio(itemId)) toggleBoardAudio(itemId);
  else toggleBoardVideo(itemId);
}

/** Left / Right on a selected audio card: seek by `delta` seconds. Returns false when nothing is loaded. */
export function seekBoardAudio(itemId: string, delta: number): boolean {
  const a = boardAudio(itemId);
  if (!a || !a.getAttribute('src')) return false;
  a.currentTime = seekBy(a.currentTime, delta, a.duration);
  return true;
}
