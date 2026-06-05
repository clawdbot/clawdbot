// JSON-only task command helpers.
// These paths avoid maintenance reconciliation so short-lived JSON CLI processes stay read-only and exit cleanly.

import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { listTaskRecords } from "../tasks/runtime-internal.js";
import { listTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import { listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";
import { listTaskAuditFindings, summarizeTaskAuditFindings } from "../tasks/task-registry.audit.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildTaskSystemAuditFindings,
  type TaskSystemAuditCode,
  type TaskSystemAuditSeverity,
} from "./tasks-audit-system.js";

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

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const tasks = listTaskJsonRecords();
  const flows = listTaskFlowRecords();
  const taskFindings = listTaskAuditFindings({ tasks });
  const flowFindings = listTaskFlowAuditFindings({ flows });
  const result = buildTaskSystemAuditFindings({
    taskFindings,
    flowFindings,
    severityFilter: params.severityFilter,
    codeFilter: params.codeFilter,
  });
  return result;
}

function buildTasksListJsonPayload(opts: TasksListJsonArgs) {
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

function buildTasksAuditJsonPayload(opts: TasksAuditJsonArgs) {
  const severityFilter = opts.severity?.trim() as TaskSystemAuditSeverity | undefined;
  const codeFilter = opts.code?.trim() as TaskSystemAuditCode | undefined;
  const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;
  // Preserve the legacy task-only summary while adding combined task-flow counts.
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

/** Writes task list JSON without triggering task maintenance. */
export async function tasksListJsonCommand(
  opts: TasksListJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksListJsonPayload(opts));
}

/** Writes task audit JSON with combined task/task-flow findings. */
export async function tasksAuditJsonCommand(
  opts: TasksAuditJsonArgs,
  runtime: RuntimeEnv,
): Promise<void> {
  writeRuntimeJson(runtime, buildTasksAuditJsonPayload(opts));
}
