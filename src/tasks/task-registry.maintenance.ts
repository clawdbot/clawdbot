import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { readCronRunLogEntriesSync, resolveCronRunLogPath } from "../cron/run-log.js";
import type { CronRunLogEntry } from "../cron/run-log.js";
import { loadCronStoreSync, resolveCronStorePath } from "../cron/store.js";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { deriveSessionChatType } from "../sessions/session-chat-type.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { tryRecoverTaskBeforeMarkLost } from "./detached-task-runtime.js";
import {
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  listTaskRecords,
  markTaskLostById,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
  setTaskCleanupAfterById,
} from "./runtime-internal.js";
import {
  configureTaskAuditTaskProvider,
  listTaskAuditFindings,
  summarizeTaskAuditFindings,
} from "./task-registry.audit.js";
import type { TaskAuditSummary } from "./task-registry.audit.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary, TaskStatus } from "./task-registry.types.js";

const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TASK_SWEEP_INTERVAL_MS = 60_000;

/**
 * Number of tasks to process before yielding to the event loop.
 * Keeps the main thread responsive during large sweeps.
 */
const SWEEP_YIELD_BATCH_SIZE = 25;

let sweeper: NodeJS.Timeout | null = null;
let deferredSweep: NodeJS.Timeout | null = null;
let sweepInProgress = false;
let configuredCronStorePath: string | undefined;
let configuredCronRuntimeAuthoritative = false;

type TaskRegistryMaintenanceRuntime = {
  readAcpSessionEntry: typeof readAcpSessionEntry;
  loadSessionStore: typeof loadSessionStore;
  resolveStorePath: typeof resolveStorePath;
  isCronJobActive: typeof isCronJobActive;
  getAgentRunContext: typeof getAgentRunContext;
  parseAgentSessionKey: typeof parseAgentSessionKey;
  deleteTaskRecordById: typeof deleteTaskRecordById;
  ensureTaskRegistryReady: typeof ensureTaskRegistryReady;
  getTaskById: typeof getTaskById;
  listTaskRecords: typeof listTaskRecords;
  markTaskLostById: typeof markTaskLostById;
  markTaskTerminalById: typeof markTaskTerminalById;
  maybeDeliverTaskTerminalUpdate: typeof maybeDeliverTaskTerminalUpdate;
  resolveTaskForLookupToken: typeof resolveTaskForLookupToken;
  setTaskCleanupAfterById: typeof setTaskCleanupAfterById;
  isCronRuntimeAuthoritative: () => boolean;
  resolveCronStorePath: typeof resolveCronStorePath;
  loadCronStoreSync: typeof loadCronStoreSync;
  resolveCronRunLogPath: typeof resolveCronRunLogPath;
  readCronRunLogEntriesSync: typeof readCronRunLogEntriesSync;
};

const defaultTaskRegistryMaintenanceRuntime: TaskRegistryMaintenanceRuntime = {
  readAcpSessionEntry,
  loadSessionStore,
  resolveStorePath,
  isCronJobActive,
  getAgentRunContext,
  parseAgentSessionKey,
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  listTaskRecords,
  markTaskLostById,
  markTaskTerminalById,
  maybeDeliverTaskTerminalUpdate,
  resolveTaskForLookupToken,
  setTaskCleanupAfterById,
  isCronRuntimeAuthoritative: () => configuredCronRuntimeAuthoritative,
  resolveCronStorePath: () => configuredCronStorePath ?? resolveCronStorePath(),
  loadCronStoreSync,
  resolveCronRunLogPath,
  readCronRunLogEntriesSync,
};

let taskRegistryMaintenanceRuntime: TaskRegistryMaintenanceRuntime =
  defaultTaskRegistryMaintenanceRuntime;

export type TaskRegistryMaintenanceSummary = {
  reconciled: number;
  recovered: number;
  cleanupStamped: number;
  pruned: number;
};

type CronExecutionId = {
  jobId: string;
  startedAt: number;
};

