import { resolveNonNegativeIntegerOption } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listFreshTasksForOwnerKey } from "../tasks/runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { buildSessionAsyncTaskStatusDetails } from "./session-async-task-status.js";
import { stableStringify } from "./stable-stringify.js";

type RecentMediaGenerationTaskStart = {
  task: TaskRecord;
  requestKey?: string;
};

const recentMediaGenerationTaskStarts = new Map<string, RecentMediaGenerationTaskStart[]>();
const RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS = 2 * 60_000;

export function buildMediaGenerationRequestKey(value: Record<string, unknown>): string {
  return stableStringify(value);
}

function buildRecentMediaGenerationTaskKey(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
}): string | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const taskKind = normalizeOptionalString(params.taskKind);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  if (!sessionKey || !taskKind || !sourcePrefix) {
    return undefined;
  }
  return `${sessionKey}\0${taskKind}\0${sourcePrefix}`;
}

function isRecentMediaGenerationTaskRecord(params: {
  task: TaskRecord;
  maxAgeMs: number;
  nowMs: number;
}) {
  const activityAt =
    params.task.endedAt ??
    params.task.lastEventAt ??
    params.task.startedAt ??
    params.task.createdAt;
  return Number.isFinite(activityAt) && params.nowMs - activityAt <= params.maxAgeMs;
}

function pruneRecentMediaGenerationTaskStarts(params: {
  maxAgeMs: number;
  nowMs: number;
  preserveKey?: string;
}) {
  for (const [key, entries] of recentMediaGenerationTaskStarts.entries()) {
    if (params.preserveKey === key) {
      continue;
    }
    const freshEntries = entries.filter((entry) =>
      isRecentMediaGenerationTaskRecord({ task: entry.task, ...params }),
    );
    if (freshEntries.length > 0) {
      recentMediaGenerationTaskStarts.set(key, freshEntries);
    } else {
      recentMediaGenerationTaskStarts.delete(key);
    }
  }
}

function mediaGenerationSourceMatches(task: TaskRecord, sourcePrefix: string): boolean {
  const sourceId = task.sourceId?.trim() ?? "";
  return sourceId === sourcePrefix || sourceId.startsWith(`${sourcePrefix}:`);
}

function mediaGenerationTaskLabelMatches(task: TaskRecord, taskLabel: string): boolean {
  return normalizeOptionalString(task.task) === taskLabel;
}

function isTaskStillBlockingDuplicateGuard(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isTaskRecentSuccessfulDuplicate(params: {
  task: TaskRecord;
  requestKey?: string;
  cachedRequestKey?: string;
  maxAgeMs: number;
  nowMs: number;
}): boolean {
  return (
    params.task.status === "succeeded" &&
    params.task.terminalOutcome !== "blocked" &&
    Boolean(params.requestKey && params.cachedRequestKey === params.requestKey) &&
    isRecentMediaGenerationTaskRecord({
      task: params.task,
      maxAgeMs: params.maxAgeMs,
      nowMs: params.nowMs,
    })
  );
}

function recentMediaGenerationTaskStartMatches(
  left: RecentMediaGenerationTaskStart,
  right: RecentMediaGenerationTaskStart,
): boolean {
  if (left.requestKey && right.requestKey) {
    return left.requestKey === right.requestKey;
  }
  if (left.task.runId && right.task.runId) {
    return left.task.runId === right.task.runId;
  }
  return left.task.taskId === right.task.taskId;
}

function findPersistedTaskForRecentMediaGenerationStart(params: {
  sessionKey: string;
  cachedTask: TaskRecord;
  taskKind: string;
  sourcePrefix: string;
}): TaskRecord | undefined {
  return listFreshTasksForOwnerKey(params.sessionKey).find((task) => {
    if (
      task.runtime !== "cli" ||
      task.scopeKind !== "session" ||
      task.taskKind !== params.taskKind ||
      !mediaGenerationSourceMatches(task, params.sourcePrefix)
    ) {
      return false;
    }
    if (task.taskId === params.cachedTask.taskId) {
      return true;
    }
    return Boolean(task.runId && task.runId === params.cachedTask.runId);
  });
}

export function isActiveMediaGenerationTask(params: {
  task: TaskRecord;
  taskKind: string;
}): boolean {
  return (
    params.task.runtime === "cli" &&
    params.task.scopeKind === "session" &&
    params.task.taskKind === params.taskKind &&
    (params.task.status === "queued" || params.task.status === "running")
  );
}

export function recordRecentMediaGenerationTaskStartForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskId: string;
  runId?: string;
  taskLabel: string;
  requestKey?: string;
  providerId?: string;
  progressSummary: string;
  nowMs?: number;
}) {
  const key = buildRecentMediaGenerationTaskKey(params);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!key || !sessionKey) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneRecentMediaGenerationTaskStarts({
    maxAgeMs: RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS,
    nowMs,
    preserveKey: key,
  });
  const entry: RecentMediaGenerationTaskStart = {
    requestKey: normalizeOptionalString(params.requestKey),
    task: {
      taskId: params.taskId,
      runtime: "cli",
      taskKind: params.taskKind,
      sourceId: params.providerId?.trim()
        ? `${params.sourcePrefix}:${params.providerId.trim()}`
        : params.sourcePrefix,
      requesterSessionKey: sessionKey,
      ownerKey: sessionKey,
      scopeKind: "session",
      ...(params.runId ? { runId: params.runId } : {}),
      task: params.taskLabel,
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: nowMs,
      startedAt: nowMs,
      lastEventAt: nowMs,
      progressSummary: params.progressSummary,
    },
  };
  const previousEntries = (recentMediaGenerationTaskStarts.get(key) ?? []).filter((entryLocal) =>
    isRecentMediaGenerationTaskRecord({
      task: entryLocal.task,
      maxAgeMs: RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS,
      nowMs,
    }),
  );
  recentMediaGenerationTaskStarts.set(key, [
    ...previousEntries.filter(
      (previousEntry) => !recentMediaGenerationTaskStartMatches(previousEntry, entry),
    ),
    entry,
  ]);
}

