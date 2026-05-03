import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  type AcpSessionStoreEntry,
} from "../acp/runtime/session-meta.js";
import {
  formatSubagentRecoveryWedgedReason,
  isSubagentRecoveryWedgedEntry,
} from "../agents/subagent-recovery-state.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { readCronRunLogEntriesSync, resolveCronRunLogPath } from "../cron/run-log.js";
import type { CronRunLogEntry } from "../cron/run-log.js";
import { loadCronStoreSync, resolveCronStorePath } from "../cron/store.js";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isPluginStateDatabaseOpen,
  sweepExpiredPluginStateEntries,
} from "../plugin-state/plugin-state-store.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "../sessions/session-chat-type-shared.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  getDetachedTaskLifecycleRuntime,
  tryRecoverTaskBeforeMarkLost,
} from "./detached-task-runtime.js";
import {
  deleteTaskRecordById,
  ensureTaskRegistryReady,
  getTaskById,
  hasActiveTaskForChildSessionKey,
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

const log = createSubsystemLogger("tasks/task-registry-maintenance");
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
  listAcpSessionEntries: typeof listAcpSessionEntries;
  readAcpSessionEntry: typeof readAcpSessionEntry;
  closeAcpSession?: (params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason: string;
  }) => Promise<void>;
  listSessionBindingsBySession?: ReturnType<typeof getSessionBindingService>["listBySession"];
  unbindSessionBindings?: ReturnType<typeof getSessionBindingService>["unbind"];
  loadSessionStore: typeof loadSessionStore;
  resolveStorePath: typeof resolveStorePath;
  deriveSessionChatTypeFromKey?: typeof deriveSessionChatTypeFromKey;
  isCronJobActive: typeof isCronJobActive;
  getAgentRunContext: typeof getAgentRunContext;
  parseAgentSessionKey: typeof parseAgentSessionKey;
  hasActiveTaskForChildSessionKey: typeof hasActiveTaskForChildSessionKey;
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
  listAcpSessionEntries,
  readAcpSessionEntry,
  closeAcpSession: async ({ cfg, sessionKey, reason }) => {
    await getAcpSessionManager().closeSession({
      cfg,
      sessionKey,
      reason,
      discardPersistentState: true,
      clearMeta: true,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });
  },
  listSessionBindingsBySession: (sessionKey) =>
    getSessionBindingService().listBySession(sessionKey),
  unbindSessionBindings: (input) => getSessionBindingService().unbind(input),
  loadSessionStore,
  resolveStorePath,
  deriveSessionChatTypeFromKey,
  isCronJobActive,
  getAgentRunContext,
  parseAgentSessionKey,
  hasActiveTaskForChildSessionKey,
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

type SessionStoreLookup = {
  store: Record<string, SessionEntry>;
  normalizedEntries?: Map<string, SessionEntry>;
};

type BackingSessionLookupContext = {
  sessionStoresByPath: Map<string, SessionStoreLookup>;
  sessionChatTypesByKey: Map<string, SessionKeyChatType>;
};

function createCronRecoveryContext(): CronRecoveryContext {
  return {
    storePath: taskRegistryMaintenanceRuntime.resolveCronStorePath(),
    runLogsByJobId: new Map<string, CronRunLogEntry[]>(),
  };
}

function createBackingSessionLookupContext(): BackingSessionLookupContext {
  return {
    sessionStoresByPath: new Map<string, SessionStoreLookup>(),
    sessionChatTypesByKey: new Map<string, SessionKeyChatType>(),
  };
}

function getSessionStoreLookup(
  storePath: string,
  context?: BackingSessionLookupContext,
): SessionStoreLookup {
  if (!context) {
    return {
      store: taskRegistryMaintenanceRuntime.loadSessionStore(storePath, { clone: false }),
    };
  }
  const cached = context.sessionStoresByPath.get(storePath);
  if (cached) {
    return cached;
  }
  const lookup = {
    store: taskRegistryMaintenanceRuntime.loadSessionStore(storePath, { clone: false }),
  };
  context.sessionStoresByPath.set(storePath, lookup);
  return lookup;
}

function getNormalizedSessionEntries(lookup: SessionStoreLookup): Map<string, SessionEntry> {
  if (lookup.normalizedEntries) {
    return lookup.normalizedEntries;
  }
  const entries = new Map<string, SessionEntry>();
  for (const [key, entry] of Object.entries(lookup.store)) {
    if (entry) {
      entries.set(normalizeLowercaseStringOrEmpty(key), entry);
    }
  }
  lookup.normalizedEntries = entries;
  return entries;
}

function findSessionEntryByKey(
  lookup: SessionStoreLookup,
  sessionKey: string,
): SessionEntry | undefined {
  const direct = lookup.store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalized) {
    return undefined;
  }
  return getNormalizedSessionEntries(lookup).get(normalized);
}

