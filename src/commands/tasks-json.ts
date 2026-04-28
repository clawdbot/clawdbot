import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { listTaskRecords } from "../tasks/runtime-internal.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditCode,
  type TaskFlowAuditSeverity,
} from "../tasks/task-flow-registry.audit.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import { listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";
import {
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
  type TaskAuditCode,
  type TaskAuditSeverity,
} from "../tasks/task-registry.audit.js";
import { compareTaskAuditFindingSortKeys } from "../tasks/task-registry.audit.shared.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

type TaskSystemAuditCode = TaskAuditCode | TaskFlowAuditCode;
type TaskSystemAuditSeverity = TaskAuditSeverity | TaskFlowAuditSeverity;

type TaskSystemAuditFinding = {
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

function listTaskJsonRecords(): TaskRecord[] {
  // Keep the routed JSON path a read-only store snapshot; maintenance reconciliation imports
  // broader task runtimes and can keep JSON-only CLI processes alive.
  return listTaskRecords();
}

export type TasksListJsonArgs = {
  json?: boolean;
  runtime?: string;
  status?: string;
};

export type TasksAuditJsonArgs = {
  json?: boolean;
  severity?: string;
  code?: string;
  limit?: number;
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

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const tasks = listTaskJsonRecords();
  const flows = listTaskFlowRecords();
  const taskFindings = listTaskAuditFindings({ tasks });
  const flowFindings = listTaskFlowAuditFindings({ flows });
  const allFindings: TaskSystemAuditFinding[] = [
    ...taskFindings.map((finding) => ({
      kind: "task" as const,
      severity: finding.severity,
      code: finding.code,
      detail: finding.detail,
      ageMs: finding.ageMs,
      status: finding.task.status,
      token: finding.task.taskId,
      task: finding.task,
    })),
    ...flowFindings.map((finding) => ({
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
  const sortedAllFindings = [...allFindings].toSorted(compareSystemAuditFindings);
  return {
    allFindings: sortedAllFindings,
    filteredFindings,
    taskFindings,
    summary: {
      total: sortedAllFindings.length,
      errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
      warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
      taskFlows: summarizeTaskFlowAuditFindings(flowFindings),
    },
  };
}

export function buildTasksListJsonPayload(opts: TasksListJsonArgs) {
  const runtimeFilter = opts.runtime?.trim();
  const statusFilter = opts.status?.trim();
  const tasks = listTaskJsonRecords().filter((task) => {
    if (runtimeFilter && task.runtime !== runtimeFilter) {
      return false;
    }
    if (statusFilter && task.status !== statusFilter) {
      return false;
    }
    return true;
  });
  return {
    count: tasks.length,
    runtime: runtimeFilter ?? null,
    status: statusFilter ?? null,
    tasks,
  };
}

export function buildTasksAuditJsonPayload(opts: TasksAuditJsonArgs) {
  const severityFilter = opts.severity?.trim() as TaskSystemAuditSeverity | undefined;
  const codeFilter = opts.code?.trim() as TaskSystemAuditCode | undefined;
  const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
  const legacySummary = summarizeTaskAuditFindings(taskFindings);
  return {
    count: allFindings.length,
    filteredCount: filteredFindings.length,
    displayed: displayed.length,
    filters: {
      severity: severityFilter ?? null,
      code: codeFilter ?? null,
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

export async function tasksListJsonCommand(
  opts: TasksListJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksListJsonPayload(opts));
}

export async function tasksAuditJsonCommand(
  opts: TasksAuditJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksAuditJsonPayload(opts));
}
