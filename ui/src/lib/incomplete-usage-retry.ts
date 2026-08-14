const INCOMPLETE_USAGE_RETRY_MS = 5_000;
const INCOMPLETE_USAGE_RETRY_LIMIT = 3;

type IncompleteUsageRetryOptions = {
  retry: () => void;
  retryMs?: number;
  limit?: number;
};

type UsageRetryHost = {
  addController: (controller: { hostDisconnected: () => void }) => void;
};

/** Closed convergence state: an incomplete payload is never a rendered answer. */
export type UsageRetryState = "complete" | "retrying" | "exhausted";

export function isUsageIncomplete(usage: { refreshing?: boolean } | null | undefined): boolean {
  return usage?.refreshing === true;
}

export function createUsageRetry(
  host: UsageRetryHost,
  retry: () => void,
  options?: Omit<IncompleteUsageRetryOptions, "retry">,
): IncompleteUsageRetry {
  const controller = new IncompleteUsageRetry({ retry, ...options });
  host.addController({ hostDisconnected: () => controller.dispose() });
  return controller;
}

/** Keeps incomplete usage cache-cold while bounding automatic convergence attempts. */
export class IncompleteUsageRetry {
  private timer: number | null = null;
  private attempts = 0;
  private connection: unknown;

  constructor(private readonly options: IncompleteUsageRetryOptions) {}

  observe(incomplete: boolean, connection?: unknown): UsageRetryState {
    this.useConnection(connection);
    this.clear();
    if (!incomplete) {
      this.attempts = 0;
      return "complete";
    }
    if (this.attempts >= (this.options.limit ?? INCOMPLETE_USAGE_RETRY_LIMIT)) {
      // Nothing will converge this payload on its own, so the caller has to
      // report it. Rendering the empty provider list as a loaded answer is the
      // silent-failure this marker exists to avoid.
      return "exhausted";
    }
    this.attempts += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.options.retry();
    }, this.options.retryMs ?? INCOMPLETE_USAGE_RETRY_MS);
    return "retrying";
  }

  /** Starts a user/lifecycle-owned refresh cycle without letting poll callbacks rearm it. */
  startCycle(): void {
    this.attempts = 0;
    this.clear();
  }

  useConnection(connection: unknown): void {
    if (connection === this.connection) {
      return;
    }
    this.connection = connection;
    this.startCycle();
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    if (this.timer === null) {
      return;
    }
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}
