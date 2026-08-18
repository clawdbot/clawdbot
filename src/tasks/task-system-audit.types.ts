import { TASK_FLOW_AUDIT_CODES, type TaskFlowAuditCode } from "./task-flow-registry.audit.types.js";
import {
  TASK_AUDIT_CODES,
  TASK_AUDIT_SEVERITIES,
  type TaskAuditCode,
  type TaskAuditSeverity,
} from "./task-registry.audit.shared.js";

export type TaskSystemAuditCode = TaskAuditCode | TaskFlowAuditCode;
export type TaskSystemAuditSeverity = TaskAuditSeverity;

/** De-duplicated vocabulary accepted by the combined tasks audit command. */
export const TASK_SYSTEM_AUDIT_CODES: readonly TaskSystemAuditCode[] = [
  ...TASK_AUDIT_CODES,
  ...TASK_FLOW_AUDIT_CODES.filter(
    (flowCode) => !TASK_AUDIT_CODES.some((taskCode) => taskCode === flowCode),
  ),
];
export const TASK_SYSTEM_AUDIT_SEVERITIES = TASK_AUDIT_SEVERITIES;
