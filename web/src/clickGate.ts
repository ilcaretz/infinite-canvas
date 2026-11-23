/**
 * Single-click vs double-click disambiguation: a click only fires `fn` after `delayMs`, and a dblclick (or
 * another click on the same key, which is the first half of a double click) cancels the pending call.
 * Pure + injectable timers so it is unit-tested without a DOM.
 */
export const CLICK_DELAY_MS = 220;

export interface ClickGate<K = string> {
  click(key: K): void;
  dblclick(key: K): void;
  cancel(key?: K): void;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createClickGate<K = string>(fn: (key: K) => void, delayMs = CLICK_DELAY_MS, timers: Timers = realTimers): ClickGate<K> {
  const pending = new Map<K, unknown>();
  const drop = (key: K) => {
    if (pending.has(key)) {
      timers.clear(pending.get(key));
      pending.delete(key);
    }
  };
  return {
    click(key) {
      drop(key);
      pending.set(key, timers.set(() => {
        pending.delete(key);
        fn(key);
      }, delayMs));
    },
    dblclick: drop,
    cancel(key) {
      if (key === undefined) for (const k of [...pending.keys()]) drop(k);
      else drop(key);
    },
  };
}
