/**
 * Throttled draft stream loop.
 *
 * Sends the latest pending draft text with single-flight edit semantics.
 */
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Throttled draft-stream sender used by channels that edit in-progress replies. */
export type DraftStreamLoop<T = string> = {
  update: (value: T) => void;
  flush: () => Promise<void>;
  stop: () => void;
  resetPending: () => void;
  resetThrottleWindow: () => void;
  waitForInFlight: () => Promise<void>;
  /** Removes queued (not in-flight) text atomically and cancels its scheduled flush. */
  takePending?: () => T;
};

type CreatedDraftStreamLoop<T> = DraftStreamLoop<T> & {
  takePending: () => T;
};

/** Creates a single-flight draft stream loop that preserves the newest pending value. */
export function createDraftStreamLoop<T = string>(params: {
  throttleMs: number;
  isStopped: () => boolean;
  sendOrEditStreamMessage: (value: T) => Promise<void | boolean>;
  /** Empty sentinel and predicate for non-string payloads. */
  emptyValue?: T;
  isEmpty?: (value: T) => boolean;
  onBackgroundFlushError?: (err: unknown) => void;
}): CreatedDraftStreamLoop<T> {
  const throttleMs = resolveTimerTimeoutMs(params.throttleMs, 0, 0);
  const emptyValue = params.emptyValue ?? ("" as T);
  const isEmpty =
    params.isEmpty ?? ((value: T) => typeof value === "string" && value.trim().length === 0);
  // String callers historically treated only "" as absent between sends,
  // while trim-empty text is discarded at the top of the next flush.
  const hasPendingValue = (value: T) =>
    typeof value === "string" ? value.length > 0 : !isEmpty(value);
  let lastSentAt = 0;
  let pendingValue = emptyValue;
  let inFlightPromise: Promise<void | boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!params.isStopped()) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const value = pendingValue;
      if (isEmpty(value)) {
        pendingValue = emptyValue;
        return;
      }
      pendingValue = emptyValue;
      let current: Promise<void | boolean> | undefined;
      try {
        current = Promise.resolve(params.sendOrEditStreamMessage(value)).finally(() => {
          if (inFlightPromise === current) {
            inFlightPromise = undefined;
          }
        });
      } catch (err) {
        if (!hasPendingValue(pendingValue)) {
          pendingValue = value;
        }
        throw err;
      }
      inFlightPromise = current;
      let sent: void | boolean;
      try {
        sent = await current;
      } catch (err) {
        if (!hasPendingValue(pendingValue)) {
          pendingValue = value;
        }
        throw err;
      }
      if (sent === false) {
        if (!hasPendingValue(pendingValue)) {
          pendingValue = value;
        }
        return;
      }
      lastSentAt = Date.now();
      if (!hasPendingValue(pendingValue)) {
        return;
      }
    }
  };

  const startBackgroundFlush = () => {
    void flush().catch((err: unknown) => {
      try {
        params.onBackgroundFlushError?.(err);
      } catch {
        // Error reporting must not recreate the unhandled background rejection path.
      }
    });
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      startBackgroundFlush();
    }, delay);
  };

  return {
    update: (value: T) => {
      if (params.isStopped()) {
        return;
      }
      pendingValue = value;
      if (inFlightPromise) {
        schedule();
        return;
      }
      if (!timer && Date.now() - lastSentAt >= throttleMs) {
        startBackgroundFlush();
        return;
      }
      schedule();
    },
    flush,
    stop: () => {
      pendingValue = emptyValue;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    resetPending: () => {
      pendingValue = emptyValue;
    },
    resetThrottleWindow: () => {
      lastSentAt = 0;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    waitForInFlight: async () => {
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
    takePending: () => {
      const value = pendingValue;
      pendingValue = emptyValue;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return value;
    },
  };
}
