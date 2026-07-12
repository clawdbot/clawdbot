// Produces task-flow registry audit summaries for diagnostics and maintenance.
import { listTasksForFlowId } from "./runtime-internal.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import { getTaskFlowRegistryRestoreFailure, listTaskFlowRecords } from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Severity used by task-flow registry audit findings. */
export type TaskFlowAuditSeverity = "warn" | "error";
export type TaskFlowAuditCode =
  | "restore_failed"
  | "stale_running"
  | "stale_waiting"
  | "stale_blocked"
  | "cancel_stuck"
  | "missing_linked_tasks"
  | "blocked_task_missing"
  | "inconsistent_timestamps";

export type TaskFlowAuditFinding = {
  severity: TaskFlowAuditSeverity;
  code: TaskFlowAuditCode;
  detail: string;
  ageMs?: number;
  flow?: TaskFlowRecord;
};

export type TaskFlowAuditSummary = {
  total: number;
  warnings: number;
  errors: number;
  byCode: Record<TaskFlowAuditCode, number>;
};

type TaskFlowAuditOptions = {
  now?: number;
  flows?: TaskFlowRecord[];
  staleRunningMs?: number;
  staleWaitingMs?: number;
  staleBlockedMs?: number;
  cancelStuckMs?: number;
};

const DEFAULT_STALE_RUNNING_MS = 30 * 60_000;
const DEFAULT_STALE_WAITING_MS = 30 * 60_000;
const DEFAULT_STALE_BLOCKED_MS = 30 * 60_000;
const DEFAULT_CANCEL_STUCK_MS = 5 * 60_000;

function createFinding(params: {
  severity: TaskFlowAuditSeverity;
  code: TaskFlowAuditCode;
  detail: string;
  ageMs?: number;
  flow?: TaskFlowRecord;
}): TaskFlowAuditFinding {
  return {
    severity: params.severity,
    code: params.code,
    detail: params.detail,
    ...(typeof params.ageMs === "number" ? { ageMs: params.ageMs } : {}),
    ...(params.flow ? { flow: params.flow } : {}),
  };
}

function severityRank(severity: TaskFlowAuditSeverity): number {
  return severity === "error" ? 0 : 1;
}

function compareFindings(left: TaskFlowAuditFinding, right: TaskFlowAuditFinding): number {
  const severityDiff = severityRank(left.severity) - severityRank(right.severity);
  if (severityDiff !== 0) {
    return severityDiff;
  }
  const leftAge = left.ageMs ?? -1;
  const rightAge = right.ageMs ?? -1;
  if (leftAge !== rightAge) {
    return rightAge - leftAge;
  }
  return (left.flow?.createdAt ?? 0) - (right.flow?.createdAt ?? 0);
}

function getReferenceAt(flow: TaskFlowRecord): number {
  return flow.updatedAt ?? flow.createdAt;
}

function getLinkedTasks(flowId: string): TaskRecord[] {
  return listTasksForFlowId(flowId);
}

function hasBlockingMetadata(flow: TaskFlowRecord): boolean {
  return Boolean(
    flow.blockedTaskId?.trim() || flow.blockedSummary?.trim() || flow.waitJson != null,
  );
}

function findTimestampInconsistency(flow: TaskFlowRecord): TaskFlowAuditFinding | null {
  if (flow.updatedAt < flow.createdAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      flow,
      detail: "updatedAt is earlier than createdAt",
    });
  }
  if (flow.endedAt && flow.endedAt < flow.createdAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      flow,
      detail: "endedAt is earlier than createdAt",
    });
  }
  if (flow.endedAt && flow.endedAt < flow.updatedAt) {
    return createFinding({
      severity: "warn",
      code: "inconsistent_timestamps",
      flow,
      detail: "endedAt is earlier than updatedAt",
    });
  }
  return null;
}

function createEmptyTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return {
    total: 0,
    warnings: 0,
    errors: 0,
    byCode: {
      restore_failed: 0,
      stale_running: 0,
      stale_waiting: 0,
      stale_blocked: 0,
      cancel_stuck: 0,
      missing_linked_tasks: 0,
      blocked_task_missing: 0,
      inconsistent_timestamps: 0,
    },
  };
}