type CronTerminalRecovery = {
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out">;
  endedAt: number;
  lastEventAt: number;
  error?: string;
  terminalSummary?: string;
};

type CronRecoveryContext = {
  storePath: string;
  store?: CronStoreFile | null;
  runLogsByJobId: Map<string, CronRunLogEntry[]>;
};

function createCronRecoveryContext(): CronRecoveryContext {
  return {
    storePath: taskRegistryMaintenanceRuntime.resolveCronStorePath(),
    runLogsByJobId: new Map<string, CronRunLogEntry[]>(),
  };
}

function findSessionEntryByKey(store: Record<string, unknown>, sessionKey: string): unknown {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  for (const [key, entry] of Object.entries(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === normalized) {
      return entry;
    }
  }
  return undefined;
}

function isActiveTask(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isTerminalTask(task: TaskRecord): boolean {
  return !isActiveTask(task);
}

function hasLostGraceExpired(task: TaskRecord, now: number): boolean {
  const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  return now - referenceAt >= TASK_RECONCILE_GRACE_MS;
}

function parseCronExecutionId(task: TaskRecord): CronExecutionId | undefined {
  const runId = task.runId?.trim();
  if (!runId?.startsWith("cron:")) {
    return undefined;
  }
  const separator = runId.lastIndexOf(":");
  if (separator <= "cron:".length) {
    return undefined;
  }
  const startedAt = Number(runId.slice(separator + 1));
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  const jobId = runId.slice("cron:".length, separator).trim();
  if (!jobId || (task.sourceId?.trim() && task.sourceId.trim() !== jobId)) {
    return undefined;
  }
  return { jobId, startedAt };
}

function isTimeoutCronError(error: string | undefined): boolean {
  return error === "cron: job execution timed out";
}

function mapCronTerminalStatus(status: unknown, error?: string): CronTerminalRecovery["status"] {
  if (status === "ok" || status === "skipped") {
    return "succeeded";
  }
  return isTimeoutCronError(error) ? "timed_out" : "failed";
}

function getCronRunLogEntries(context: CronRecoveryContext, jobId: string): CronRunLogEntry[] {
  const cached = context.runLogsByJobId.get(jobId);
  if (cached) {
    return cached;
  }
  let entries: CronRunLogEntry[] = [];
  try {
    const logPath = taskRegistryMaintenanceRuntime.resolveCronRunLogPath({
      storePath: context.storePath,
      jobId,
    });
    entries = taskRegistryMaintenanceRuntime.readCronRunLogEntriesSync(logPath, {
      jobId,
      limit: 5000,
    });
  } catch {
    entries = [];
  }
  context.runLogsByJobId.set(jobId, entries);
  return entries;
}

function getCronStore(context: CronRecoveryContext): CronStoreFile | null {
  if (context.store !== undefined) {
    return context.store;
  }
  try {
    context.store = taskRegistryMaintenanceRuntime.loadCronStoreSync(context.storePath);
  } catch {
    context.store = null;
  }
  return context.store;
}

function resolveCronRunLogRecovery(
  execution: CronExecutionId,
  context: CronRecoveryContext,
): CronTerminalRecovery | undefined {
  const entries = getCronRunLogEntries(context, execution.jobId);
  const entry = entries.findLast(
    (candidate) =>
      candidate.jobId === execution.jobId &&
      candidate.action === "finished" &&
      candidate.runAtMs === execution.startedAt &&
      (candidate.status === "ok" || candidate.status === "skipped" || candidate.status === "error"),
  );
  if (!entry) {
    return undefined;
  }
  const durationMs =
    typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
      ? Math.max(0, entry.durationMs)
      : undefined;
  const endedAt = durationMs === undefined ? entry.ts : execution.startedAt + durationMs;
  return {
    status: mapCronTerminalStatus(entry.status, entry.error),
    endedAt,
    lastEventAt: endedAt,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.summary !== undefined ? { terminalSummary: entry.summary } : {}),
  };
}

