import type { RuntimeEnv } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { getTaskById, updateTaskNotifyPolicyById } from "../tasks/runtime-internal.js";
import { cancelDetachedTaskRunById } from "../tasks/task-executor.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditCode,
  type TaskFlowAuditSeverity,
} from "../tasks/task-flow-registry.audit.js";
import {
  getInspectableTaskFlowAuditSummary,
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "../tasks/task-flow-registry.maintenance.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import {
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
  type TaskAuditCode,
  type TaskAuditSeverity,
} from "../tasks/task-registry.audit.js";
import { compareTaskAuditFindingSortKeys } from "../tasks/task-registry.audit.shared.js";
import {
  getInspectableTaskAuditSummary,
  getInspectableTaskRegistrySummary,
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import {
  reconcileInspectableTasks,
  reconcileTaskLookupToken,
} from "../tasks/task-registry.reconcile.js";
import { summarizeTaskRecords } from "../tasks/task-registry.summary.js";
import type { TaskNotifyPolicy, TaskRecord } from "../tasks/task-registry.types.js";
import { isRich, theme } from "../terminal/theme.js";

const RUNTIME_PAD = 8;
const STATUS_PAD = 10;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;

const info = theme.info;

async function loadTaskCancelConfig() {
  const { loadConfig } = await import("../config/config.js");
  return loadConfig();
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 1) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 1)}…`;
}

function shortToken(value: string | undefined, maxChars = ID_PAD): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "n/a";
  }
  return truncate(trimmed, maxChars);
}

function formatTaskStatusCell(status: string, rich: boolean) {
  const padded = status.padEnd(STATUS_PAD);
  if (!rich) {
    return padded;
  }
  if (status === "succeeded") {
    return theme.success(padded);
  }
  if (status === "failed" || status === "lost" || status === "timed_out") {
    return theme.error(padded);
  }
  if (status === "running") {
    return theme.accentBright(padded);
  }
  return theme.muted(padded);
}

function formatTaskRows(tasks: TaskRecord[], rich: boolean) {
  const header = [
    "Task".padEnd(ID_PAD),
    "Kind".padEnd(RUNTIME_PAD),
    "Status".padEnd(STATUS_PAD),
    "Delivery".padEnd(DELIVERY_PAD),
    "Run".padEnd(RUN_PAD),
    "Child Session",
    "Summary",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const task of tasks) {
    const summary = truncate(
      normalizeOptionalString(task.terminalSummary) ||
        normalizeOptionalString(task.progressSummary) ||
        normalizeOptionalString(task.label) ||
        task.task.trim(),
      80,
    );
    const line = [
      shortToken(task.taskId).padEnd(ID_PAD),
      task.runtime.padEnd(RUNTIME_PAD),
      formatTaskStatusCell(task.status, rich),
      task.deliveryStatus.padEnd(DELIVERY_PAD),
      shortToken(task.runId, RUN_PAD).padEnd(RUN_PAD),
      truncate(normalizeOptionalString(task.childSessionKey) || "n/a", 36).padEnd(36),
      summary,
    ].join(" ");
    lines.push(line.trimEnd());
  }
  return lines;
}

function formatTaskListSummary(tasks: TaskRecord[]) {
  const summary = summarizeTaskRecords(tasks);
  return `${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${summary.failures} issues`;
}

function formatAgeMs(ageMs: number | undefined): string {
  if (typeof ageMs !== "number" || ageMs < 1000) {
    return "fresh";
  }
  const totalSeconds = Math.floor(ageMs / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) {
    return `${days}d${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${totalSeconds}s`;
}

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

function formatAuditRows(findings: TaskSystemAuditFinding[], rich: boolean) {
  const header = [
    "Scope".padEnd(8),
    "Severity".padEnd(8),
    "Code".padEnd(22),
    "Item".padEnd(ID_PAD),
    "Status".padEnd(STATUS_PAD),
    "Age".padEnd(8),
    "Detail",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const finding of findings) {
    const severity = finding.severity.padEnd(8);
    const status = formatTaskStatusCell(finding.status ?? "n/a", rich);
    const severityCell = !rich
      ? severity
      : finding.severity === "error"
        ? theme.error(severity)
        : theme.warn(severity);
    const scope = finding.kind === "task" ? "Task" : "TaskFlow";
    lines.push(
      [
        scope.padEnd(8),
        severityCell,
        finding.code.padEnd(22),
        shortToken(finding.token).padEnd(ID_PAD),
        status,
        formatAgeMs(finding.ageMs).padEnd(8),
        truncate(finding.detail, 88),
      ]
        .join(" ")
        .trimEnd(),
    );
  }
  return lines;
}

function toSystemAuditFindings(params: {
  severityFilter?: TaskSystemAuditSeverity;
  codeFilter?: TaskSystemAuditCode;
}) {
  const taskFindings = listTaskAuditFindings();
  const flowFindings = listTaskFlowAuditFindings();
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
    flowFindings,
    summary: {
      total: sortedAllFindings.length,
      errors: sortedAllFindings.filter((finding) => finding.severity === "error").length,
      warnings: sortedAllFindings.filter((finding) => finding.severity !== "error").length,
      tasks: summarizeTaskAuditFindings(taskFindings),
      taskFlows: summarizeTaskFlowAuditFindings(flowFindings),
    },
  };
}

export async function tasksListCommand(
  opts: { json?: boolean; runtime?: string; status?: string },
  runtime: RuntimeEnv,
) {
  const runtimeFilter = opts.runtime?.trim();
  const statusFilter = opts.status?.trim();
  const tasks = reconcileInspectableTasks().filter((task) => {
    if (runtimeFilter && task.runtime !== runtimeFilter) {
      return false;
    }
    if (statusFilter && task.status !== statusFilter) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          count: tasks.length,
          runtime: runtimeFilter ?? null,
          status: statusFilter ?? null,
          tasks,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Background tasks: ${tasks.length}`));
  runtime.log(info(`Task pressure: ${formatTaskListSummary(tasks)}`));
  if (runtimeFilter) {
    runtime.log(info(`Runtime filter: ${runtimeFilter}`));
  }
  if (statusFilter) {
    runtime.log(info(`Status filter: ${statusFilter}`));
  }
  if (tasks.length === 0) {
    runtime.log("No background tasks found.");
    return;
  }
  const rich = isRich();
  for (const line of formatTaskRows(tasks, rich)) {
    runtime.log(line);
  }
}

