const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
// Provider usage lands from a Gateway background refresh. Retry soon enough that the
// panel fills itself in, but give up quickly: a refresh that keeps failing leaves the
// payload incomplete forever, and retrying it forever is a poller.
const PENDING_PAYLOAD_RETRY_MS = 5_000;
const PENDING_PAYLOAD_RETRY_LIMIT = 3;

type UsageRefreshReason = "focus" | "manual" | "poll" | "reconnect";
type UsageRefreshDecision = "defer" | "fetch" | "skip";

function decideUsageRefresh(params: {
  reason: UsageRefreshReason;
  visible: boolean;
  interrupted: boolean;
  nowMs: number;
  lastLoadedAtMs: number | null;
  ttlMs?: number;
}): UsageRefreshDecision {
  if (params.reason === "manual") {
    return "fetch";
  }
  if (!params.visible) {
    return "defer";
  }
  // A disconnect invalidates in-flight work. Once active, retry it even when
  // the prior payload is still fresh.
  if (params.interrupted) {
    return "fetch";
  }
  const ttlMs = params.ttlMs ?? USAGE_PAYLOAD_TTL_MS;
  if (params.lastLoadedAtMs !== null && params.nowMs - params.lastLoadedAtMs < ttlMs) {
    return "skip";
  }
  return "fetch";
}

type UsageRefreshPolicyOptions = {
  isLoading: () => boolean;
  reload: () => void;
};

/** Owns Usage's page-specific TTL, interruption, and refresh coalescing policy. */
export class UsageRefreshPolicy {
  private lastLoadedAtMs: number | null = null;
  private pendingAutomaticRefresh = false;
  private reloadPending = false;
  private pendingPayloadRetryTimer: number | null = null;
  private pendingPayloadRetries = 0;

  constructor(private readonly options: UsageRefreshPolicyOptions) {}

  setLastLoadedAtMs(value: number | null, params?: { pendingRefresh?: boolean }): void {
    this.applyLoadState(value, params?.pendingRefresh === true);
  }

  markLoaded(params?: { pendingRefresh?: boolean }): void {
    this.applyLoadState(Date.now(), params?.pendingRefresh === true);
  }

  resetPayload(): void {
    this.applyLoadState(null, false);
    this.reloadPending = false;
  }

  /** Drops the retry timer when the page goes away so it cannot reload a detached view. */
  dispose(): void {
    this.clearPendingPayloadRetry();
  }

  private applyLoadState(loadedAtMs: number | null, pendingRefresh: boolean): void {
    this.clearPendingPayloadRetry();
    if (!pendingRefresh) {
      this.pendingPayloadRetries = 0;
      this.lastLoadedAtMs = loadedAtMs;
      return;
    }
    if (this.pendingPayloadRetries >= PENDING_PAYLOAD_RETRY_LIMIT) {
      // The refresh is not coming back. Fall back to the normal TTL instead of retrying.
      this.lastLoadedAtMs = loadedAtMs;
      return;
    }
    this.pendingPayloadRetries += 1;
    // An incomplete payload must not start the TTL, or the stale view survives every
    // automatic refresh until the window expires.
    this.lastLoadedAtMs = null;
    this.pendingPayloadRetryTimer = window.setTimeout(() => {
      this.pendingPayloadRetryTimer = null;
      this.request("poll");
    }, PENDING_PAYLOAD_RETRY_MS);
  }

  private clearPendingPayloadRetry(): void {
    if (this.pendingPayloadRetryTimer === null) {
      return;
    }
    window.clearTimeout(this.pendingPayloadRetryTimer);
    this.pendingPayloadRetryTimer = null;
  }

  interrupt(): void {
    this.reloadPending ||= this.options.isLoading();
  }

  markLoadDeferred(): void {
    this.reloadPending = true;
  }

  beginLoad(): void {
    this.reloadPending = false;
  }

  reload(): void {
    this.pendingAutomaticRefresh = false;
    this.options.reload();
  }

  request(reason: UsageRefreshReason): void {
    if (this.options.isLoading() && reason !== "manual") {
      this.pendingAutomaticRefresh = true;
      return;
    }
    this.pendingAutomaticRefresh = false;
    const decision = decideUsageRefresh({
      reason,
      visible: document.visibilityState === "visible" && document.hasFocus(),
      interrupted: this.reloadPending,
      nowMs: Date.now(),
      lastLoadedAtMs: this.lastLoadedAtMs,
    });
    if (decision === "fetch") {
      this.reload();
    }
  }

  flushPending(): void {
    if (!this.pendingAutomaticRefresh) {
      return;
    }
    this.pendingAutomaticRefresh = false;
    this.request("focus");
  }
}
