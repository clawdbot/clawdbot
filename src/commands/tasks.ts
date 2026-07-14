// Human-facing background task commands.
// Handles task listing/show/cancel/notify/audit plus registry maintenance for tasks, flows, and sessions.

import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatLookupMiss } from "../cli/error-format.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  runSessionRegistryMaintenanceForStore,
} from "../config/sessions.js";
import { normalizeCronLaneSegment } from "../cron/service/task-runs.js";
import { loadCronJobsStoreSync, resolveCronJobsStorePath } from "../cron/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { getTaskById, updateTaskNotifyPolicyById } from "../tasks/runtime-internal.js";
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
import type { TaskNotifyPolicy, TaskRecord } from "../tasks/task-registry.types.js";
import {
  buildTaskSystemAuditJsonPayload,
  buildTaskSystemAuditFindings,
  type TaskSystemAuditCode,
  type TaskSystemAuditFinding,
  type TaskSystemAuditSeverity,
} from "./tasks-audit-system.js";

const RUNTIME_PAD = 8;
const STATUS_PAD = 10;
const DELIVERY_PAD = 14;
const ID_PAD = 10;
const RUN_PAD = 10;
const SESSION_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60_000;

const info = theme.info;

function formatTaskLookupMiss(lookup: string): string {
  return formatLookupMiss({
    noun: "Task",
    value: lookup,
    listCommand: "openclaw tasks list",
    valueLabel: "task id",
  });
}

function formatTaskTimestamp(value: number | undefined): string {
  return timestampMsToIsoString(value) ?? "n/a";
}

async function loadTaskCancelConfig() {
  return getRuntimeConfig();
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
  if (task.runtime !== "cron" && task.runtime !== "acp") {
    return null;
  }
  try {
    const { callGateway } = await import("../gateway/call.js");
    return await callGateway<GatewayTaskCancelResult>({
      method: "tasks.cancel",
      params: { taskId: task.taskId },
      timeoutMs: 5_000,
    });
  } catch (error) {
    if (task.runtime === "acp") {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        found: true,
        cancelled: false,
        reason: `ACP task cancellation requires the live Gateway tasks.cancel path: ${detail}`,
        task,
      };
    }
    return null;
  }
}

function configureTaskMaintenanceFromConfig(): void {
  configureTaskRegistryMaintenance();
}

type SessionRegistryMaintenanceStoreSummary = {
  agentId: string;
  storePath: string;
  beforeCount: number;
  afterCount: number;
  pruned: number;
  preservedRunning: number;
};

type SessionRegistryMaintenanceSummary = {
  retentionMs: number;
  runningCronJobs: number;
  pruned: number;
  stores: SessionRegistryMaintenanceStoreSummary[];
};

function resolveExplicitCronSessionSegment(sessionKey: string | undefined): string | undefined {
  const match = /^(?:agent:[^:]+:)?cron:([^:]+)$/u.exec(sessionKey?.trim() ?? "");
  return match?.[1]?.toLowerCase();
}

function readRunningCronJobIds(): { ids: Set<string>; count: number } {
  try {
    const cronStorePath = resolveCronJobsStorePath(getRuntimeConfig().cron?.store);
    const runningJobs = loadCronJobsStoreSync(cronStorePath).jobs.filter(
      (job) => typeof job.state?.runningAtMs === "number",
    );
    return {
      // A running job may have been retargeted after its session was created. Keep both historical
      // shapes; the registry has no producer metadata, so retaining an ambiguous alias is safer
      // than pruning a live transcript.
      ids: new Set(
        runningJobs.flatMap((job) => [
          job.id.toLowerCase(),
          normalizeCronLaneSegment(job.id, "job"),
          ...(job.sessionTarget !== "main" && job.sessionKey
            ? [resolveExplicitCronSessionSegment(job.sessionKey)].filter(
                (segment): segment is string => segment !== undefined,
              )
            : []),
        ]),
      ),
      count: runningJobs.length,
    };
  } catch {
    return { ids: new Set(), count: 0 };
  }
}

async function runSessionRegistryMaintenance(params: {
  apply: boolean;
}): Promise<SessionRegistryMaintenanceSummary> {
  const cfg = getRuntimeConfig();
  const runningCronJobs = readRunningCronJobIds();
  const stores: SessionRegistryMaintenanceStoreSummary[] = [];
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    const result = await runSessionRegistryMaintenanceForStore({
      apply: params.apply,
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobIds: runningCronJobs.ids,
      storePath: target.storePath,
    });
    stores.push({
      agentId: target.agentId,
      storePath: target.storePath,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      pruned: result.pruned,
      preservedRunning: result.preservedRunning,
    });
  }
  return {
    retentionMs: SESSION_REGISTRY_RETENTION_MS,
    runningCronJobs: runningCronJobs.count,
    pruned: stores.reduce((total, store) => total + store.pruned, 0),
    stores,
  };
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }
  return maxChars <= 0 ? "" : `${truncateUtf16Safe(value, maxChars - 1)}…`;
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
  const runtimeFilter = normalizeOptionalString(opts.runtime);
  const statusFilter = normalizeOptionalString(opts.status);
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
    runtime.error(formatTaskLookupMiss(opts.lookup));
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
    runtime.log(line);
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
  runtime.log(`Updated ${updated.taskId} notify policy to ${updated.notifyPolicy}.`);
}

/** Cancels a detached task run by lookup token. */
export async function tasksCancelCommand(opts: { lookup: string }, runtime: RuntimeEnv) {
  const task = reconcileTaskLookupToken(opts.lookup);
  if (!task) {
    runtime.error(formatTaskLookupMiss(opts.lookup));
    runtime.exit(1);
    return;
  }
  const gatewayResult = await tryCancelGatewayOwnedTaskViaGateway(task);
  if (gatewayResult) {
    if (!gatewayResult.found) {
      runtime.error(gatewayResult.reason ?? formatTaskLookupMiss(opts.lookup));
      runtime.exit(1);
      return;
    }
    if (!gatewayResult.cancelled) {
      runtime.error(gatewayResult.reason ?? `Could not cancel task: ${opts.lookup}`);
      runtime.exit(1);
      return;
    }
    const updated = gatewayResult.task;
    runtime.log(
      `Cancelled ${updated?.taskId ?? updated?.id ?? task.taskId} (${updated?.runtime ?? task.runtime})${updated?.runId ? ` run ${updated.runId}` : ""}.`,
    );
    return;
  }
  const result = await cancelDetachedTaskRunById({
    cfg: await loadTaskCancelConfig(),
    taskId: task.taskId,
  });
  if (!result.found) {
    runtime.error(result.reason ?? formatTaskLookupMiss(opts.lookup));
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
  configureTaskMaintenanceFromConfig();
  const severityFilter = normalizeOptionalString(opts.severity) as
    | TaskSystemAuditSeverity
    | undefined;
  const codeFilter = normalizeOptionalString(opts.code) as TaskSystemAuditCode | undefined;
  const auditResult = toSystemAuditFindings({
    severityFilter,
    codeFilter,
  });
  const { filteredFindings, summary } = auditResult;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const displayed = limit ? filteredFindings.slice(0, limit) : filteredFindings;

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildTaskSystemAuditJsonPayload(auditResult, {
          severityFilter,
          codeFilter,
          limit: opts.limit,
        }),
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
    runtime.log(
      JSON.stringify(
        {
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
      `Session registry: ${sessionMaintenance.pruned} prune · ${sessionMaintenance.runningCronJobs} running cron jobs`,
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
