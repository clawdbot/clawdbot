const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;
const SESSION_EVENT_REFRESH_MAX_WAIT_MS = 1_000;
const SESSION_EVENT_REFRESH_MIN_INTERVAL_MS = 1_000;

type SessionEventRefreshCoordinatorOptions = {
  active: boolean;
  refresh: () => Promise<void>;
};

/** Canonical bounded event refresh policy shared by session-list owners. */
export function createSessionEventRefreshCoordinator({
  active: initialActive,
  refresh,
}: SessionEventRefreshCoordinatorOptions) {
  let active = initialActive;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let deadline = 0;
  let nextAllowed = 0;
  // Hidden/page-exit lifecycle holds one authoritative refresh bit. Resume
  // redeems it once without starting network work during teardown.
  let queued = false;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = 0;
    deadline = 0;
  };

  const start = (resume = false) => {
    // A queued owner may have started its real request after this timer was armed.
    if (!resume && active && Date.now() < nextAllowed) {
      timer = setTimeout(start, nextAllowed - Date.now());
      return;
    }
    timer = 0;
    deadline = 0;
    if (!active) {
      queued = true;
      return;
    }
    queued = false;
    nextAllowed = Date.now() + SESSION_EVENT_REFRESH_MIN_INTERVAL_MS;
    void refresh().catch(() => {});
  };

  const absorb = () => {
    clearTimer();
    queued = false;
  };
  const reset = () => {
    absorb();
    nextAllowed = 0;
  };

  return {
    schedule() {
      if (!active) {
        clearTimer();
        queued = true;
        return;
      }
      const now = Date.now();
      deadline ||= now + SESSION_EVENT_REFRESH_MAX_WAIT_MS;
      clearTimeout(timer);
      const delay = Math.max(
        nextAllowed - now,
        Math.min(SESSION_EVENT_REFRESH_DEBOUNCE_MS, deadline - now),
      );
      timer = setTimeout(start, delay);
    },
    requestStarted() {
      // Cold/explicit reads remain immediate. Once event refreshes begin, anchor
      // their spacing to real reads, including delayed in-flight queue drains.
      if (nextAllowed !== 0) {
        nextAllowed = Date.now() + SESSION_EVENT_REFRESH_MIN_INTERVAL_MS;
      }
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        if (queued) {
          start(true);
        }
        return;
      }
      queued ||= markDirty || timer !== 0;
      clearTimer();
    },
    absorb,
    reset,
    dispose: reset,
  };
}