export function findRecentStartedMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  maxAgeMs: number;
  requestKey?: string;
  nowMs?: number;
}): TaskRecord | undefined {
  const key = buildRecentMediaGenerationTaskKey(params);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!key || !sessionKey) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  const maxAgeMs = resolveNonNegativeIntegerOption(params.maxAgeMs, 0);
  const taskLabel = normalizeOptionalString(params.taskLabel);
  pruneRecentMediaGenerationTaskStarts({ maxAgeMs, nowMs, preserveKey: key });
  const entries = recentMediaGenerationTaskStarts.get(key);
  if (!entries?.length) {
    return undefined;
  }
  const retainedEntries: RecentMediaGenerationTaskStart[] = [];
  for (const entry of entries.toReversed()) {
    const task = entry.task;
    const persistedTask = findPersistedTaskForRecentMediaGenerationStart({
      sessionKey,
      cachedTask: task,
      taskKind: params.taskKind,
      sourcePrefix: params.sourcePrefix,
    });
    if (persistedTask) {
      const persistedTaskLabelMatches =
        !taskLabel || mediaGenerationTaskLabelMatches(persistedTask, taskLabel);
      if (isTaskStillBlockingDuplicateGuard(persistedTask) && persistedTaskLabelMatches) {
        return persistedTask;
      }
      if (
        isTaskRecentSuccessfulDuplicate({
          task: persistedTask,
          requestKey: params.requestKey,
          cachedRequestKey: entry.requestKey,
          maxAgeMs,
          nowMs,
        })
      ) {
        return persistedTask;
      }
      if (isRecentMediaGenerationTaskRecord({ task: persistedTask, maxAgeMs, nowMs })) {
        retainedEntries.push(entry);
      }
      continue;
    }
    if (isRecentMediaGenerationTaskRecord({ task, maxAgeMs, nowMs })) {
      const cachedTaskLabelMatches = !taskLabel || mediaGenerationTaskLabelMatches(task, taskLabel);
      if (isTaskStillBlockingDuplicateGuard(task) && cachedTaskLabelMatches) {
        return { ...task };
      }
      retainedEntries.push(entry);
    }
  }
  if (retainedEntries.length > 0) {
    recentMediaGenerationTaskStarts.set(key, retainedEntries.toReversed());
  } else {
    recentMediaGenerationTaskStarts.delete(key);
  }
  return undefined;
}

export function resetRecentMediaGenerationDuplicateGuardsForTests() {
  recentMediaGenerationTaskStarts.clear();
}

export function getMediaGenerationTaskProviderId(
  task: TaskRecord,
  sourcePrefix: string,
): string | undefined {
  const sourceId = task.sourceId?.trim() ?? "";
  if (!sourceId.startsWith(`${sourcePrefix}:`)) {
    return undefined;
  }
  const providerId = sourceId.slice(`${sourcePrefix}:`.length).trim();
  return providerId || undefined;
}

export function findActiveMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
}): TaskRecord | undefined {
  return listActiveMediaGenerationTasksForSession(params)[0];
}

export function listActiveMediaGenerationTasksForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
}): TaskRecord[] {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return [];
  }
  const taskLabel = normalizeOptionalString(params.taskLabel);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  const matches = listFreshTasksForOwnerKey(sessionKey).filter((task) => {
    if (
      task.runtime !== "cli" ||
      task.scopeKind !== "session" ||
      task.taskKind !== params.taskKind ||
      !isTaskStillBlockingDuplicateGuard(task)
    ) {
      return false;
    }
    if (sourcePrefix && !mediaGenerationSourceMatches(task, sourcePrefix)) {
      return false;
    }
    if (taskLabel && !mediaGenerationTaskLabelMatches(task, taskLabel)) {
      return false;
    }
    return true;
  });
  return [
    ...matches.filter((task) => task.status === "running"),
    ...matches.filter((task) => task.status !== "running"),
  ];
}

