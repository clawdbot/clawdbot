const DEFAULT_ENGINE_SKIP_REASON = "policy_skipped";

export function afterCompactionSkipFields(result: { compacted?: boolean; reason?: unknown }): {
  compactedCount: number;
  reason?: string;
} {
  if (result.compacted === true) {
    return { compactedCount: -1 };
  }
  const reason = typeof result.reason === "string" && result.reason.trim() ? result.reason : "";
  return { compactedCount: 0, reason: reason || DEFAULT_ENGINE_SKIP_REASON };
}
