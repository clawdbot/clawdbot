/**
 * Throttled draft stream loop.
 *
 * Sends the latest pending draft text with single-flight edit semantics.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

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
  /** Keep background updates arriving during a send in the next throttle window. */
  coalesceInFlight?: boolean;
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

  const flush = async (background = false) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!params.isStopped()) {
      if (inFlightPromise) {
        await inFlightPromise;
        if (background && params.coalesceInFlight) {
          return;
        }
        continue;
      }
      const value = pendingValue;
      if (isEmpty(value)) {
        pendingValue = emptyValue;
        return;
      }
      pendingValue = emptyValue;
      let current: Promise<void | boolean> | undefined;
      let sent: void | boolean;
      try {
        current = Promise.resolve(params.sendOrEditStreamMessage(value)).finally(() => {
          if (inFlightPromise === current) {
            inFlightPromise = undefined;
          }
        });
        inFlightPromise = current;
        sent = await current;
      } catch (err) {
        if (!hasPendingValue(pendingValue)) {
          pendingValue = value;
        } else if (background && params.coalesceInFlight) {
          // Only newer work owns another attempt; never retry the failed value.
          schedule();
        }
        throw err;
      }
      if (sent === false) {
        if (!hasPendingValue(pendingValue)) {
          pendingValue = value;
        } else if (background && params.coalesceInFlight) {
          // Do not retry an unchanged/rejected value automatically. A newer
          // update arriving during the send still owns its background flush.
          schedule();
        }
        return;
      }
      lastSentAt = Date.now();
      if (!hasPendingValue(pendingValue)) {
        return;
      }
      if (background && params.coalesceInFlight) {
        schedule();
        return;
      }
    }
  };

  const startBackgroundFlush = () => {
    void flush(true).catch((err: unknown) => {
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
        if (!params.coalesceInFlight) {
          schedule();
        }
        return;
      }
      if (!timer && Date.now() - lastSentAt >= throttleMs) {
        startBackgroundFlush();
        return;
      }
      schedule();
    },
    flush: () => flush(),
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