export function findDuplicateGuardMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  requestKey?: string;
  maxAgeMs: number;
}): TaskRecord | undefined {
  return (
    findRecentStartedMediaGenerationTaskForSession(params) ??
    findActiveMediaGenerationTaskForSession({
      sessionKey: params.sessionKey,
      taskKind: params.taskKind,
      sourcePrefix: params.sourcePrefix,
      taskLabel: params.taskLabel,
    }) ??
    undefined
  );
}

export function buildMediaGenerationTaskStatusDetails(params: {
  task: TaskRecord;
  sourcePrefix: string;
}): Record<string, unknown> {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  return {
    ...buildSessionAsyncTaskStatusDetails(params.task),
    active: isTaskStillBlockingDuplicateGuard(params.task),
    ...(provider ? { provider } : {}),
  };
}

export function buildMediaGenerationTaskStatusListDetails(params: {
  tasks: TaskRecord[];
  sourcePrefix: string;
}): Record<string, unknown> {
  return {
    async: true,
    active: true,
    existingTask: true,
    taskCount: params.tasks.length,
    tasks: params.tasks.map((task) =>
      buildMediaGenerationTaskStatusDetails({
        task,
        sourcePrefix: params.sourcePrefix,
      }),
    ),
  };
}

export function buildMediaGenerationTaskStatusText(params: {
  task: TaskRecord;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
  duplicateGuard?: boolean;
}): string {
  const provider = getMediaGenerationTaskProviderId(params.task, params.sourcePrefix);
  const active =
    params.task.status === "queued" ||
    params.task.status === "running" ||
    params.task.terminalOutcome === "blocked";
  const lines = [
    active
      ? `${params.nounLabel} task ${params.task.taskId} is already ${params.task.status}${provider ? ` with ${provider}` : ""}.`
      : `${params.nounLabel} task ${params.task.taskId} recently ${params.task.status}${provider ? ` with ${provider}` : ""}.`,
    params.task.progressSummary ? `Progress: ${params.task.progressSummary}.` : null,
    params.duplicateGuard
      ? active
        ? `Do not call ${params.toolName} again for this request. Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here.`
        : `Do not call ${params.toolName} again for the same request; this recent ${params.completionLabel} generation already completed.`
      : `Wait for the completion event; the completion agent will send the finished ${params.completionLabel} here when it's ready.`,
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}

export function buildMediaGenerationTaskStatusListText(params: {
  tasks: TaskRecord[];
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
}): string {
  const nounLabel = normalizeLowercaseStringOrEmpty(params.nounLabel);
  const lines = [
    `${params.tasks.length} active ${nounLabel} tasks are queued or running for this session.`,
    ...params.tasks.map((task) => {
      const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
      const runId = task.runId ? ` (run ${task.runId})` : "";
      const progress = task.progressSummary ? ` Progress: ${task.progressSummary}.` : "";
      return `- Task ${task.taskId}${runId} is ${task.status}${provider ? ` with ${provider}` : ""}.${progress}`;
    }),
    `Wait for the completion events; the completion agent will send the finished ${params.completionLabel} here when each is ready.`,
    `Only start a new ${params.toolName} call if the user clearly asks for different/new ${params.completionLabel}.`,
  ];
  return lines.join("\n");
}

export function buildActiveMediaGenerationTaskPromptContextForSession(params: {
  sessionKey?: string;
  taskKind: string;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
}): string | undefined {
  const task = findActiveMediaGenerationTaskForSession({
    sessionKey: params.sessionKey,
    taskKind: params.taskKind,
    sourcePrefix: params.sourcePrefix,
  });
  if (!task) {
    return undefined;
  }
  const provider = getMediaGenerationTaskProviderId(task, params.sourcePrefix);
  const lines = [
    `An active ${normalizeLowercaseStringOrEmpty(params.nounLabel)} background task already exists for this session.`,
    `Task ${task.taskId} is currently ${task.status}${provider ? ` via ${provider}` : ""}.`,
    task.progressSummary ? `Current progress: ${task.progressSummary}.` : null,
    `Do not call \`${params.toolName}\` again for the same request while that task is queued or running.`,
    `If the user asks for progress or whether the work is async, explain the active task state or call \`${params.toolName}\` with \`action:"status"\` instead of starting a new generation.`,
    `Only start a new \`${params.toolName}\` call if the user clearly asks for different/new ${params.completionLabel}.`,
  ].filter((entry): entry is string => Boolean(entry));
  return lines.join("\n");
}