export async function tasksShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    runtime.log(JSON.stringify(task, null, 2));
    return;
  }

  const lines = [
    "Background task:",
    `taskId: ${task.taskId}`,
    `kind: ${task.runtime}`,
    `sourceId: ${task.sourceId ?? "n/a"}`,
    `status: ${task.status}`,
    `result: ${task.terminalOutcome ?? "n/a"}`,
    `delivery: ${task.deliveryStatus}`,
    `notify: ${task.notifyPolicy}`,
    `ownerKey: ${task.ownerKey}`,
    `childSessionKey: ${task.childSessionKey ?? "n/a"}`,
    `parentTaskId: ${task.parentTaskId ?? "n/a"}`,
    `agentId: ${task.agentId ?? "n/a"}`,
    `runId: ${task.runId ?? "n/a"}`,
    `label: ${task.label ?? "n/a"}`,
    `task: ${task.task}`,
    `createdAt: ${new Date(task.createdAt).toISOString()}`,
    `startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "n/a"}`,
    `endedAt: ${task.endedAt ? new Date(task.endedAt).toISOString() : "n/a"}`,
    `lastEventAt: ${task.lastEventAt ? new Date(task.lastEventAt).toISOString() : "n/a"}`,
    `cleanupAfter: ${task.cleanupAfter ? new Date(task.cleanupAfter).toISOString() : "n/a"}`,
    ...(task.error ? [`error: ${task.error}`] : []),
    ...(task.progressSummary ? [`progressSummary: ${task.progressSummary}`] : []),
    ...(task.terminalSummary ? [`terminalSummary: ${task.terminalSummary}`] : []),
  ];
  for (const line of lines) {
    runtime.log(line);
  }
}

export async function tasksNotifyCommand(
  opts: { lookup: string; notify: TaskNotifyPolicy },
  runtime: RuntimeEnv,
) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = updateTaskNotifyPolicyById({
    taskId: task.taskId,
    notifyPolicy: opts.notify,
  });
  if (!updated) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  runtime.log(`Updated ${updated.taskId} notify policy to ${updated.notifyPolicy}.`);
}