function resolveSessionChatType(
  sessionKey: string,
  context?: BackingSessionLookupContext,
): SessionKeyChatType {
  const derive =
    taskRegistryMaintenanceRuntime.deriveSessionChatTypeFromKey ?? deriveSessionChatTypeFromKey;
  if (!context) {
    return derive(sessionKey);
  }
  const cached = context.sessionChatTypesByKey.get(sessionKey);
  if (cached) {
    return cached;
  }
  const chatType = derive(sessionKey);
  context.sessionChatTypesByKey.set(sessionKey, chatType);
  return chatType;
}

function findTaskSessionEntry(
  task: TaskRecord,
  context?: BackingSessionLookupContext,
): SessionEntry | undefined {
  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return undefined;
  }
  const agentId = taskRegistryMaintenanceRuntime.parseAgentSessionKey(childSessionKey)?.agentId;
  const storePath = taskRegistryMaintenanceRuntime.resolveStorePath(undefined, { agentId });
  return findSessionEntryByKey(getSessionStoreLookup(storePath, context), childSessionKey);
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

function hasBackingSession(task: TaskRecord, context?: BackingSessionLookupContext): boolean {
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
      const chatType = resolveSessionChatType(childSessionKey, context);
      if (chatType === "channel" || chatType === "group" || chatType === "direct") {
        return false;
      }
    }
    const entry = findTaskSessionEntry(task, context);
    if (task.runtime === "subagent" && isSubagentRecoveryWedgedEntry(entry)) {
      return false;
    }
    return Boolean(entry);
  }

  return true;
}

function resolveTaskLostError(task: TaskRecord, context?: BackingSessionLookupContext): string {
  if (task.runtime === "subagent") {
    const entry = findTaskSessionEntry(task, context);
    if (entry && isSubagentRecoveryWedgedEntry(entry)) {
      return formatSubagentRecoveryWedgedReason(entry);
    }
  }
  return "backing session missing";
}

function shouldMarkLost(
  task: TaskRecord,
  now: number,
  context?: BackingSessionLookupContext,
): boolean {
  if (!isActiveTask(task)) {
    return false;
  }
  if (!hasLostGraceExpired(task, now)) {
    return false;
  }
  return !hasBackingSession(task, context);
}

function hasTaskLostDecisionInputChanged(before: TaskRecord, after: TaskRecord): boolean {
  return (
    before.status !== after.status ||
    before.runtime !== after.runtime ||
    before.childSessionKey !== after.childSessionKey ||
    before.sourceId !== after.sourceId ||
    before.runId !== after.runId ||
    before.createdAt !== after.createdAt ||
    before.startedAt !== after.startedAt ||
    before.lastEventAt !== after.lastEventAt
  );
}