function resolveCronJobStateRecovery(
  execution: CronExecutionId,
  context: CronRecoveryContext,
): CronTerminalRecovery | undefined {
  const store = getCronStore(context);
  const job: CronJob | undefined = store?.jobs.find((entry) => entry.id === execution.jobId);
  if (!job || job.state.lastRunAtMs !== execution.startedAt) {
    return undefined;
  }
  const status = job.state.lastRunStatus ?? job.state.lastStatus;
  if (status !== "ok" && status !== "skipped" && status !== "error") {
    return undefined;
  }
  const durationMs =
    typeof job.state.lastDurationMs === "number" && Number.isFinite(job.state.lastDurationMs)
      ? Math.max(0, job.state.lastDurationMs)
      : 0;
  const endedAt = execution.startedAt + durationMs;
  return {
    status: mapCronTerminalStatus(status, job.state.lastError),
    endedAt,
    lastEventAt: endedAt,
    ...(job.state.lastError !== undefined ? { error: job.state.lastError } : {}),
  };
}

function resolveDurableCronTaskRecovery(
  task: TaskRecord,
  context: CronRecoveryContext,
): CronTerminalRecovery | undefined {
  if (task.runtime !== "cron" || !isActiveTask(task)) {
    return undefined;
  }
  const execution = parseCronExecutionId(task);
  if (!execution) {
    return undefined;
  }
  return (
    resolveCronRunLogRecovery(execution, context) ?? resolveCronJobStateRecovery(execution, context)
  );
}

function hasActiveCliRun(task: TaskRecord): boolean {
  const candidateRunIds = [task.sourceId, task.runId];
  for (const candidate of candidateRunIds) {
    const runId = candidate?.trim();
    if (runId && taskRegistryMaintenanceRuntime.getAgentRunContext(runId)) {
      return true;
    }
  }
  return false;
}

function hasBackingSession(task: TaskRecord): boolean {
  if (task.runtime === "cron") {
    if (!taskRegistryMaintenanceRuntime.isCronRuntimeAuthoritative()) {
      return true;
    }
    const jobId = task.sourceId?.trim();
    return jobId ? taskRegistryMaintenanceRuntime.isCronJobActive(jobId) : false;
  }

  if (task.runtime === "cli" && hasActiveCliRun(task)) {
    return true;
  }

  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return true;
  }
  if (task.runtime === "acp") {
    const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({
      sessionKey: childSessionKey,
    });
    if (!acpEntry || acpEntry.storeReadFailed) {
      return true;
    }
    return Boolean(acpEntry.entry);
  }
  if (task.runtime === "subagent" || task.runtime === "cli") {
    if (task.runtime === "cli") {
      const chatType = deriveSessionChatType(childSessionKey);
      if (chatType === "channel" || chatType === "group" || chatType === "direct") {
        return false;
      }
    }
    const agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
    const storePath = taskRegistryMaintenanceRuntime.resolveStorePath(undefined, { agentId });
    const store = taskRegistryMaintenanceRuntime.loadSessionStore(storePath);
    return Boolean(findSessionEntryByKey(store, childSessionKey));
  }

  return true;
}

function shouldMarkLost(task: TaskRecord, now: number): boolean {
  if (!isActiveTask(task)) {
    return false;
  }
  if (!hasLostGraceExpired(task, now)) {
    return false;
  }
  return !hasBackingSession(task);
}

function shouldPruneTerminalTask(task: TaskRecord, now: number): boolean {
  if (!isTerminalTask(task)) {
    return false;
  }
  if (typeof task.cleanupAfter === "number") {
    return now >= task.cleanupAfter;
  }
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return now - terminalAt >= TASK_RETENTION_MS;
}

function shouldStampCleanupAfter(task: TaskRecord): boolean {
  return isTerminalTask(task) && typeof task.cleanupAfter !== "number";
}

function resolveCleanupAfter(task: TaskRecord): number {
  const terminalAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return terminalAt + TASK_RETENTION_MS;
}

