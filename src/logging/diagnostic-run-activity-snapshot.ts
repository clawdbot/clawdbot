import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
import {
  type DiagnosticArgumentChurnActivity,
  resolveArgumentChurnProgress,
} from "./diagnostic-argument-churn-activity.js";
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
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  repeatedRequestNoProgressAgeMs?: number;
};

type SnapshotTool = { toolName: string; toolCallId?: string; startedAt: number };
type SnapshotActivity = DiagnosticArgumentChurnActivity &
  DiagnosticRepeatedRequestActivity & {
    activeEmbeddedRuns: ReadonlyMap<string, { runId: string; sequence: number }>;
    activeModelCalls: ReadonlyMap<string, unknown>;
    activeTools: ReadonlyMap<string, SnapshotTool>;
    lastProgressAt: number;
    lastProgressReason?: string;
  };

export function buildDiagnosticSessionActivitySnapshot(
  activity: SnapshotActivity,
  now: number,
): DiagnosticSessionActivitySnapshot {
  const activeWorkKind: DiagnosticSessionActiveWorkKind | undefined =
    activity.activeTools.size > 0
      ? "tool_call"
      : activity.activeModelCalls.size > 0
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
  const churnProgress = resolveArgumentChurnProgress(
    activity,
    activity.activeEmbeddedRuns.values(),
    now,
  );
  return {
    activeWorkKind,
    ...(activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {}),
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    lastProgressAgeMs: Math.max(0, now - churnProgress.lastProgressAt),
    lastProgressReason: churnProgress.lastProgressReason,
    repeatedRequestNoProgressAgeMs: resolveRepeatedRequestNoProgressAgeMs(
      activity,
      activity.activeEmbeddedRuns.values(),
      now,
    ),
  };
}
