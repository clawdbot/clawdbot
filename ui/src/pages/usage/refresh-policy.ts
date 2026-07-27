export const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

export type UsageRefreshReason = "focus" | "manual" | "poll" | "reconnect";
type UsageRefreshDecision = "defer" | "fetch" | "skip";

export function decideUsageRefresh(params: {
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
