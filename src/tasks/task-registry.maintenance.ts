// Reconciles stale or lost task registry records during maintenance passes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAcpTurnActive } from "../acp/control-plane/active-turns.js";
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
import { resolveStorePath } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  listSessionEntries,
  type SessionEntrySummary,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isPluginStateDatabaseOpen,
  sweepExpiredPluginStateEntries,
} from "../plugin-state/plugin-state-store.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "../sessions/session-chat-type-shared.js";
import { CODEX_NATIVE_SUBAGENT_STALE_ERROR } from "./codex-native-subagent-task.js";
import {
  collectCronHistoryOverflowTaskIds,
  shouldPruneTerminalTask,
} from "./cron-history-retention.js";
export { CRON_HISTORY_KEEP_PER_JOB } from "./cron-history-retention.js";
import {
  getDetachedTaskLifecycleRuntime,
  tryRecoverTaskBeforeMarkLost,
} from "./detached-task-runtime.js";
import {
  isChildlessNativeSubagentTask,
  resolveChildlessNativeSubagentTaskDefinition,
} from "./native-subagent-task.js";
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
import type { TaskAuditFinding, TaskAuditSummary } from "./task-registry.audit.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "./task-registry.store.sqlite.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary, TaskStatus } from "./task-registry.types.js";
import type { ActiveTaskRestartBlocker } from "./task-restart-blocker.js";
import { resolveEffectiveTaskCleanupAfter, resolveTaskCleanupAfter } from "./task-retention.js";

const log = createSubsystemLogger("tasks/task-registry-maintenance");
const TASK_RECONCILE_GRACE_MS = 5 * 60_000;
const CHILDLESS_NATIVE_SUBAGENT_RECONCILE_GRACE_MS = 30 * 60_000;
const TASK_STALE_RUNNING_MS = 30 * 60_000;
const TASK_SWEEP_INTERVAL_MS = 60_000;

/**
 * Number of tasks to process before yielding to the event loop.
 * Keeps the main thread responsive during large sweeps.
 */
const SWEEP_YIELD_BATCH_SIZE = 25;

let sweeper: NodeJS.Timeout | null = null;
let deferredSweep: NodeJS.Timeout | null = null;
let sweepInProgress = false;
let configuredRuntimeAuthoritative = false;

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
  listSessionEntries: typeof listSessionEntries;
  resolveStorePath: typeof resolveStorePath;
  deriveSessionChatTypeFromKey?: typeof deriveSessionChatTypeFromKey;
  isCronJobActive: typeof isCronJobActive;
  getAgentRunContext: typeof getAgentRunContext;
  hasActiveAcpTurn: (sessionKey: string) => boolean;
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
  isRuntimeAuthoritative: () => boolean;
  listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: typeof listTaskRegistryRecordsByRuntimeSourceIdFromSqlite;
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
  listSessionEntries,
  resolveStorePath,
  deriveSessionChatTypeFromKey,
  isCronJobActive,
  getAgentRunContext,
  hasActiveAcpTurn: isAcpTurnActive,
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
  isRuntimeAuthoritative: () => configuredRuntimeAuthoritative,
  listTaskRegistryRecordsByRuntimeSourceIdFromSqlite,
};

let taskRegistryMaintenanceRuntime: TaskRegistryMaintenanceRuntime =
  defaultTaskRegistryMaintenanceRuntime;

export type TaskRegistryMaintenanceSummary = {
  reconciled: number;
  recovered: number;
  cleanupStamped: number;
  pruned: number;
};

export type TaskRegistryMaintenanceTaskDiagnostic = {
  taskId: string;
  runtime: TaskRecord["runtime"];
  status: TaskRecord["status"];
  decision: "retained" | "would_reconcile";
  reason:
    | "acp_runtime_not_authoritative"
    | "active_cli_run"
    | "backing_session_missing"
    | "backing_session_present"
    | "cron_runtime_not_authoritative"
    | "lost_grace_pending"
    | "subagent_recovery_wedged";
  detail?: string;
  ageMs: number;
  childSessionKey?: string;
  runId?: string;
};

export type TaskRegistryMaintenanceDiagnostics = {
  staleRunningTasks: TaskRegistryMaintenanceTaskDiagnostic[];
};

type CronTerminalRecovery = {
  status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
  endedAt: number;
  lastEventAt: number;
  error?: string;
  terminalSummary?: string;
  detail?: TaskRecord["detail"];
};

type CronRecoveryContext = {
  taskRowsByJobId: Map<string, TaskRecord[]>;
};

type SessionEntryLookup = {
  entriesByKey: Map<string, SessionEntry>;
};

type BackingSessionLookupContext = {
  sessionEntriesByPath: Map<string, SessionEntryLookup>;
  sessionChatTypesByKey: Map<string, SessionKeyChatType>;
};

