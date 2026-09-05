import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
import {
  type DiagnosticArgumentChurnActivity,
  resolveArgumentChurnProgress,
} from "./diagnostic-argument-churn-activity.js";
import { resolveCurrentDiagnosticRunId } from "./diagnostic-embedded-run-index.js";
import {
  type DiagnosticRepeatedRequestActivity,
  resolveRepeatedRequestNoProgressAgeMs,
} from "./diagnostic-repeated-request-activity.js";

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  hasActiveEmbeddedRun?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  activeToolDeadlineAtMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  repeatedRequestNoProgressAgeMs?: number;
  activeModelCallRequestTimeoutMs?: number;
};

type SnapshotTool = {
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  deadlineAtMs?: number;
};
type SnapshotActivity = DiagnosticArgumentChurnActivity &
  DiagnosticRepeatedRequestActivity & {
    activeEmbeddedRuns: ReadonlyMap<string, { runId: string; sequence: number }>;
    activeModelCalls: ReadonlyMap<string, unknown>;
    activeCoreModelCalls: ReadonlyMap<object, ReadonlyMap<string, { requestTimeoutMs?: number }>>;
    activeTools: ReadonlyMap<string, SnapshotTool>;
    lastProgressAt: number;
    lastProgressReason?: string;
  };

export function buildDiagnosticSessionActivitySnapshot(
  activity: SnapshotActivity,
  now: number,
): DiagnosticSessionActivitySnapshot {
  let activeCoreModelCallCount = 0;
  let activeModelCallRequestTimeoutMs: number | undefined;
  for (const calls of activity.activeCoreModelCalls.values()) {
    activeCoreModelCallCount += calls.size;
    for (const call of calls.values()) {
      if (
        call.requestTimeoutMs !== undefined &&
        (activeModelCallRequestTimeoutMs === undefined ||
          call.requestTimeoutMs > activeModelCallRequestTimeoutMs)
      ) {
        activeModelCallRequestTimeoutMs = call.requestTimeoutMs;
      }
    }
  }
  const activeWorkKind: DiagnosticSessionActiveWorkKind | undefined =
    activity.activeTools.size > 0
      ? "tool_call"
      : activity.activeModelCalls.size > 0 || activeCoreModelCallCount > 0
        ? "model_call"
        : activity.activeEmbeddedRuns.size > 0
          ? "embedded_run"
          : undefined;
  let activeTool: SnapshotTool | undefined;
  for (const tool of activity.activeTools.values()) {
    if (!activeTool || tool.startedAt < activeTool.startedAt) {
      activeTool = tool;
    }
  }
  const currentOwnerRunId = resolveCurrentDiagnosticRunId(activity.activeEmbeddedRuns.values());
  const churnProgress = resolveArgumentChurnProgress(activity, currentOwnerRunId, now);
  return {
    activeWorkKind,
    ...(activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {}),
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    activeToolDeadlineAtMs: activeTool?.deadlineAtMs,
    lastProgressAgeMs: Math.max(0, now - churnProgress.lastProgressAt),
    lastProgressReason: churnProgress.lastProgressReason,
    repeatedRequestNoProgressAgeMs: resolveRepeatedRequestNoProgressAgeMs(
      activity,
      currentOwnerRunId,
      now,
    ),
    activeModelCallRequestTimeoutMs,
  };
}

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

// Quiet-but-alive tool phases get the blocked-tool floor so a human message
// cannot reclaim a healthy long tool that stuck recovery would not touch yet.
export function resolveRunStaleThresholdMs(
  activity: Pick<
    DiagnosticSessionActivitySnapshot,
    "activeWorkKind" | "activeToolDeadlineAtMs" | "lastProgressAgeMs"
  >,
  evidenceAgeMs = activity.lastProgressAgeMs ?? 0,
): number {
  if (activity.activeToolDeadlineAtMs !== undefined) {
    // Use the same age the caller compares: subtracting it leaves only the
    // absolute deadline, even when reply activity and tool progress differ.
    return Math.max(0, evidenceAgeMs + activity.activeToolDeadlineAtMs - Date.now());
  }
  return activity.activeWorkKind === "tool_call"
    ? Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
    : RUN_STALE_TAKEOVER_MS;
}
