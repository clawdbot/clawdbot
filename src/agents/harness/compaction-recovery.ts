import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";

export function isRecoverableNativeHarnessBindingReason(reason: unknown): boolean {
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

export function isRecoverableNativeHarnessBindingFailure(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return (
    result?.ok === false &&
    (isRecoverableNativeHarnessBindingReason(result.failure?.reason) ||
      isRecoverableNativeHarnessBindingReason(result.reason))
  );
}
