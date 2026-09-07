const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;
const SESSION_EVENT_REFRESH_MAX_WAIT_MS = 1_000;

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
  // Hidden/page-exit lifecycle holds one authoritative refresh bit. Resume
  // redeems it once without starting network work during teardown.
  let queued = false;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = 0;
    deadline = 0;
  };

  const start = () => {
    timer = 0;
    deadline = 0;
    if (!active) {
      queued = true;
      return;
    }
    queued = false;
    void refresh().catch(() => {});
  };

  const absorb = () => {
    clearTimer();
    queued = false;
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
      const delay = Math.min(SESSION_EVENT_REFRESH_DEBOUNCE_MS, deadline - now);
      timer = setTimeout(start, delay);
    },
    setActive(next: boolean, markDirty = false) {
      active = next;
      if (next) {
        if (queued) {
          start();
        }
        return;
      }
      queued ||= markDirty || timer !== 0;
      clearTimer();
    },
    absorb,
    reset: absorb,
    dispose: absorb,
  };
}
