/** Leaf helper shared by native and dynamic tool diagnostics. */

const CODEX_TIMEOUT_ABORT_REASONS = new Set([
  "codex_startup_timeout",
  "turn_completion_idle_timeout",
  "turn_progress_idle_timeout",
  "turn_terminal_idle_timeout",
]);

/** Preserves timeout provenance when an enclosing run aborts an active tool. */
export function resolveCodexToolAbortTerminalReason(
  signal: AbortSignal,
): "failed" | "cancelled" | "timed_out" {
  try {
    const reason = signal.reason;
    if (typeof reason === "string") {
      if (CODEX_TIMEOUT_ABORT_REASONS.has(reason)) {
        return "timed_out";
      }
      // Transport loss is a run failure, not an operator cancellation. Native
      // and dynamic tool diagnostics share this helper and must agree with it.
      return reason === "client_closed" ? "failed" : "cancelled";
    }
    if (reason && typeof reason === "object") {
      const record = reason as { name?: unknown; reason?: unknown };
      if (record.name === "TimeoutError" || record.reason === "timeout") {
        return "timed_out";
      }
    }
  } catch {
    return "cancelled";
  }
  return "cancelled";
}
