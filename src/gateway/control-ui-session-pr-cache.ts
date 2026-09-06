import { pruneMapToMaxSize } from "../infra/map-size.js";

const UNWATCHED_CACHE_LIMIT = 100;

/** Watched keys retain one canonical entry per cache until their lifetime ends. */
export function createSessionPullRequestCache<T>() {
  const entries = new Map<string, T>();
  const retained = new Map<string, { entry: T; watchers: Set<AbortSignal> }>();
  const pins = new WeakMap<AbortSignal, { key: string; release: () => void }>();

  const release = (signal?: AbortSignal) => {
    if (signal) {
      pins.get(signal)?.release();
    }
  };

  const retain = (key: string, entry: T, signal?: AbortSignal) => {
    if (!signal || signal.aborted || pins.get(signal)?.key === key) {
      return;
    }
    release(signal);
    const current = retained.get(key) ?? { entry, watchers: new Set<AbortSignal>() };
    retained.set(key, current);
    current.watchers.add(signal);
    const unpin = () => {
      signal.removeEventListener("abort", unpin);
      pins.delete(signal);
      current.watchers.delete(signal);
      if (current.watchers.size === 0) {
        retained.delete(key);
      }
    };
    pins.set(signal, { key, release: unpin });
    signal.addEventListener("abort", unpin, { once: true });
  };

  return {
    get(key: string, signal?: AbortSignal): T | undefined {
      if (signal && pins.get(signal)?.key !== key) {
        release(signal);
      }
      const entry = retained.get(key)?.entry ?? entries.get(key);
      if (entry !== undefined) {
        retain(key, entry, signal);
      }
      return entry;
    },
    set(key: string, entry: T, signal?: AbortSignal): void {
      // Refreshes replace the shared value, never a private copy held by one watcher.
      const current = retained.get(key);
      if (current) {
        current.entry = entry;
      }
      entries.delete(key);
      entries.set(key, entry);
      pruneMapToMaxSize(entries, UNWATCHED_CACHE_LIMIT);
      retain(key, entry, signal);
    },
    release,
  };
}
