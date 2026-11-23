import { describe, expect, it, vi } from 'vitest';
import { createClickGate } from './clickGate';
import { stepTarget } from './viewerLogic';

describe('createClickGate', () => {
  it('fires once, after the delay, for a single click', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const g = createClickGate(fn, 220);
    g.click('a');
    vi.advanceTimersByTime(219);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
    vi.useRealTimers();
  });
  it('a double click (click, click, dblclick) never fires', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const g = createClickGate(fn, 220);
    g.click('a');
    vi.advanceTimersByTime(100);
    g.click('a');
    g.dblclick('a');
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it('two slow clicks fire twice; keys are independent; cancel() clears all', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const g = createClickGate(fn, 220);
    g.click('a');
    vi.advanceTimersByTime(300);
    g.click('a');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
    g.click('a');
    g.click('b');
    g.dblclick('a');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith('b');
    g.click('c');
    g.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe('stepTarget (frame stepping)', () => {
  const fps = 24;
  const dur = 3; // 72 frames
  it('steps exactly one frame from a frame-middle time and lands mid-frame', () => {
    const t = (56 + 0.5) / fps; // frame index 56 (shown as f 57)
    expect(stepTarget(t, dur, fps, 1)).toMatchObject({ frame: 57, total: 72 });
    expect(stepTarget(t, dur, fps, -1).frame).toBe(55);
    expect(stepTarget(t, dur, fps, 1).time).toBeCloseTo(57.5 / fps, 9);
  });
  it('Shift = 10 frames, clamped to the clip', () => {
    expect(stepTarget(30.5 / fps, dur, fps, 10).frame).toBe(40);
    expect(stepTarget(30.5 / fps, dur, fps, -10).frame).toBe(20);
    expect(stepTarget(5.5 / fps, dur, fps, -10).frame).toBe(0);
    expect(stepTarget(68.5 / fps, dur, fps, 10).frame).toBe(71);
  });
  it('repeated stepping from its own output never skips or repeats a frame (also at 23.976 / 30 fps)', () => {
    for (const r of [23.976, 24, 30]) {
      let t = 0.2;
      let prev = stepTarget(t, 4, r, 0).frame;
      for (let i = 0; i < 40; i++) {
        const s = stepTarget(t, 4, r, 1);
        expect(s.frame).toBe(prev + 1);
        prev = s.frame;
        t = s.time;
      }
    }
  });
  it('falls back to 24 fps when the metadata has none', () => {
    expect(stepTarget(0, 1, 0, 1)).toMatchObject({ frame: 1, total: 24 });
    expect(stepTarget(0, 1, null, 1).total).toBe(24);
  });
  it('unknown duration: stays on frame 0', () => {
    expect(stepTarget(0, NaN, 24, 1).frame).toBe(0);
  });
});