export async function tasksCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(`Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const result = await cancelDetachedTaskRunById({
    cfg: await loadTaskCancelConfig(),
    taskId: task.taskId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? `Task not found: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(result.reason ?? `Could not cancel task: ${opts.lookup}`);
    runtime.exit(1);
    return;
  }
  const updated = getTaskById(task.taskId);
  runtime.log(
    `Cancelled ${updated?.taskId ?? task.taskId} (${updated?.runtime ?? task.runtime})${updated?.runId ? ` run ${updated.runId}` : ""}.`,
  );
}

export async function tasksAuditCommand(
  opts: {
    json?: boolean;
    severity?: TaskSystemAuditSeverity;
    code?: TaskSystemAuditCode;
    limit?: number;
  },
  runtime: RuntimeEnv,
) {
  const severityFilter = opts.severity?.trim() as TaskSystemAuditSeverity | undefined;
  const codeFilter = opts.code?.trim() as TaskSystemAuditCode | undefined;
  const { allFindings, filteredFindings, taskFindings, summary } = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;

  if (opts.json) {
    const legacySummary = summarizeTaskAuditFindings(taskFindings);
    runtime.log(
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    info(
      `Tasks audit: ${summary.total} findings · ${summary.errors} errors · ${summary.warnings} warnings`,
    ),
  );
  if (severityFilter || codeFilter) {
    runtime.log(info(`Showing ${filteredFindings.length} matching findings.`));
  }
  if (severityFilter) {
    runtime.log(info(`Severity filter: ${severityFilter}`));
  }
  if (codeFilter) {
    runtime.log(info(`Code filter: ${codeFilter}`));
  }
  if (limit) {
    runtime.log(info(`Limit: ${limit}`));
  }
  runtime.log(
    info(`Task findings: ${summary.tasks.total} · TaskFlow findings: ${summary.taskFlows.total}`),
  );
  if (displayed.length === 0) {
    runtime.log("No tasks audit findings.");
    return;
  }
  const rich = isRich();
  for (const line of formatAuditRows(displayed, rich)) {
    runtime.log(line);
  }
}

export async function tasksMaintenanceCommand(
  opts: { json?: boolean; apply?: boolean },
  runtime: RuntimeEnv,
) {
  const auditBefore = getInspectableTaskAuditSummary();
  const flowAuditBefore = getInspectableTaskFlowAuditSummary();
  const taskMaintenance = opts.apply
    ? await runTaskRegistryMaintenance()
    : previewTaskRegistryMaintenance();
  const flowMaintenance = opts.apply
    ? await runTaskFlowRegistryMaintenance()
    : previewTaskFlowRegistryMaintenance();
  const summary = getInspectableTaskRegistrySummary();
  const auditAfter = opts.apply ? getInspectableTaskAuditSummary() : auditBefore;
  const flowAuditAfter = opts.apply ? getInspectableTaskFlowAuditSummary() : flowAuditBefore;

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          mode: opts.apply ? "apply" : "preview",
          maintenance: {
            tasks: taskMaintenance,
            taskFlows: flowMaintenance,
          },
          tasks: summary,
          auditBefore: {
            ...auditBefore,
            taskFlows: flowAuditBefore,
          },
          auditAfter: {
            ...auditAfter,
            taskFlows: flowAuditAfter,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(
    info(
      `Tasks maintenance (${opts.apply ? "applied" : "preview"}): tasks ${taskMaintenance.reconciled} reconcile · ${taskMaintenance.recovered} recovered · ${taskMaintenance.cleanupStamped} cleanup stamp · ${taskMaintenance.pruned} prune; task-flows ${flowMaintenance.reconciled} reconcile · ${flowMaintenance.pruned} prune`,
    ),
  );
  runtime.log(
    info(
      `${opts.apply ? "Tasks health after apply" : "Tasks health"}: ${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${auditAfter.errors + flowAuditAfter.errors} audit errors · ${auditAfter.warnings + flowAuditAfter.warnings} audit warnings`,
    ),
  );
  if (opts.apply) {
    runtime.log(
      info(
        `Tasks health before apply: ${auditBefore.errors + flowAuditBefore.errors} audit errors · ${auditBefore.warnings + flowAuditBefore.warnings} audit warnings`,
      ),
    );
  }
  if (!opts.apply) {
    runtime.log("Dry run only. Re-run with `openclaw tasks maintenance --apply` to write changes.");
  }
}
