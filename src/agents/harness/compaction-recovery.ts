/**
 * Native harness compaction recovery helpers.
 *
 * CLI compaction uses these guards to recognize thread-binding failures that can
 * fall back to context-engine compaction after clearing stale session bindings.
 */
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";

/** Returns whether a native harness failure reason indicates a recoverable binding issue. */
function isRecoverableNativeHarnessBindingReason(reason: unknown): boolean {
  if (typeof reason !== "string") {
    return false;
  }
  const normalized = reason.trim().toLowerCase();
  return (
    normalized === "missing_thread_binding" ||
    normalized === "stale_thread_binding" ||
    normalized.includes("thread not found") ||
    normalized.includes("no thread binding")
  );
}

/** Returns whether a compact result failed due to a recoverable native binding issue. */
export function isRecoverableNativeHarnessBindingFailure(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  if (result?.ok !== false) {
    return false;
  }
  if (result.failure?.disposition === "fallback") {
    return isRecoverableNativeHarnessBindingReason(result.failure.reason);
  }
  if (result.failure?.disposition !== undefined) {
    return false;
  }
  // Released harness plugins predate the typed fallback disposition. Keep the
  // legacy reason reader only at this native-binding migration boundary.
  return (
    isRecoverableNativeHarnessBindingReason(result.failure?.reason) ||
    isRecoverableNativeHarnessBindingReason(result.reason)
  );
}
