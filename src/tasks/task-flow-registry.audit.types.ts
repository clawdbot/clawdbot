import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskAuditSeverity } from "./task-registry.audit.shared.js";

/** Canonical task-flow audit finding vocabulary. */
export const TASK_FLOW_AUDIT_CODES = [
  "restore_failed",
  "stale_running",
  "stale_waiting",
  "stale_blocked",
  "cancel_stuck",
  "missing_linked_tasks",
  "blocked_task_missing",
  "inconsistent_timestamps",
] as const;
export type TaskFlowAuditSeverity = TaskAuditSeverity;
export type TaskFlowAuditCode = (typeof TASK_FLOW_AUDIT_CODES)[number];

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