function createCronRecoveryContext(): CronRecoveryContext {
  return {
    taskRowsByJobId: new Map<string, TaskRecord[]>(),
  };
}

function createBackingSessionLookupContext(): BackingSessionLookupContext {
  return {
    sessionEntriesByPath: new Map<string, SessionEntryLookup>(),
    sessionChatTypesByKey: new Map<string, SessionKeyChatType>(),
  };
}

function buildSessionEntryLookup(entries: SessionEntrySummary[]): SessionEntryLookup {
  return {
    entriesByKey: new Map(entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
  };
}

function getSessionEntryLookup(
  storePath: string,
  context?: BackingSessionLookupContext,
): SessionEntryLookup {
  if (!context) {
    return buildSessionEntryLookup(
      taskRegistryMaintenanceRuntime.listSessionEntries({ storePath }),
    );
  }
  const cached = context.sessionEntriesByPath.get(storePath);
  if (cached) {
    return cached;
  }
  const lookup = buildSessionEntryLookup(
    taskRegistryMaintenanceRuntime.listSessionEntries({ storePath }),
  );
  context.sessionEntriesByPath.set(storePath, lookup);
  return lookup;
}

function findSessionEntryByKey(
  lookup: SessionEntryLookup,
  sessionKey: string,
): SessionEntry | undefined {
  return lookup.entriesByKey.get(sessionKey);
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
  return findSessionEntryByKey(getSessionEntryLookup(storePath, context), childSessionKey);
}

function isActiveTask(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isTerminalTask(task: TaskRecord): boolean {
  return !isActiveTask(task);
}

function hasLostGraceExpired(task: TaskRecord, now: number): boolean {
  const referenceAt = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  const graceMs = isChildlessNativeSubagentTask(task)
    ? CHILDLESS_NATIVE_SUBAGENT_RECONCILE_GRACE_MS
    : TASK_RECONCILE_GRACE_MS;
  return now - referenceAt >= graceMs;
}

function isRecoverableLostCronTask(task: TaskRecord): boolean {
  if (task.status !== "lost") {
    return false;
  }
  const error = task.error?.trim().toLowerCase();
  return Boolean(error?.includes("backing session missing"));
}

function isCronTerminalTaskStatus(status: TaskStatus): status is CronTerminalRecovery["status"] {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

function getCronTaskRows(context: CronRecoveryContext, jobId: string): TaskRecord[] {
  const cached = context.taskRowsByJobId.get(jobId);
  if (cached) {
    return cached;
  }
  let rows: TaskRecord[];
  try {
    rows = taskRegistryMaintenanceRuntime.listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
      runtime: "cron",
      sourceId: jobId,
    });
  } catch {
    rows = [];
  }
  context.taskRowsByJobId.set(jobId, rows);
  return rows;
}

function resolveDurableCronTaskRecovery(
  task: TaskRecord,
  context: CronRecoveryContext,
): CronTerminalRecovery | undefined {
  if (task.runtime !== "cron" || (!isActiveTask(task) && !isRecoverableLostCronTask(task))) {
    return undefined;
  }
  const jobId = task.sourceId?.trim();
  if (!jobId) {
    return undefined;
  }
  if (
    taskRegistryMaintenanceRuntime.isRuntimeAuthoritative() &&
    taskRegistryMaintenanceRuntime.isCronJobActive(jobId)
  ) {
    return undefined;
  }
  const row = getCronTaskRows(context, jobId).find(
    (candidate) =>
      candidate.taskId === task.taskId ||
      (Boolean(task.runId?.trim()) && candidate.runId === task.runId),
  );
  if (!row || !isCronTerminalTaskStatus(row.status)) {
    return undefined;
  }
  const endedAt = row.endedAt ?? row.lastEventAt ?? row.createdAt;
  return {
    status: row.status,
    endedAt,
    lastEventAt: row.lastEventAt ?? endedAt,
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.terminalSummary !== undefined ? { terminalSummary: row.terminalSummary } : {}),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
  };
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

function hasCliRunIdentity(task: TaskRecord): boolean {
  return [task.sourceId, task.runId].some((candidate) => Boolean(candidate?.trim()));
}

function hasBackingSession(task: TaskRecord, context?: BackingSessionLookupContext): boolean {
  if (task.runtime === "cron") {
    if (!taskRegistryMaintenanceRuntime.isRuntimeAuthoritative()) {
      return true;
    }
    const jobId = task.sourceId?.trim();
    return jobId ? taskRegistryMaintenanceRuntime.isCronJobActive(jobId) : false;
  }

  if (task.runtime === "cli" && hasActiveCliRun(task)) {
    return true;
  }
  if (task.runtime === "cli" && hasCliRunIdentity(task)) {
    return false;
  }

  const childSessionKey = task.childSessionKey?.trim();
  if (!childSessionKey) {
    return !isChildlessNativeSubagentTask(task);
  }
  if (task.runtime === "acp") {
    // The live-turn map is process-local; only the gateway owns it. A standalone CLI
    // maintenance run has an empty map, so stay conservative there and never reclaim.
    if (!taskRegistryMaintenanceRuntime.isRuntimeAuthoritative()) {
      return true;
    }
    // The persisted entry survives a crash, so only a live in-process turn proves the ACP run is alive.
    return taskRegistryMaintenanceRuntime.hasActiveAcpTurn(childSessionKey);
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
  const nativeDefinition = resolveChildlessNativeSubagentTaskDefinition(task);
  if (nativeDefinition) {
    return nativeDefinition.taskKind === "codex-native"
      ? CODEX_NATIVE_SUBAGENT_STALE_ERROR
      : "Native subagent stopped reporting progress";
  }
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

function shouldStampCleanupAfter(task: TaskRecord): boolean {
  return (
    isTerminalTask(task) &&
    typeof task.cleanupAfter !== "number" &&
    resolveTaskCleanupAfter(task) !== undefined
  );
}

function resolveCleanupAfter(task: TaskRecord): number | undefined {
  return resolveTaskCleanupAfter(task);
}

function taskReferenceAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
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
  const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({
    sessionKey,
    clone: false,
  });
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
  const acpEntry = taskRegistryMaintenanceRuntime.readAcpSessionEntry({
    sessionKey,
    clone: false,
  });
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
    acpSessions = await taskRegistryMaintenanceRuntime.listAcpSessionEntries({ clone: false });
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
  const lostAt = task.endedAt ?? now;
  const cleanupAfter = resolveEffectiveTaskCleanupAfter({
    ...task,
    status: "lost",
    endedAt: lostAt,
  })!;
  const updated =
    taskRegistryMaintenanceRuntime.markTaskLostById({
      taskId: task.taskId,
      endedAt: lostAt,
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
      error: recovery.error,
      ...(recovery.terminalSummary !== undefined
        ? { terminalSummary: recovery.terminalSummary, preserveTerminalSummary: true }
        : {}),
      ...(recovery.detail !== undefined ? { detail: recovery.detail } : {}),
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
    error: recovery.error,
    ...(recovery.terminalSummary !== undefined
      ? { terminalSummary: recovery.terminalSummary }
      : {}),
    ...(recovery.detail !== undefined ? { detail: recovery.detail } : {}),
  };
  if (recovery.error === undefined) {
    delete projected.error;
  }
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

function reconcileTaskRecordForOperatorInspection(
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

function isActiveTaskRestartBlockerStatus(
  status: TaskStatus,
): status is ActiveTaskRestartBlocker["status"] {
  return status === "running";
}

function isTaskRestartBlocker(task: TaskRecord): task is TaskRecord & {
  status: ActiveTaskRestartBlocker["status"];
} {
  // A task that is merely queued has not started user work yet; durable queued
  // work can survive a gateway restart and should not indefinitely block one.
  // Likewise, stale records that still say "running" but already have endedAt
  // are registry inconsistencies, not live restart blockers.
  return isActiveTaskRestartBlockerStatus(task.status) && !task.endedAt;
}

export function getInspectableActiveTaskRestartBlockers(): ActiveTaskRestartBlocker[] {
  const blockers: ActiveTaskRestartBlocker[] = [];
  for (const task of reconcileInspectableTasks()) {
    if (!isTaskRestartBlocker(task)) {
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

export function getInspectableTaskRegistrySummary(
  tasks: TaskRecord[] = reconcileInspectableTasks(),
): TaskRegistrySummary {
  return summarizeTaskRecords(tasks);
}

export function getInspectableTaskAuditSummary(): TaskAuditSummary {
  return summarizeTaskAuditFindings(getInspectableTaskAuditFindings());
}

export function getInspectableTaskAuditFindings(
  tasks: TaskRecord[] = reconcileInspectableTasks(),
): TaskAuditFinding[] {
  return listTaskAuditFindings({ tasks });
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
  const tasks = taskRegistryMaintenanceRuntime.listTaskRecords();
  const cronHistoryOverflowTaskIds = collectCronHistoryOverflowTaskIds(tasks);
  for (const task of tasks) {
    if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
      recovered += 1;
      continue;
    }
    if (shouldMarkLost(task, now, backingSessionContext)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneTerminalTask(task, now, cronHistoryOverflowTaskIds)) {
      pruned += 1;
      continue;
    }
    if (shouldStampCleanupAfter(task)) {
      cleanupStamped += 1;
    }
  }
  return { reconciled, recovered, cleanupStamped, pruned };
}

function explainActiveTaskRetention(params: {
  task: TaskRecord;
  now: number;
  context: BackingSessionLookupContext;
}): Pick<TaskRegistryMaintenanceTaskDiagnostic, "decision" | "reason" | "detail"> {
  if (!hasLostGraceExpired(params.task, params.now)) {
    return { decision: "retained", reason: "lost_grace_pending" };
  }
  if (params.task.runtime === "subagent") {
    const entry = findTaskSessionEntry(params.task, params.context);
    if (entry && isSubagentRecoveryWedgedEntry(entry)) {
      return {
        decision: "would_reconcile",
        reason: "subagent_recovery_wedged",
        detail: formatSubagentRecoveryWedgedReason(entry),
      };
    }
  }
  if (!hasBackingSession(params.task, params.context)) {
    return { decision: "would_reconcile", reason: "backing_session_missing" };
  }
  if (params.task.runtime === "cron" && !taskRegistryMaintenanceRuntime.isRuntimeAuthoritative()) {
    return { decision: "retained", reason: "cron_runtime_not_authoritative" };
  }
  if (params.task.runtime === "acp" && !taskRegistryMaintenanceRuntime.isRuntimeAuthoritative()) {
    return { decision: "retained", reason: "acp_runtime_not_authoritative" };
  }
  if (params.task.runtime === "cli" && hasActiveCliRun(params.task)) {
    return { decision: "retained", reason: "active_cli_run" };
  }
  return { decision: "retained", reason: "backing_session_present" };
}

export function getTaskRegistryMaintenanceDiagnostics(): TaskRegistryMaintenanceDiagnostics {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  const cronRecoveryContext = createCronRecoveryContext();
  const backingSessionContext = createBackingSessionLookupContext();
  const staleRunningTasks: TaskRegistryMaintenanceTaskDiagnostic[] = [];
  for (const task of taskRegistryMaintenanceRuntime.listTaskRecords()) {
    if (task.status !== "running") {
      continue;
    }
    const ageMs = Math.max(0, now - taskReferenceAt(task));
    if (ageMs < TASK_STALE_RUNNING_MS) {
      continue;
    }
    if (resolveDurableCronTaskRecovery(task, cronRecoveryContext)) {
      continue;
    }
    const decision = explainActiveTaskRetention({ task, now, context: backingSessionContext });
    staleRunningTasks.push({
      taskId: task.taskId,
      runtime: task.runtime,
      status: task.status,
      decision: decision.decision,
      reason: decision.reason,
      ageMs,
      ...(decision.detail ? { detail: decision.detail } : {}),
      ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
      ...(task.runId ? { runId: task.runId } : {}),
    });
  }
  return { staleRunningTasks };
}

/**
 * Yield control back to the event loop so that pending I/O callbacks,
 * timers, and incoming requests can be processed between batches of
 * synchronous task-registry maintenance work.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function startScheduledSweep() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  const clearSweepInProgress = () => {
    sweepInProgress = false;
  };
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    await sweepTaskRegistry();
  }).then(clearSweepInProgress, clearSweepInProgress);
}

export async function runTaskRegistryMaintenance(): Promise<TaskRegistryMaintenanceSummary> {
  taskRegistryMaintenanceRuntime.ensureTaskRegistryReady();
  const now = Date.now();
  let reconciled = 0;
  let recovered = 0;
  let cleanupStamped = 0;
  let pruned = 0;
  const tasks = taskRegistryMaintenanceRuntime.listTaskRecords();
  const cronHistoryOverflowTaskIds = collectCronHistoryOverflowTaskIds(tasks);
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
      shouldPruneTerminalTask(current, now, cronHistoryOverflowTaskIds) &&
      taskRegistryMaintenanceRuntime.deleteTaskRecordById(current.taskId)
    ) {
      pruned += 1;
      processed += 1;
      if (processed % SWEEP_YIELD_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
      continue;
    }
    if (shouldStampCleanupAfter(current)) {
      const cleanupAfter = resolveCleanupAfter(current);
      if (
        cleanupAfter !== undefined &&
        taskRegistryMaintenanceRuntime.setTaskCleanupAfterById({
          taskId: current.taskId,
          cleanupAfter,
        })
      ) {
        cleanupStamped += 1;
      }
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

export function setTaskRegistryMaintenanceRuntimeForTests(
  runtime: TaskRegistryMaintenanceRuntime,
): void {
  taskRegistryMaintenanceRuntime = runtime;
}

export function resetTaskRegistryMaintenanceRuntimeForTests(): void {
  taskRegistryMaintenanceRuntime = defaultTaskRegistryMaintenanceRuntime;
  configuredRuntimeAuthoritative = false;
}

export function configureTaskRegistryMaintenance(options?: {
  runtimeAuthoritative?: boolean;
}): void {
  if (options?.runtimeAuthoritative !== undefined) {
    configuredRuntimeAuthoritative = options.runtimeAuthoritative;
  }
}