function hasDetachedTaskRecoveryHook(): boolean {
  return Boolean(getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost);
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

function getNormalizedTaskChildSessionKey(task: TaskRecord): string | undefined {
  return normalizeOptionalString(task.childSessionKey);
}

function getAcpSessionParentKeys(acpEntry: Pick<AcpSessionStoreEntry, "entry">): string[] {
  return [
    normalizeOptionalString(acpEntry.entry?.spawnedBy),
    normalizeOptionalString(acpEntry.entry?.parentSessionKey),
  ].filter((value): value is string => Boolean(value));
}

function isParentOwnedAcpSessionTask(
  task: TaskRecord,
  acpEntry: ReturnType<typeof readAcpSessionEntry>,
): boolean {
  const entry = acpEntry?.entry;
  if (!entry) {
    return false;
  }
  const ownerKey = normalizeOptionalString(task.ownerKey);
  const requesterKey = normalizeOptionalString(task.requesterSessionKey);
  const parentKeys = getAcpSessionParentKeys({ entry });
  return parentKeys.some((parentKey) => parentKey === ownerKey || parentKey === requesterKey);
}

function isParentOwnedAcpSessionEntry(acpEntry: Pick<AcpSessionStoreEntry, "entry">): boolean {
  return getAcpSessionParentKeys(acpEntry).length > 0;
}

function hasActiveSessionBinding(sessionKey: string): boolean {
  const listBindings = taskRegistryMaintenanceRuntime.listSessionBindingsBySession;
  if (!listBindings) {
    return true;
  }
  try {
    return listBindings(sessionKey).some((binding) => binding.status !== "ended");
  } catch {
    return true;
  }
}

function shouldCloseTerminalAcpSession(task: TaskRecord): boolean {
  if (task.runtime !== "acp" || isActiveTask(task)) {
    return false;
  }
  const sessionKey = getNormalizedTaskChildSessionKey(task);
  if (
    !sessionKey ||
    taskRegistryMaintenanceRuntime.hasActiveTaskForChildSessionKey({
      sessionKey,
      excludeTaskId: task.taskId,
    })
  ) {
    return false;
  }
  const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({ sessionKey });
  if (!acpEntry || acpEntry.storeReadFailed || !acpEntry.acp) {
    return false;
  }
  if (!isParentOwnedAcpSessionTask(task, acpEntry)) {
    return false;
  }
  if (acpEntry.acp.mode === "oneshot") {
    return true;
  }
  return !hasActiveSessionBinding(sessionKey);
}

function shouldCloseOrphanedParentOwnedAcpSession(acpEntry: AcpSessionStoreEntry): boolean {
  if (!acpEntry.entry || !acpEntry.acp || !isParentOwnedAcpSessionEntry(acpEntry)) {
    return false;
  }
  const sessionKey = normalizeOptionalString(acpEntry.sessionKey);
  if (
    !sessionKey ||
    taskRegistryMaintenanceRuntime.hasActiveTaskForChildSessionKey({ sessionKey })
  ) {
    return false;
  }
  if (acpEntry.acp.mode === "oneshot") {
    return true;
  }
  return !hasActiveSessionBinding(sessionKey);
}

async function cleanupTerminalAcpSession(task: TaskRecord): Promise<void> {
  if (!shouldCloseTerminalAcpSession(task)) {
    return;
  }
  const sessionKey = getNormalizedTaskChildSessionKey(task);
  if (!sessionKey) {
    return;
  }
  const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({ sessionKey });
  const closeAcpSession = taskRegistryMaintenanceRuntime.closeAcpSession;
  if (!acpEntry || !closeAcpSession) {
    return;
  }
  try {
    await closeAcpSession({
      cfg: acpEntry.cfg,
      sessionKey,
      reason: "terminal-task-cleanup",
    });
  } catch (error) {
    log.warn("Failed to close terminal ACP session during task maintenance", {
      sessionKey,
      taskId: task.taskId,
      error,
    });
    return;
  }
  try {
    await taskRegistryMaintenanceRuntime.unbindSessionBindings?.({
      targetSessionKey: sessionKey,
      reason: "terminal-task-cleanup",
    });
  } catch (error) {
    log.warn("Failed to unbind terminal ACP session during task maintenance", {
      sessionKey,
      taskId: task.taskId,
      error,
    });
  }
}

async function cleanupOrphanedParentOwnedAcpSessions(): Promise<void> {
  let acpSessions: AcpSessionStoreEntry[];
  try {
    acpSessions = await taskRegistryMaintenanceRuntime.listAcpSessionEntries({});
  } catch (error) {
    log.warn("Failed to list ACP sessions during task maintenance", { error });
    return;
  }
  const seenSessionKeys = new Set<string>();
  for (const acpEntry of acpSessions) {
    const sessionKey = normalizeOptionalString(acpEntry.sessionKey);
    if (!sessionKey || seenSessionKeys.has(sessionKey)) {
      continue;
    }
    seenSessionKeys.add(sessionKey);
    if (!shouldCloseOrphanedParentOwnedAcpSession(acpEntry)) {
      continue;
    }
    const closeAcpSession = taskRegistryMaintenanceRuntime.closeAcpSession;
    if (!closeAcpSession) {
      continue;
    }
    try {
      await closeAcpSession({
        cfg: acpEntry.cfg,
        sessionKey,
        reason: "orphaned-parent-task-cleanup",
      });
    } catch (error) {
      log.warn("Failed to close orphaned parent-owned ACP session during task maintenance", {
        sessionKey,
        error,
      });
      continue;
    }
    try {
      await taskRegistryMaintenanceRuntime.unbindSessionBindings?.({
        targetSessionKey: sessionKey,
        reason: "orphaned-parent-task-cleanup",
      });
    } catch (error) {
      log.warn("Failed to unbind orphaned parent-owned ACP session during task maintenance", {
        sessionKey,
        error,
      });
    }
  }
}

function markTaskLost(
  task: TaskRecord,
  now: number,
  context?: BackingSessionLookupContext,
): TaskRecord {
  const cleanupAfter =
    task.cleanupAfter ?? resolveCleanupAfter({ ...task, endedAt: task.endedAt ?? now });
  const updated =
    taskRegistryMaintenanceRuntime.markTaskLostById({
      taskId: task.taskId,
      endedAt: task.endedAt ?? now,
      lastEventAt: now,
      error: task.error ?? resolveTaskLostError(task, context),
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

function projectTaskLost(
  task: TaskRecord,
  now: number,
  context?: BackingSessionLookupContext,
): TaskRecord {
  const projected: TaskRecord = {
    ...task,
    status: "lost",
    endedAt: task.endedAt ?? now,
    lastEventAt: now,
    error: task.error ?? resolveTaskLostError(task, context),
  };
  return {
    ...projected,
    ...(typeof projected.cleanupAfter === "number"
      ? {}
      : { cleanupAfter: resolveCleanupAfter(projected) }),
  };
}

function reconcileTaskRecordForOperatorInspectionWithContexts(
  task: TaskRecord,
  context: CronRecoveryContext,
  backingSessionContext: BackingSessionLookupContext,
): TaskRecord {
  const cronRecovery = resolveDurableCronTaskRecovery(task, context);
  if (cronRecovery) {
    return projectTaskRecovered(task, cronRecovery);
  }
  const now = Date.now();
  if (!shouldMarkLost(task, now, backingSessionContext)) {
    return task;
  }
  return projectTaskLost(task, now, backingSessionContext);
}

export function reconcileTaskRecordForOperatorInspection(
  task: TaskRecord,
  context: CronRecoveryContext = createCronRecoveryContext(),
): TaskRecord {
  return reconcileTaskRecordForOperatorInspectionWithContexts(
    task,
    context,
    createBackingSessionLookupContext(),
  );
}

export function reconcileInspectableTasks(): TaskRecord[] {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const cronRecoveryContext = createCronRecoveryContext();
  const backingSessionContext = createBackingSessionLookupContext();
  return taskRegistryMaintenanceRuntime
    .listTaskRecords()
    .map((task) =>
      reconcileTaskRecordForOperatorInspectionWithContexts(
        task,
        cronRecoveryContext,
        backingSessionContext,
      ),
    );
}

configureTaskAuditTaskProvider(reconcileInspectableTasks);

export type ActiveTaskRestartBlocker = {
  taskId: string;
  status: Extract<TaskStatus, "queued" | "running">;
  runtime: TaskRecord["runtime"];
  runId?: string;
  label?: string;
  title?: string;
};

function isActiveTaskRestartBlockerStatus(
  status: TaskStatus,
): status is ActiveTaskRestartBlocker["status"] {
  return status === "queued" || status === "running";
}

export function getInspectableActiveTaskRestartBlockers(): ActiveTaskRestartBlocker[] {
  const blockers: ActiveTaskRestartBlocker[] = [];
  for (const task of reconcileInspectableTasks()) {
    if (!isActiveTaskRestartBlockerStatus(task.status)) {
      continue;
    }
    const blocker: ActiveTaskRestartBlocker = {
      taskId: task.taskId,
      status: task.status,
      runtime: task.runtime,
    };
    if (task.runId) {
      blocker.runId = task.runId;
    }
    if (task.label) {
      blocker.label = task.label;
    }
    if (task.task) {
      blocker.title = task.task;
    }
    blockers.push(blocker);
  }
  return blockers;
}

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
  const backingSessionContext = createBackingSessionLookupContext();
  for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
    if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
      recovered += 1;
      continue;
    }
    if (shouldMarkLost(task, now, backingSessionContext)) {
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
  const backingSessionContext = createBackingSessionLookupContext();
  const recoveryHookRegistered = hasDetachedTaskRecoveryHook();
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
    if (shouldMarkLost(current, now, backingSessionContext)) {
      const recovery = await tryRecoverTaskBeforeMarkLost({
        taskId: current.taskId,
        runtime: current.runtime,
        task: current,
        now,
      });
      const freshAfterHook = taskRegistryMaintenanceRuntime.getTaskById(current.taskId);
      if (!freshAfterHook) {
        processed += 1;
        if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
          await yieldToEventLoop();
        }
        continue;
      }
      const shouldRecheckFreshTask =
        recoveryHookRegistered || hasTaskLostDecisionInputChanged(current, freshAfterHook);
      let lostContext = backingSessionContext;
      if (shouldRecheckFreshTask) {
        lostContext = createBackingSessionLookupContext();
        if (!shouldMarkLost(freshAfterHook, now, lostContext)) {
          processed += 1;
          if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
            await yieldToEventLoop();
          }
          continue;
        }
      }
      if (recovery.recovered) {
        recovered += 1;
        processed += 1;
        if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
          await yieldToEventLoop();
        }
        continue;
      }
      const next = markTaskLost(freshAfterHook, now, lostContext);
      if (next.status === "lost") {
        reconciled += 1;
      }
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    await cleanupTerminalAcpSession(current);
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
  await cleanupOrphanedParentOwnedAcpSessions();
  if (isPluginStateDatabaseOpen()) {
    try {
      sweepExpiredPluginStateEntries();
    } catch (error) {
      log.warn("Failed to sweep expired plugin state entries", { error });
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
