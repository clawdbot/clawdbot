import { IncompleteUsageRetry } from "../../lib/incomplete-usage-retry.ts";

const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

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
  private readonly incompleteUsageRetry = new IncompleteUsageRetry({
    retry: () => this.request("poll"),
  });

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
    this.incompleteUsageRetry.dispose();
  }

  private applyLoadState(loadedAtMs: number | null, pendingRefresh: boolean): void {
    // While a retry is pending the payload must not start the TTL, or the incomplete
    // view survives every automatic refresh until the window expires.
    this.lastLoadedAtMs = this.incompleteUsageRetry.observe(pendingRefresh) ? null : loadedAtMs;
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
