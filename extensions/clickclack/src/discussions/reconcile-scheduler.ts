const RECONCILE_DEBOUNCE_MS = 250;
const RECONCILE_RETRY_MS = 1_000;
const RECONCILE_RETRY_MAX_MS = 60_000;

type SchedulerHooks = {
  /** Gate evaluated at scheduling time; false drops the request. */
  shouldSchedule: (sessionKey: string) => boolean;
  run: (sessionKey: string) => Promise<void>;
  warn: (message: string) => void;
};

/**
 * Per-session debounced reconcile scheduling with failure backoff.
 * Contracts: bursts coalesce onto the earliest scheduled run (steady event
 * traffic can never postpone one); a failed run sets a not-before floor with
 * growing backoff that later events cannot undercut; events during an
 * in-flight run collapse into one follow-up scheduled after settlement; and
 * `supersede()` invalidates callbacks from earlier activations so stop/start
 * cycles cannot corrupt the bookkeeping of the next one.
 */
export class DiscussionReconcileScheduler {
  readonly #hooks: SchedulerHooks;
  readonly #timers = new Map<string, { fireAt: number; timer: ReturnType<typeof setTimeout> }>();
  readonly #retryState = new Map<string, { delayMs: number; notBefore: number }>();
  readonly #inFlight = new Set<string>();
  readonly #followUps = new Set<string>();
  #generation = 0;

  constructor(hooks: SchedulerHooks) {
    this.#hooks = hooks;
  }

  /** Invalidates callbacks scheduled by prior activations. */
  supersede(): void {
    this.#generation += 1;
  }

  clear(): void {
    for (const scheduled of this.#timers.values()) {
      clearTimeout(scheduled.timer);
    }
    this.#timers.clear();
    this.#retryState.clear();
    this.#inFlight.clear();
    this.#followUps.clear();
  }

  schedule(sessionKey: string, delayMs = RECONCILE_DEBOUNCE_MS): void {
    if (!this.#hooks.shouldSchedule(sessionKey)) {
      return;
    }
    if (this.#inFlight.has(sessionKey)) {
      this.#followUps.add(sessionKey);
      return;
    }
    const retry = this.#retryState.get(sessionKey);
    const fireAt = Math.max(Date.now() + delayMs, retry?.notBefore ?? 0);
    const existing = this.#timers.get(sessionKey);
    if (existing) {
      if (existing.fireAt <= fireAt) {
        return;
      }
      clearTimeout(existing.timer);
    }
    const generation = this.#generation;
    const timer = setTimeout(
      () => {
        if (generation !== this.#generation) {
          return;
        }
        this.#timers.delete(sessionKey);
        this.#inFlight.add(sessionKey);
        void this.#hooks
          .run(sessionKey)
          .then(
            () => {
              if (generation !== this.#generation) {
                return;
              }
              this.#retryState.delete(sessionKey);
            },
            (error: unknown) => {
              if (generation !== this.#generation || !this.#hooks.shouldSchedule(sessionKey)) {
                return;
              }
              const previous = this.#retryState.get(sessionKey);
              const nextRetryMs = Math.min(
                previous === undefined ? RECONCILE_RETRY_MS : previous.delayMs * 2,
                RECONCILE_RETRY_MAX_MS,
              );
              this.#retryState.set(sessionKey, {
                delayMs: nextRetryMs,
                notBefore: Date.now() + nextRetryMs,
              });
              this.#hooks.warn(
                `discussion event reconcile failed for ${sessionKey}; retrying in ${nextRetryMs}ms: ${String(error)}`,
              );
              this.#followUps.add(sessionKey);
            },
          )
          .finally(() => {
            if (generation !== this.#generation) {
              return;
            }
            this.#inFlight.delete(sessionKey);
            if (this.#followUps.delete(sessionKey)) {
              this.schedule(sessionKey);
            }
          });
      },
      Math.max(fireAt - Date.now(), 0),
    );
    timer.unref?.();
    this.#timers.set(sessionKey, { fireAt, timer });
  }
}
