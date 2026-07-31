/**
 * Throttled draft stream loop.
 *
 * Sends the latest pending draft text with single-flight edit semantics.
 */
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Throttled draft-stream sender used by channels that edit in-progress replies. */
export type DraftStreamLoop = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
  resetPending: () => void;
  resetThrottleWindow: () => void;
  waitForInFlight: () => Promise<void>;
  /** Removes queued (not in-flight) text atomically and cancels its scheduled flush. */
  takePending?: () => string;
};

type CreatedDraftStreamLoop = DraftStreamLoop & {
  takePending: () => string;
};

/** Creates a single-flight draft stream loop that preserves the newest pending text. */
export function createDraftStreamLoop(params: {
  throttleMs: number;
  isStopped: () => boolean;
  sendOrEditStreamMessage: (text: string) => Promise<void | boolean>;
  onBackgroundFlushError?: (err: unknown) => void;
}): CreatedDraftStreamLoop {
  const throttleMs = resolveTimerTimeoutMs(params.throttleMs, 0, 0);
  let lastSentAt = 0;
  let pendingText = "";
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
      const text = pendingText;
      if (!text.trim()) {
        pendingText = "";
        return;
      }
      pendingText = "";
      let current: Promise<void | boolean> | undefined;
      try {
        current = Promise.resolve(params.sendOrEditStreamMessage(text)).finally(() => {
          if (inFlightPromise === current) {
            inFlightPromise = undefined;
          }
        });
      } catch (err) {
        pendingText ||= text;
        throw err;
      }
      inFlightPromise = current;
      let sent: void | boolean;
      try {
        sent = await current;
      } catch (err) {
        pendingText ||= text;
        throw err;
      }
      if (sent === false) {
        pendingText = text;
        return;
      }
      lastSentAt = Date.now();
      if (!pendingText) {
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
    update: (text: string) => {
      if (params.isStopped()) {
        return;
      }
      pendingText = text;
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
      pendingText = "";
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    resetPending: () => {
      pendingText = "";
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
      const text = pendingText;
      pendingText = "";
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return text;
    },
  };
}