function markTaskLost(task: TaskRecord, now: number): TaskRecord {
  const cleanupAfter = task.cleanupAfter ?? projectTaskLost(task, now).cleanupAfter;
  const updated =
    taskRegistryMaintenanceRuntime.markTaskLostById({
      taskId: task.taskId,
      endedAt: task.endedAt ?? now,
      lastEventAt: now,
      error: task.error ?? "backing session missing",
      cleanupAfter,
    }) ?? task;
  void taskRegistryMaintenanceRuntime.maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

function markTaskRecovered(task: TaskRecord, recovery: CronTerminalRecovery): TaskRecord {
  const updated =
    taskRegistryMaintenanceRuntime.markTaskTerminalById({
      taskId: task.taskId,
      status: recovery.status,
      endedAt: recovery.endedAt,
      lastEventAt: recovery.lastEventAt,
      ...(recovery.error !== undefined ? { error: recovery.error } : {}),
      ...(recovery.terminalSummary !== undefined
        ? { terminalSummary: recovery.terminalSummary }
        : {}),
    }) ?? projectTaskRecovered(task, recovery);
  void taskRegistryMaintenanceRuntime.maybeDeliverTaskTerminalUpdate(updated.taskId);
  return updated;
}

function projectTaskRecovered(task: TaskRecord, recovery: CronTerminalRecovery): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: recovery.status,
    endedAt: recovery.endedAt,
    lastEventAt: recovery.lastEventAt,
    ...(recovery.error !== undefined ? { error: recovery.error } : {}),
    ...(recovery.terminalSummary !== undefined
      ? { terminalSummary: recovery.terminalSummary }
      : {}),
  };
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveCleanupAfter(projected) }),
  };
}

function projectTaskLost(task: TaskRecord, now: number): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: "lost",
    endedAt: task.endedAt ?? now,
    lastEventAt: now,
    error: task.error ?? "backing session missing",
  };
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveCleanupAfter(projected) }),
  };
}

export function reconcileTaskRecordForOperatorInspection(
  task: TaskRecord,
  context: CronRecoveryContext = createCronRecoveryContext(),
): TaskRecord {
  const cronRecovery = resolveDurableCronTaskRecovery(task, context);
  if (cronRecovery) {
    return projectTaskRecovered(task, cronRecovery);
  }
  const now = Date.now();
  if (!shouldMarkLost(task, now)) {
    return task;
  }
  return projectTaskLost(task, now);
}

export function reconcileInspectableTasks(): TaskRecord[] {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const cronRecoveryContext = createCronRecoveryContext();
  return taskRegistryMaintenanceRuntime
    .listTaskRecords()
    .map((task) => reconcileTaskRecordForOperatorInspection(task, cronRecoveryContext));
}

configureTaskAuditTaskProvider(reconcileInspectableTasks);

export function getInspectableTaskRegistrySummary(): TaskRegistrySummary {
  return summarizeTaskRecords(reconcileInspectableTasks());
}

export function getInspectableTaskAuditSummary(): TaskAuditSummary {
  const tasks = reconcileInspectableTasks();
  return summarizeTaskAuditFindings(listTaskAuditFindings({ tasks }));
}

export function reconcileTaskLookupToken(token: string): TaskRecord | undefined {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const task = taskRegistryMaintenanceRuntime.resolveTaskForLookupToken(token);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}

// Preview is synchronous and cannot call the async detached-task recovery hook,
// so hook-recovered tasks are counted under reconciled here. Durable cron
// recovery is synchronous and can be previewed exactly.
export function previewTaskRegistryMaintenance(): TaskRegistryMaintenanceSummary {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let recovered = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const cronRecoveryContext = createCronRecoveryContext();
  for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
    if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
      recovered += 1;
      continue;
    }
    if (shouldMarkLost(task, now)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneTerminalTask(task, now)) {
      pruned += 1;
      continue;
    }
    if (shouldStampCleanupAfter(task)) {
      cleanupStamped += 1;
    }
  }
  return { reconciled, recovered, cleanupStamped, pruned };
}

