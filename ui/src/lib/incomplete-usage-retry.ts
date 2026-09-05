const INCOMPLETE_USAGE_RETRY_MS = 5_000;
const INCOMPLETE_USAGE_RETRY_LIMIT = 3;

type IncompleteUsageRetryOptions = {
  retry: () => void | Promise<void>;
  onExhausted?: () => void;
  retryMs?: number;
  limit?: number;
};

/** Closed convergence state: an incomplete payload is never a rendered answer. */
export type UsageRetryState = "complete" | "retrying" | "exhausted";

export function isUsageIncomplete(usage: { refreshing?: boolean } | null | undefined): boolean {
  return usage?.refreshing === true;
}

/** Keeps incomplete usage cache-cold while bounding automatic convergence attempts. */
export class IncompleteUsageRetry {
  private timer: number | null = null;
  private retryInFlight: Promise<void> | null = null;
  private pendingIncomplete = false;
  private attempts = 0;
  private cycle = 0;
  private exhaustionReported = false;
  private connection: unknown;

  constructor(private readonly options: IncompleteUsageRetryOptions) {}

  get exhausted(): boolean {
    return this.exhaustionReported;
  }

  observe(incomplete: boolean, connection?: unknown): UsageRetryState {
    this.useConnection(connection);
    if (!incomplete) {
      this.resetCycle();
      return "complete";
    }
    if (this.retryInFlight !== null) {
      this.pendingIncomplete = true;
      return "retrying";
    }
    if (this.timer !== null) {
      return "retrying";
    }
    return this.armRetry();
  }

  private armRetry(): UsageRetryState {
    if (this.attempts >= (this.options.limit ?? INCOMPLETE_USAGE_RETRY_LIMIT)) {
      // Nothing will converge this payload on its own, so the caller has to
      // report it. Rendering the empty provider list as a loaded answer is the
      // silent-failure this marker exists to avoid.
      this.reportExhaustion();
      return "exhausted";
    }
    this.attempts += 1;
    this.pendingIncomplete = false;
    const cycle = this.cycle;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      let result: void | Promise<void>;
      try {
        result = this.options.retry();
      } catch {
        return;
      }
      if (!result) {
        return;
      }
      const inFlight = Promise.resolve(result).then(
        () => undefined,
        () => undefined,
      );
      this.retryInFlight = inFlight;
      void inFlight.finally(() => {
        if (this.cycle !== cycle || this.retryInFlight !== inFlight) {
          return;
        }
        this.retryInFlight = null;
        if (!this.pendingIncomplete) {
          return;
        }
        this.pendingIncomplete = false;
        this.armRetry();
      });
    }, this.options.retryMs ?? INCOMPLETE_USAGE_RETRY_MS);
    return "retrying";
  }

  /** Starts a user/lifecycle-owned refresh cycle without letting poll callbacks rearm it. */
  startCycle(): void {
    this.resetCycle();
  }

  useConnection(connection: unknown): void {
    if (connection === this.connection) {
      return;
    }
    this.connection = connection;
    this.startCycle();
  }

  dispose(): void {
    this.resetCycle();
  }

  private resetCycle(): void {
    this.cycle += 1;
    this.attempts = 0;
    this.pendingIncomplete = false;
    this.retryInFlight = null;
    this.exhaustionReported = false;
    this.clear();
  }

  private reportExhaustion(): void {
    if (this.exhaustionReported) {
      return;
    }
    this.exhaustionReported = true;
    this.options.onExhausted?.();
  }

  private clear(): void {
    if (this.timer === null) {
      return;
    }
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}
