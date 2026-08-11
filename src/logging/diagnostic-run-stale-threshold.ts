import type { DiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity-snapshot.js";

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

// Quiet-but-alive tool phases and CLI-owned background work get the blocked-tool
// floor so a human message cannot reclaim work that recovery would not touch yet.
export function resolveRunStaleThresholdMs(
  activity: Pick<
    DiagnosticSessionActivitySnapshot,
    "activeWorkKind" | "hasOutstandingBackgroundWork"
  >,
): number {
  return activity.activeWorkKind === "tool_call" || activity.hasOutstandingBackgroundWork === true
    ? Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
    : RUN_STALE_TAKEOVER_MS;
}
