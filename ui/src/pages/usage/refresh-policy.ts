import {
  IncompleteUsageRetry,
  isUsageIncomplete,
  type UsageRetryState,
} from "../../lib/incomplete-usage-retry.ts";
import type { ProviderUsageRequestResult } from "../../lib/provider-usage-request.ts";

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
  reload: () => void | Promise<void>;
  onIncompleteUsageExhausted?: () => void;
};

/** Owns Usage's page-specific TTL, interruption, and refresh coalescing policy. */
export class UsageRefreshPolicy {
  private lastLoadedAtMs: number | null = null;
  private pendingAutomaticRefresh = false;
  private reloadPending = false;
  private readonly incompleteUsageRetry = new IncompleteUsageRetry({
    retry: () => this.requestAndWait("poll"),
    onExhausted: () => this.options.onIncompleteUsageExhausted?.(),
  });

  constructor(private readonly options: UsageRefreshPolicyOptions) {}

  get incompleteUsageExhausted(): boolean {
    return this.incompleteUsageRetry.exhausted;
  }

  setLastLoadedAtMs(
    value: number | null,
    params?: { incomplete?: boolean; connection?: unknown },
  ): UsageRetryState {
    return this.applyLoadState(value, params?.incomplete === true, params?.connection);
  }

  markProviderUsage(
    result: ProviderUsageRequestResult | null,
    value: number | null,
    connection: unknown,
  ): UsageRetryState {
    const incomplete =
      result?.ok === false || (result?.ok === true && isUsageIncomplete(result.value));
    return this.applyLoadState(value, incomplete, connection);
  }

  resetPayload(): void {
    this.applyLoadState(null, false);
    this.reloadPending = false;
  }

  dispose(): void {
    this.incompleteUsageRetry.dispose();
  }

  private applyLoadState(
    loadedAtMs: number | null,
    incomplete: boolean,
    connection?: unknown,
  ): UsageRetryState {
    const state = this.incompleteUsageRetry.observe(incomplete, connection);
    // Incomplete usage must not start the TTL or focus/reconnect can skip recovery.
    this.lastLoadedAtMs = state === "complete" ? loadedAtMs : null;
    return state;
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

  private async reloadAndWait(): Promise<void> {
    this.pendingAutomaticRefresh = false;
    await this.options.reload();
  }

  request(reason: UsageRefreshReason): void {
    void this.requestAndWait(reason);
  }

  private async requestAndWait(reason: UsageRefreshReason): Promise<void> {
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
      if (reason !== "poll") {
        this.incompleteUsageRetry.startCycle();
      }
      await this.reloadAndWait();
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
