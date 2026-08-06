// Combines task and task-flow audit findings for CLI output.
// The combined shape lets list/json commands filter and sort both registries together.

import type {
  TaskFlowAuditCode,
  TaskFlowAuditFinding,
  TaskFlowAuditSeverity,
} from "../tasks/task-flow-registry.audit.js";
import { summarizeTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type {
  TaskAuditCode,
  TaskAuditFinding,
  TaskAuditSeverity,
} from "../tasks/task-registry.audit.js";
import { summarizeTaskAuditFindings } from "../tasks/task-registry.audit.js";
import { compareTaskAuditFindingSortKeys } from "../tasks/task-registry.audit.shared.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

export type TaskSystemAuditCode = TaskAuditCode | TaskFlowAuditCode;
export type TaskSystemAuditSeverity = TaskAuditSeverity | TaskFlowAuditSeverity;

export type TaskSystemAuditFinding = {
  kind: "task" | "task_flow";
  severity: TaskSystemAuditSeverity;
  code: TaskSystemAuditCode;
  detail: string;
  ageMs?: number;
  status?: string;
  token?: string;
  task?: TaskRecord;
  flow?: TaskFlowRecord;
};

function compareSystemAuditFindings(left: TaskSystemAuditFinding, right: TaskSystemAuditFinding) {
  return compareTaskAuditFindingSortKeys(
    {
      severity: left.severity,
      ageMs: left.ageMs,
      createdAt: left.task?.createdAt ?? left.flow?.createdAt ?? 0,
    },
    {
      severity: right.severity,
      ageMs: right.ageMs,
      createdAt: right.task?.createdAt ?? right.flow?.createdAt ?? 0,
    },
  );
}

/** Builds combined task/task-flow audit findings with optional severity/code filtering. */
export function buildTaskSystemAuditFindings(params: {
  taskFindings: TaskAuditFinding[];
  flowFindings: TaskFlowAuditFinding[];
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const allFindings: TaskSystemAuditFinding[] = [
    ...params.taskFindings.map((finding) => ({
      kind: "task" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.task.status,
      token: finding.task.taskId,
      task: finding.task,
    })),
    ...params.flowFindings.map((finding) => ({
      kind: "task_flow" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.flow?.status ?? "n/a",
      token: finding.flow?.flowId,
      ...(finding.flow ? { flow: finding.flow } : {}),
    })),
  ];
  const filteredFindings = allFindings
    .filter((finding) => {
      if (params.severityFilter && finding.severity !== params.severityFilter) {
        return false;
      }
      if (params.codeFilter && finding.code !== params.codeFilter) {
        return false;
      }
      return true;
    })
    .toSorted(compareSystemAuditFindings);
  // Keep summary counts based on the full sorted set; filters only affect displayed findings.
  const sortedAllFindings = [...allFindings].toSorted(compareSystemAuditFindings);
  return {
    allFindings: sortedAllFindings,
    filteredFindings,
    taskFindings: params.taskFindings,
    flowFindings: params.flowFindings,
    summary: {
      total: sortedAllFindings.length,
      errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
      warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
      tasks: summarizeTaskAuditFindings(params.taskFindings),
      taskFlows: summarizeTaskFlowAuditFindings(params.flowFindings),
    },
  };
}

type TaskSystemAuditResult = ReturnType<typeof buildTaskSystemAuditFindings>;

export function buildTaskSystemAuditJsonPayload(
  result: TaskSystemAuditResult,
  params: {
    severityFilter?: TaskSystemAuditSeverity;
    codeFilter?: TaskSystemAuditCode;
    limit?: number;
  },
) {
  const { allFindings, filteredFindings, taskFindings, summary } = result;
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
  // Preserve the legacy task-only summary while adding combined task-flow counts.
  const legacySummary = summarizeTaskAuditFindings(taskFindings);
  return {
    count: allFindings.length,
    filteredCount: filteredFindings.length,
    displayed: displayed.length,
    filters: {
      severity: params.severityFilter ?? null,
      code: params.codeFilter ?? null,
      limit: limit ?? null,
    },
    summary: {
      ...legacySummary,
      taskFlows: summary.taskFlows,
      combined: {
        total: summary.total,
        errors: summary.errors,
        warnings: summary.warnings,
      },
    },
    findings: displayed,
  };
}
