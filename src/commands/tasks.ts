// Human-facing background task commands.
// Handles task listing/show/cancel/notify/audit plus registry maintenance for tasks, flows, and sessions.

import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { parseCliEnumFilter } from "../cli/enum-filter.js";
import { formatLookupMiss } from "../cli/error-format.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "../cli/failure-output.js";
import { getRuntimeConfig } from "../config/config.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { updateTaskNotifyPolicyById } from "../tasks/runtime-internal.js";
import { cancelDetachedTaskRunById } from "../tasks/task-executor.js";
import { listTaskFlowAuditFindings } from "../tasks/task-flow-registry.audit.js";
import {
  assertTaskFlowRegistryMaintenanceReady,
  getInspectableTaskFlowAuditSummary,
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "../tasks/task-flow-registry.maintenance.js";
import {
  listTaskAuditFindings,
  summarizeRetainedLostTaskAuditFindings,
} from "../tasks/task-registry.audit.js";
import {
  getInspectableTaskAuditSummary,
  getInspectableTaskRegistrySummary,
  configureTaskRegistryMaintenance,
  getTaskRegistryMaintenanceDiagnostics,
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import {
  reconcileInspectableTasks,
  reconcileTaskLookupToken,
} from "../tasks/task-registry.reconcile.js";
import { summarizeTaskRecords } from "../tasks/task-registry.summary.js";
import {
  matchesTaskStatusFilter,
  TASK_RUNTIMES,
  TASK_STATUS_FILTERS,
  type TaskNotifyPolicy,
  type TaskRecord,
} from "../tasks/task-registry.types.js";
import {
  formatTaskStatus,
  formatTaskStatusDetail,
  isTaskStatusIssue,
} from "../tasks/task-status.js";
import {
  TASK_SYSTEM_AUDIT_CODES,
  TASK_SYSTEM_AUDIT_SEVERITIES,
  type TaskSystemAuditCode,
  type TaskSystemAuditSeverity,
} from "../tasks/task-system-audit.types.js";
import { formatTaskStatusCell, TASK_STATUS_CELL_WIDTH } from "./task-status-cell.js";
import {
  buildTaskSystemAuditJsonPayload,
  buildTaskSystemAuditFindings,
  type TaskSystemAuditFinding,
} from "./tasks-audit-system.js";
import { runSessionRegistryMaintenance } from "./tasks-session-registry-maintenance.js";
import { formatTextCell } from "./text-format.js";

const RUNTIME_PAD = 8;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;
const CHILD_SESSION_PAD = 36;
const info = theme.info;

function formatTaskLookupMiss(lookup: string): string {
  return formatLookupMiss({
    noun: "Task",
    value: sanitizeTerminalText(lookup),
    listCommand: "openclaw tasks list",
    valueLabel: "task id",
  });
}

function formatTaskTimestamp(value: number | undefined): string {
  return timestampMsToIsoString(value) ?? "n/a";
}

type GatewayTaskCancelSummary = {
  id?: string;
  taskId?: string;
  runtime?: string;
  runId?: string;
};

type GatewayTaskCancelResult = {
  found?: boolean;
  cancelled?: boolean;
  reason?: string;
  task?: GatewayTaskCancelSummary;
};

async function tryCancelGatewayOwnedTaskViaGateway(
  task: TaskRecord,
): Promise<GatewayTaskCancelResult | null> {
  try {
    const { callGateway } = await import("../gateway/call.js");
    return await callGateway<GatewayTaskCancelResult>({
      method: "tasks.cancel",
      params: { taskId: task.taskId },
      // Ordinary agent cancellation waits for its real execution to settle.
      timeoutMs: task.runtime === "cli" ? 15_000 : 5_000,
    });
  } catch (error) {
    if (task.runtime === "cron") {
      return null;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      found: true,
      cancelled: false,
      reason: `${task.runtime.toUpperCase()} task cancellation requires the live Gateway tasks.cancel path: ${detail}`,
      task,
    };
  }
}

function configureTaskMaintenanceFromConfig(): void {
  configureTaskRegistryMaintenance();
}

function truncate(value: string, maxChars: number) {
  return truncateWithMarker(value, maxChars, { marker: "…", reserve: 1, trimEnd: false });
}

function formatTokenCell(value: string | undefined, width = ID_PAD): string {
  const sanitized = sanitizeTerminalText(normalizeOptionalString(value) ?? "").trim();
  return formatTextCell(sanitized || "n/a", width);
}

function formatTaskRows(tasks: TaskRecord[], rich: boolean) {
  const header = [
    "Task".padEnd(ID_PAD),
    "Kind".padEnd(RUNTIME_PAD),
    "Status".padEnd(TASK_STATUS_CELL_WIDTH),
    "Delivery".padEnd(DELIVERY_PAD),
    "Run".padEnd(RUN_PAD),
    "Child Session".padEnd(CHILD_SESSION_PAD),
    "Summary",
  ].join(" ");
  const lines = [rich ? theme.heading(header) : header];
  for (const task of tasks) {
    const summary = truncate(
      sanitizeTerminalText(
        formatTaskStatusDetail(task) || normalizeOptionalString(task.label) || task.task.trim(),
      ),
      80,
    );
    const line = [
      formatTokenCell(task.taskId),
      task.runtime.padEnd(RUNTIME_PAD),
      formatTaskStatusCell(formatTaskStatus(task), rich),
      task.deliveryStatus.padEnd(DELIVERY_PAD),
      formatTokenCell(task.runId, RUN_PAD),
      formatTokenCell(task.childSessionKey, CHILD_SESSION_PAD),
      summary,
    ].join(" ");
    lines.push(line.trimEnd());
  }
  return lines;
}

function formatTaskListSummary(tasks: TaskRecord[]) {
  const summary = summarizeTaskRecords(tasks);
  return `${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${tasks.filter(isTaskStatusIssue).length} issues`;
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

function formatAuditRows(findings: TaskSystemAuditFinding[], rich: boolean) {
  const header = [
    "Scope".padEnd(8),
    "Severity".padEnd(8),
    "Code".padEnd(22),
    "Item".padEnd(ID_PAD),
    "Status".padEnd(TASK_STATUS_CELL_WIDTH),
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
        formatTokenCell(finding.token),
        status,
        formatAgeMs(finding.ageMs).padEnd(8),
        truncate(sanitizeTerminalText(finding.detail), 88),
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
  // Human audit reconciles inspectable tasks first so stale detached runs are reflected.
  const taskFindings = listTaskAuditFindings({ tasks: reconcileInspectableTasks() });
  const flowFindings = listTaskFlowAuditFindings();
  return buildTaskSystemAuditFindings({
    taskFindings,
    flowFindings,
    severityFilter: params.severityFilter,
    codeFilter: params.codeFilter,
  });
}

/** Lists background tasks with optional runtime/status filters. */
export async function tasksListCommand(
  opts: { json?: boolean; runtime?: string; status?: string },
  runtime: RuntimeEnv,
) {
  const runtimeFilter = parseCliEnumFilter(opts.runtime, "--runtime", TASK_RUNTIMES);
  const statusFilter = parseCliEnumFilter(opts.status, "--status", TASK_STATUS_FILTERS);
  const tasks = reconcileInspectableTasks().filter((task) => {
    if (runtimeFilter && task.runtime !== runtimeFilter) {
      return false;
    }
    if (statusFilter && !matchesTaskStatusFilter(task, statusFilter)) {
      return false;
    }
    return true;
  });

  if (opts.json) {
    writeRuntimeJson(runtime, {
      count: tasks.length,
      runtime: runtimeFilter ?? null,
      status: statusFilter ?? null,
      tasks,
    });
    return;
  }

  runtime.log(info(`Background tasks: ${tasks.length}`));
  runtime.log(info(`Task pressure: ${formatTaskListSummary(tasks)}`));
  if (runtimeFilter) {
    runtime.log(info(`Runtime filter: ${sanitizeTerminalText(runtimeFilter)}`));
  }
  if (statusFilter) {
    runtime.log(info(`Status filter: ${sanitizeTerminalText(statusFilter)}`));
  }
  if (tasks.length === 0) {
    runtime.log(
      `No background tasks found. Run ${formatCliCommand("openclaw tasks audit")} to check for stale task state.`,
    );
    return;
  }
  const rich = isRich();
  for (const line of formatTaskRows(tasks, rich)) {
    runtime.log(line);
  }
}

/** Shows one task record by id or lookup token. */
export async function tasksShowCommand(
  opts: { json?: boolean; lookup: string },
  runtime: RuntimeEnv,
) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    const message = formatTaskLookupMiss(opts.lookup);
    if (opts.json) {
      writeRuntimeJson(runtime, formatCliJsonFailure(message));
    } else {
      runtime.error(message);
    }
    runtime.exit(1, opts.json ? { resetStream: process.stderr } : undefined);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, task);
    return;
  }

  const lines = [
    "Background task:",
    `taskId: ${task.taskId}`,
    `kind: ${task.runtime}`,
    `sourceId: ${task.sourceId ?? "n/a"}`,
    `status: ${formatTaskStatus(task)}`,
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
    `createdAt: ${formatTaskTimestamp(task.createdAt)}`,
    `startedAt: ${formatTaskTimestamp(task.startedAt)}`,
    `endedAt: ${formatTaskTimestamp(task.endedAt)}`,
    `lastEventAt: ${formatTaskTimestamp(task.lastEventAt)}`,
    `cleanupAfter: ${formatTaskTimestamp(task.cleanupAfter)}`,
    ...(task.error ? [`error: ${task.error}`] : []),
    ...(task.progressSummary ? [`progressSummary: ${task.progressSummary}`] : []),
    ...(task.terminalSummary ? [`terminalSummary: ${task.terminalSummary}`] : []),
  ];
  for (const line of lines) {
    runtime.log(sanitizeTerminalText(line));
  }
}

/** Updates a task's notification policy. */
export async function tasksNotifyCommand(
  opts: { lookup: string; notify: TaskNotifyPolicy },
  runtime: RuntimeEnv,
) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(formatTaskLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const updated = updateTaskNotifyPolicyById({
    taskId: task.taskId,
    notifyPolicy: opts.notify,
  });
  if (!updated) {
    runtime.error(formatTaskLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  runtime.log(
    sanitizeTerminalText(`Updated ${updated.taskId} notify policy to ${updated.notifyPolicy}.`),
  );
}

/** Cancels a detached task run by lookup token. */
export async function tasksCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(formatTaskLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const result: GatewayTaskCancelResult =
    (await tryCancelGatewayOwnedTaskViaGateway(task)) ??
    (await cancelDetachedTaskRunById({
      cfg: getRuntimeConfig(),
      taskId: task.taskId,
    }));
  if (!result.found) {
    runtime.error(sanitizeTerminalText(result.reason ?? formatTaskLookupMiss(opts.lookup)));
    runtime.exit(1);
    return;
  }
  if (!result.cancelled) {
    runtime.error(sanitizeTerminalText(result.reason ?? `Could not cancel task: ${opts.lookup}`));
    runtime.exit(1);
    return;
  }
  const updated = result.task;
  runtime.log(
    sanitizeTerminalText(
      `Cancelled ${updated?.taskId ?? updated?.id ?? task.taskId} (${updated?.runtime ?? task.runtime})${updated?.runId ? ` run ${updated.runId}` : ""}.`,
    ),
  );
}

type GatewayTaskRecoveryResult = {
  results?: Array<{ taskId?: string; ok?: boolean; reason?: string; duplicateRisk?: boolean }>;
};

async function runTaskRecoveryCommand(
  action: "retry" | "dismiss",
  lookups: string[],
  runtime: RuntimeEnv,
) {
  if (lookups.length > 10) {
    runtime.error("At most 10 task deliveries can be recovered per request.");
    runtime.exit(1);
    return;
  }
  const tasks: TaskRecord[] = [];
  for (const lookup of lookups) {
    const task = reconcileTaskLookupToken(lookup);
    if (!task) {
      runtime.error(formatTaskLookupMiss(lookup));
      runtime.exit(1);
      return;
    }
    tasks.push(task);
  }
  try {
    const { callGateway } = await import("../gateway/call.js");
    const response = await callGateway<GatewayTaskRecoveryResult>({
      method: `tasks.${action}`,
      params: { taskIds: tasks.map((task) => task.taskId) },
      timeoutMs: 10_000,
    });
    const failures = response.results?.filter((result) => result.ok !== true) ?? [];
    if (failures.length > 0) {
      for (const failure of failures) {
        runtime.error(
          sanitizeTerminalText(
            `${failure.taskId ?? "task"}: ${failure.reason ?? `${action} failed`}`,
          ),
        );
      }
      runtime.exit(1);
      return;
    }
    runtime.log(
      sanitizeTerminalText(
        `${action === "retry" ? "Retried" : "Dismissed"} ${tasks.length} ${tasks.length === 1 ? "completion delivery" : "completion deliveries"}.${action === "retry" ? " Ambiguous prior acknowledgements may still produce a duplicate visible result." : ""}`,
      ),
    );
  } catch (error) {
    rethrowExpectedCliError(error);
    runtime.error(
      sanitizeTerminalText(
        `Task delivery ${action} requires a live Gateway: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    runtime.exit(1);
  }
}

/** Starts a new fenced delivery generation for one to ten blocked completions. */
export async function tasksRetryCommand(opts: { lookups: string[] }, runtime: RuntimeEnv) {
  await runTaskRecoveryCommand("retry", opts.lookups, runtime);
}

/** Records intentional non-delivery while preserving the task result and audit projection. */
export async function tasksDismissCommand(opts: { lookups: string[] }, runtime: RuntimeEnv) {
  await runTaskRecoveryCommand("dismiss", opts.lookups, runtime);
}

/** Prints or serializes combined task/task-flow audit findings. */
export async function tasksAuditCommand(
  opts: {
    json?: boolean;
    severity?: TaskSystemAuditSeverity;
    code?: TaskSystemAuditCode;
    limit?: number;
  },
  runtime: RuntimeEnv,
) {
  const severityFilter = parseCliEnumFilter(
    opts.severity,
    "--severity",
    TASK_SYSTEM_AUDIT_SEVERITIES,
  ) as TaskSystemAuditSeverity | undefined;
  const codeFilter = parseCliEnumFilter(opts.code, "--code", TASK_SYSTEM_AUDIT_CODES) as
    | TaskSystemAuditCode
    | undefined;
  configureTaskMaintenanceFromConfig();
  const auditResult = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const { filteredFindings, summary } = auditResult;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;

  if (opts.json) {
    writeRuntimeJson(
      runtime,
      buildTaskSystemAuditJsonPayload(auditResult, {
        severityFilter,
        codeFilter,
        limit: opts.limit,
      }),
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
    runtime.log(info(`Severity filter: ${sanitizeTerminalText(severityFilter)}`));
  }
  if (codeFilter) {
    runtime.log(info(`Code filter: ${sanitizeTerminalText(codeFilter)}`));
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

/** Previews or applies task, task-flow, and backing session-registry maintenance. */
export async function tasksMaintenanceCommand(
  opts: { json?: boolean; apply?: boolean },
  runtime: RuntimeEnv,
) {
  configureTaskMaintenanceFromConfig();
  assertTaskFlowRegistryMaintenanceReady();
  const auditBefore = getInspectableTaskAuditSummary();
  const flowAuditBefore = getInspectableTaskFlowAuditSummary();
  const taskMaintenance = opts.apply
    ? await runTaskRegistryMaintenance()
    : previewTaskRegistryMaintenance();
  // JSON diagnostics explain the task-maintenance decision above, before the
  // separate session-registry sweep can prune backing session rows.
  const diagnostics = opts.json ? getTaskRegistryMaintenanceDiagnostics() : undefined;
  const flowMaintenance = opts.apply
    ? await runTaskFlowRegistryMaintenance()
    : previewTaskFlowRegistryMaintenance();
  const sessionMaintenance = await runSessionRegistryMaintenance({ apply: Boolean(opts.apply) });
  const summary = getInspectableTaskRegistrySummary();
  const auditAfter = opts.apply ? getInspectableTaskAuditSummary() : auditBefore;
  const flowAuditAfter = opts.apply ? getInspectableTaskFlowAuditSummary() : flowAuditBefore;
  const retainedLostAfter = summarizeRetainedLostTaskAuditFindings(
    listTaskAuditFindings({ tasks: reconcileInspectableTasks() }),
  );

  if (opts.json) {
    writeRuntimeJson(runtime, {
      mode: opts.apply ? "apply" : "preview",
      maintenance: {
        tasks: taskMaintenance,
        taskFlows: flowMaintenance,
        sessions: sessionMaintenance,
      },
      tasks: summary,
      diagnostics,
      auditBefore: {
        ...auditBefore,
        taskFlows: flowAuditBefore,
      },
      auditAfter: {
        ...auditAfter,
        taskFlows: flowAuditAfter,
      },
    });
    return;
  }

  runtime.log(
    info(
      `Tasks maintenance (${opts.apply ? "applied" : "preview"}): tasks ${taskMaintenance.reconciled} reconcile · ${taskMaintenance.recovered} recovered · ${taskMaintenance.cleanupStamped} cleanup stamp · ${taskMaintenance.pruned} prune; task-flows ${flowMaintenance.reconciled} reconcile · ${flowMaintenance.pruned} prune`,
    ),
  );
  runtime.log(
    info(
      sessionMaintenance.skippedReason
        ? `Session registry: sweep skipped (${sessionMaintenance.skippedReason})`
        : `Session registry: ${sessionMaintenance.pruned} prune · ${sessionMaintenance.runningCronJobs} running automations · ${sessionMaintenance.skippedStores} skipped ${sessionMaintenance.skippedStores === 1 ? "store" : "stores"}`,
    ),
  );
  runtime.log(
    info(
      `${opts.apply ? "Tasks health after apply" : "Tasks health"}: ${summary.byStatus.queued} queued · ${summary.byStatus.running} running · ${auditAfter.errors + flowAuditAfter.errors} audit errors · ${auditAfter.warnings + flowAuditAfter.warnings} audit warnings`,
    ),
  );
  if (retainedLostAfter.count > 0) {
    runtime.log(
      info(
        `Retained lost tasks: ${retainedLostAfter.count} retained until ${timestampMsToIsoString(retainedLostAfter.nextCleanupAfter) ?? "cleanupAfter"}; maintenance will prune after cleanupAfter.`,
      ),
    );
  }
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