/**
 * Yield control back to the event loop so that pending I/O callbacks,
 * timers, and incoming requests can be processed between batches of
 * synchronous task-registry maintenance work.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function startScheduledSweep() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  const clearSweepInProgress = () => {
    sweepInProgress = false;
  };
  sweepTaskRegistry().then(clearSweepInProgress, clearSweepInProgress);
}

export async function runTaskRegistryMaintenance(): Promise<TaskRegistryMaintenanceSummary> {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let recovered = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const tasks = taskRegistryMaintenanceRuntime.listTaskRecords();
  const cronRecoveryContext = createCronRecoveryContext();
  let processed = 0;
  for (const task of tasks) {
    const current = taskRegistryMaintenanceRuntime.getTaskById(task.taskId);
    if (!current) {
      continue;
    }
    const cronRecovery = resolveDurableCronTaskRecovery(current, cronRecoveryContext);
    if (cronRecovery) {
      const next = markTaskRecovered(current, cronRecovery);
      if (next.status !== current.status) {
        recovered += 1;
      }
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (shouldMarkLost(current, now)) {
      const recovery = await tryRecoverTaskBeforeMarkLost({
        taskId: current.taskId,
        runtime: current.runtime,
        task: current,
        now,
      });
      const freshAfterHook = taskRegistryMaintenanceRuntime.getTaskById(current.taskId);
      if (!freshAfterHook || !shouldMarkLost(freshAfterHook, now)) {
        processed += 1;
        if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
          await yieldToEventLoop();
        }
        continue;
      }
      if (recovery.recovered) {
        recovered += 1;
        processed += 1;
        if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
          await yieldToEventLoop();
        }
        continue;
      }
      const next = markTaskLost(freshAfterHook, now);
      if (next.status === "lost") {
        reconciled += 1;
      }
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (
      shouldPruneTerminalTask(current, now) &&
      taskRegistryMaintenanceRuntime.deleteTaskRecordById(current.taskId)
    ) {
      pruned += 1;
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (
      shouldStampCleanupAfter(current) &&
      taskRegistryMaintenanceRuntime.setTaskCleanupAfterById({
        taskId: current.taskId,
        cleanupAfter: resolveCleanupAfter(current),
      })
    ) {
      cleanupStamped += 1;
    }
    processed += 1;
    if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
      await yieldToEventLoop();
    }
  }
  return { reconciled, recovered, cleanupStamped, pruned };
}

export async function sweepTaskRegistry(): Promise<TaskRegistryMaintenanceSummary> {
  return runTaskRegistryMaintenance();
}

export function startTaskRegistryMaintenance() {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  deferredSweep = setTimeout(() => {
    deferredSweep = null;
    startScheduledSweep();
  }, 5_000);
  deferredSweep.unref?.();
  if (sweeper) {
    return;
  }
  sweeper = setInterval(startScheduledSweep, TASK_SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export function stopTaskRegistryMaintenance() {
  if (deferredSweep) {
    clearTimeout(deferredSweep);
    deferredSweep = null;
  }
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  sweepInProgress = false;
}

export const stopTaskRegistryMaintenanceForTests = stopTaskRegistryMaintenance;

export function setTaskRegistryMaintenanceRuntimeForTests(
  runtime: TaskRegistryMaintenanceRuntime,
): void {
  taskRegistryMaintenanceRuntime = runtime;
}

export function resetTaskRegistryMaintenanceRuntimeForTests(): void {
  taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
  configuredCronStorePath = undefined;
  configuredCronRuntimeAuthoritative = false;
}

export function configureTaskRegistryMaintenance(options: {
  cronStorePath?: string;
  cronRuntimeAuthoritative?: boolean;
}): void {
  configuredCronStorePath = options.cronStorePath?.trim() || undefined;
  if (options.cronRuntimeAuthoritative !== undefined) {
    configuredCronRuntimeAuthoritative = options.cronRuntimeAuthoritative;
  }
}

export function getReconciledTaskById(taskId: string): TaskRecord | undefined {
  const task = getTaskById(taskId);
  return task ? reconcileTaskRecordForOperatorInspection(task) : undefined;
}
