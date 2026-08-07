// Provider usage lands from a Gateway background refresh, so a payload can arrive
// marked incomplete. Every consumer of usage.status needs the same bounded retry:
// refetch soon enough that the panel fills itself in, and stop before it becomes a
// poller when the refresh never lands.
const INCOMPLETE_USAGE_RETRY_MS = 5_000;
const INCOMPLETE_USAGE_RETRY_LIMIT = 3;

export type IncompleteUsageRetryOptions = {
  retry: () => void;
  retryMs?: number;
  limit?: number;
};

type UsageRetryHost = {
  addController: (controller: { hostDisconnected: () => void }) => void;
};

/** Host-owned retry: the pending refetch is dropped when the element disconnects. */
export function createUsageRetry(
  host: UsageRetryHost,
  retry: () => void,
  options?: Omit<IncompleteUsageRetryOptions, "retry">,
): IncompleteUsageRetry {
  const controller = new IncompleteUsageRetry({ retry, ...options });
  host.addController({ hostDisconnected: () => controller.dispose() });
  return controller;
}

/** Bounded refetch for usage payloads the Gateway marked as still refreshing. */
export class IncompleteUsageRetry {
  private timer: number | null = null;
  private attempts = 0;

  constructor(private readonly options: IncompleteUsageRetryOptions) {}

  /**
   * Records the freshness of a landed payload. Returns true while the payload is
   * incomplete and a retry is pending, so callers can keep their own cache cold.
   */
  observe(refreshing: boolean): boolean {
    this.clear();
    if (!refreshing) {
      this.attempts = 0;
      return false;
    }
    if (this.attempts >= (this.options.limit ?? INCOMPLETE_USAGE_RETRY_LIMIT)) {
      return false;
    }
    this.attempts += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.options.retry();
    }, this.options.retryMs ?? INCOMPLETE_USAGE_RETRY_MS);
    return true;
  }

  /** Drops the pending retry so it cannot reload a detached view. */
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
