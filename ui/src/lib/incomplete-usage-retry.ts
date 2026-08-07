// Provider usage lands from a Gateway background refresh, so a payload can arrive
// marked incomplete. Every consumer of usage.status needs the same bounded retry:
// refetch soon enough that the panel fills itself in, and stop before it becomes a
// poller when the refresh never lands.
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

/**
 * A usage payload is incomplete only when the Gateway said so. A missing payload is
 * not the same claim: both consumers reduce a disconnected page and a failed
 * usage.status to the same null, so treating null as incomplete would retry against
 * a Gateway nobody asked. A failure therefore ends the retry chain, and the panel
 * refills on the next focus, reconnect, or manual refresh.
 */
export function isUsageIncomplete(usage: { refreshing?: boolean } | null | undefined): boolean {
  return usage?.refreshing === true;
}

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
  private connection: unknown;

  constructor(private readonly options: IncompleteUsageRetryOptions) {}

  /**
   * Records a landed payload and returns whether it is still incomplete, so callers
   * can keep their own cache cold. Running out of retries stops the timers, never
   * the answer: a payload the Gateway still marks incomplete stays incomplete, or a
   * TTL would start on data that never arrived.
   *
   * `connection` keys the retry budget to the Gateway client the payload came from.
   * A new connection is a new cold cache and gets its own attempts; keying it here
   * rather than at a reset call site keeps it correct no matter which of the host's
   * lifecycle hooks observes the swap first.
   */
  observe(incomplete: boolean, connection?: unknown): boolean {
    this.useConnection(connection);
    this.clear();
    if (!incomplete) {
      this.attempts = 0;
      return false;
    }
    if (this.attempts < (this.options.limit ?? INCOMPLETE_USAGE_RETRY_LIMIT)) {
      this.attempts += 1;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.options.retry();
      }, this.options.retryMs ?? INCOMPLETE_USAGE_RETRY_MS);
    }
    return true;
  }

  /**
   * Points the budget at a connection, dropping a retry left over from the one it
   * replaced. Same connection is a no-op, so a host that reports the current client
   * on every update cannot cancel a retry it just armed.
   */
  useConnection(connection: unknown): void {
    if (connection === this.connection) {
      return;
    }
    this.connection = connection;
    this.attempts = 0;
    this.clear();
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