export function listTaskFlowAuditFindings(
  options: TaskFlowAuditOptions = {},
): TaskFlowAuditFinding[] {
  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  const flows = options.flows ?? (restoreFailure ? [] : listTaskFlowRecords());
  const now = options.now ?? Date.now();
  const staleRunningMs = options.staleRunningMs ?? DEFAULT_STALE_RUNNING_MS;
  const staleWaitingMs = options.staleWaitingMs ?? DEFAULT_STALE_WAITING_MS;
  const staleBlockedMs = options.staleBlockedMs ?? DEFAULT_STALE_BLOCKED_MS;
  const cancelStuckMs = options.cancelStuckMs ?? DEFAULT_CANCEL_STUCK_MS;
  const findings: TaskFlowAuditFinding[] = [];

  if (restoreFailure) {
    findings.push(
      createFinding({
        severity: "error",
        code: "restore_failed",
        detail: `task-flow registry restore failed: ${restoreFailure}`,
      }),
    );
  }

  for (const flow of flows) {
    const referenceAt = getReferenceAt(flow);
    const ageMs = Math.max(0, now - referenceAt);
    const linkedTasks = getLinkedTasks(flow.flowId);
    const activeTasks = linkedTasks.filter((task) => isTaskFlowCancellationPending(task));

    if (flow.status === "running" && ageMs >= staleRunningMs) {
      findings.push(
        createFinding({
          severity: "error",
          code: "stale_running",
          flow,
          ageMs,
          detail: "running TaskFlow has not advanced recently",
        }),
      );
    }

    if (flow.status === "waiting" && ageMs >= staleWaitingMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_waiting",
          flow,
          ageMs,
          detail: "waiting TaskFlow has not advanced recently",
        }),
      );
    }

    if (flow.status === "blocked" && ageMs >= staleBlockedMs) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "stale_blocked",
          flow,
          ageMs,
          detail: "blocked TaskFlow has not advanced recently",
        }),
      );
    }

    if (
      flow.cancelRequestedAt != null &&
      flow.status !== "cancelled" &&
      flow.status !== "failed" &&
      flow.status !== "succeeded" &&
      flow.status !== "lost" &&
      activeTasks.length === 0 &&
      now - flow.cancelRequestedAt >= cancelStuckMs
    ) {
      findings.push(
        createFinding({
          severity: "warn",
          code: "cancel_stuck",
          flow,
          ageMs: Math.max(0, now - flow.cancelRequestedAt),
          detail: "cancel-requested TaskFlow has no active child tasks but is still nonterminal",
        }),
      );
    }

    if (
      flow.syncMode === "managed" &&
      (flow.status === "running" || flow.status === "waiting" || flow.status === "blocked") &&
      ageMs >=
        (flow.status === "running"
          ? staleRunningMs
          : flow.status === "waiting"
            ? staleWaitingMs
            : staleBlockedMs) &&
      linkedTasks.length === 0 &&
      !hasBlockingMetadata(flow)
    ) {
      findings.push(
        createFinding({
          severity: flow.status === "running" ? "error" : "warn",
          code: "missing_linked_tasks",
          flow,
          ageMs,
          detail: "managed TaskFlow has no linked tasks or wait state",
        }),
      );
    }

    if (flow.blockedTaskId?.trim()) {
      const blockedTaskId = flow.blockedTaskId.trim();
      if (!linkedTasks.some((task) => task.taskId === blockedTaskId)) {
        findings.push(
          createFinding({
            severity: "warn",
            code: "blocked_task_missing",
            flow,
            ageMs,
            detail: `blocked TaskFlow points at missing task ${blockedTaskId}`,
          }),
        );
      }
    }

    const inconsistency = findTimestampInconsistency(flow);
    if (inconsistency) {
      findings.push(inconsistency);
    }
  }

  return findings.toSorted(compareFindings);
}

export function summarizeTaskFlowAuditFindings(
  findings: Iterable<TaskFlowAuditFinding>,
): TaskFlowAuditSummary {
  const summary = createEmptyTaskFlowAuditSummary();
  for (const finding of findings) {
    summary.total += 1;
    summary.byCode[finding.code] += 1;
    if (finding.severity === "error") {
      summary.errors += 1;
    } else {
      summary.warnings += 1;
    }
  }
  return summary;
}
