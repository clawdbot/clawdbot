import type { Event } from "nostr-tools";

const CURSOR_WRITE_RETRY_MS = [0, 100, 300] as const;
const CURSOR_RECOVERY_RETRY_MS = 1_000;

/** Tracks the largest EOSE-safe Nostr timestamp without skipping undurable relay events. */
export function createNostrDurableCursor(options: {
  since: number;
  replayOverlapSec: number;
  nowSec?: () => number;
}) {
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  let durableCandidate: number | undefined;
  let transientReplayCeiling: number | undefined;
  let backfillComplete = false;

  const safeCandidate = (): number | undefined => {
    if (durableCandidate === undefined) {
      return undefined;
    }
    return Math.min(durableCandidate, transientReplayCeiling ?? Number.MAX_SAFE_INTEGER);
  };

  return {
    recordDurableAppend: (event: Event): number | undefined => {
      if (!Number.isSafeInteger(event.created_at)) {
        return undefined;
      }
      const previousSafeCandidate = safeCandidate();
      durableCandidate = Math.max(durableCandidate ?? 0, Math.min(event.created_at, nowSec()));
      const nextSafeCandidate = safeCandidate();
      return backfillComplete && nextSafeCandidate !== previousSafeCandidate
        ? nextSafeCandidate
        : undefined;
    },
    recordTransientRejection: (event: Event): number | undefined => {
      if (!Number.isSafeInteger(event.created_at) || event.created_at < options.since) {
        return undefined;
      }
      const previousSafeCandidate = safeCandidate();
      // The next since-overlap must still include this event, which was not durably appended.
      transientReplayCeiling = Math.min(
        transientReplayCeiling ?? Number.MAX_SAFE_INTEGER,
        event.created_at + options.replayOverlapSec,
      );
      const nextSafeCandidate = safeCandidate();
      return backfillComplete && nextSafeCandidate !== previousSafeCandidate
        ? nextSafeCandidate
        : undefined;
    },
    markBackfillComplete: (): number | undefined => {
      backfillComplete = true;
      return safeCandidate();
    },
  };
}

/** Serializes cursor writes so a safety rewind always lands after older progress writes. */
export function createNostrCursorStateWriter(options: {
  initialCursor: number;
  minimumCursor: number;
  debounceMs: number;
  write: (cursor: number) => Promise<void>;
  onBackgroundError?: (error: Error) => void;
  recoveryRetryMs?: number;
}) {
  let desiredCursor = Math.max(options.minimumCursor, options.initialCursor);
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  let activeFlush: Promise<void> | undefined;
  let recoveryFlush: Promise<void> | undefined;

  const writeWithRetry = async (cursor: number): Promise<void> => {
    let lastError: unknown;
    for (const delayMs of CURSOR_WRITE_RETRY_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await options.write(cursor);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Nostr cursor state write failed.", { cause: lastError });
  };

  const enqueueWrite = (cursor: number): Promise<void> => {
    const write = writeTail.then(() => writeWithRetry(cursor));
    writeTail = write.catch(() => undefined);
    return write;
  };

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const runFlush = async (): Promise<void> => {
    for (;;) {
      if (!dirty) {
        await writeTail;
        if (!dirty) {
          return;
        }
      }
      dirty = false;
      const cursor = desiredCursor;
      try {
        await enqueueWrite(cursor);
      } catch (error) {
        dirty = true;
        throw error;
      }
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    if (activeFlush) {
      return activeFlush;
    }
    const tracked = runFlush().finally(() => {
      if (activeFlush === tracked) {
        activeFlush = undefined;
      }
    });
    activeFlush = tracked;
    return tracked;
  };

  const setDesiredCursor = (cursor: number): void => {
    desiredCursor = Math.max(options.minimumCursor, cursor);
    dirty = true;
  };

  return {
    schedule: (cursor: number): void => {
      setDesiredCursor(cursor);
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        void flush().catch((error: unknown) => options.onBackgroundError?.(error as Error));
      }, options.debounceMs);
      timer.unref?.();
    },
    persistNow: async (cursor: number): Promise<void> => {
      setDesiredCursor(cursor);
      await flush();
    },
    flush,
    flushUntilSuccess: (): Promise<void> => {
      recoveryFlush ??= (async () => {
        for (;;) {
          try {
            await flush();
            return;
          } catch (error) {
            options.onBackgroundError?.(error as Error);
            await new Promise((resolve) => {
              setTimeout(resolve, options.recoveryRetryMs ?? CURSOR_RECOVERY_RETRY_MS);
            });
          }
        }
      })().finally(() => {
        recoveryFlush = undefined;
      });
      return recoveryFlush;
    },
  };
}
