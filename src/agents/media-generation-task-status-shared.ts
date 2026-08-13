import { stableStringify } from "@openclaw/normalization-core";
/**
 * Shared media generation task status and duplicate-guard helpers.
 *
 * Image/video task modules use this to track recent starts, find active
 * background tasks, and build consistent user/prompt status messages.
 */
import { resolveNonNegativeIntegerOption } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/config.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { listFreshTasksForOwnerKey } from "../tasks/runtime-internal.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { buildSessionAsyncTaskStatusDetails } from "./session-async-task-status.js";

/** Marks media as ready while requester delivery is still being confirmed. */
export const MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS =
  "Generated media; delivering completion";

type RecentMediaGenerationTaskStart = {
  task: TaskRecord;
  requestKey?: string;
};

const recentMediaGenerationTaskStarts = new Map<string, RecentMediaGenerationTaskStart[]>();
const RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS = 2 * 60_000;

/** Builds a stable request key for media generation duplicate detection. */
export function buildMediaGenerationRequestKey(value: Record<string, unknown>): string {
  return stableStringify(value);
}

function buildRecentMediaGenerationTaskKey(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
}): string | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const taskKind = normalizeOptionalString(params.taskKind);
  const sourcePrefix = normalizeOptionalString(params.sourcePrefix);
  if (!sessionKey || !taskKind || !sourcePrefix) {
    return undefined;
  }
  return `${params.agentId?.trim() ?? "unknown"}\0${sessionKey}\0${taskKind}\0${sourcePrefix}`;
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

function resolveMediaGenerationTaskRequesterAgentId(task: TaskRecord): string | undefined {
  const explicit = normalizeOptionalString(task.requesterAgentId);
  if (explicit) {
    return explicit;
  }
  const ownerKey = normalizeOptionalString(task.ownerKey ?? task.requesterSessionKey);
  const parsed = parseAgentSessionKey(ownerKey)?.agentId;
  if (parsed) {
    return parsed;
  }
  if (!ownerKey) {
    return undefined;
  }
  try {
    return resolveSessionAgentId({ config: getRuntimeConfig(), sessionKey: ownerKey });
  } catch {
    return undefined;
  }
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
  agentId?: string;
  cachedTask: TaskRecord;
  taskKind: string;
  sourcePrefix: string;
}): TaskRecord | undefined {
  return listFreshTasksForOwnerKey(params.sessionKey).find((task) => {
    if (
      task.runtime !== "cli" ||
      task.scopeKind !== "session" ||
      task.taskKind !== params.taskKind ||
      !mediaGenerationSourceMatches(task, params.sourcePrefix) ||
      (params.agentId && resolveMediaGenerationTaskRequesterAgentId(task) !== params.agentId)
    ) {
      return false;
    }
    if (task.taskId === params.cachedTask.taskId) {
      return true;
    }
    return Boolean(task.runId && task.runId === params.cachedTask.runId);
  });
}

/** Records a just-started media task so duplicate guards work before persistence. */
export function recordRecentMediaGenerationTaskStartForSession(params: {
  sessionKey?: string;
  agentId?: string;
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
      requesterAgentId: params.agentId,
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

/** Finds a recent started media task from memory or persisted task state. */
function findRecentStartedMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  agentId?: string;
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
  // Prefer persisted tasks when available; the in-memory start cache bridges
  // the short gap before async task persistence catches up.
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
      agentId: params.agentId,
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

/** Clears in-memory duplicate guards between tests. */
function resetRecentMediaGenerationDuplicateGuardsForTests() {
  recentMediaGenerationTaskStarts.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.mediaGenerationDuplicateGuardTestApi")
  ] = { resetRecentMediaGenerationDuplicateGuardsForTests };
}

/** Extracts a provider id from a media task source id with the given prefix. */
function getMediaGenerationTaskProviderId(
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

/** Finds the highest-priority active media generation task for a session. */
function findActiveMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  excludeDeliveringCompletion?: boolean;
}): TaskRecord | undefined {
  return listActiveMediaGenerationTasksForSession(params)[0];
}

/** Lists active media generation tasks for a session, preferring running tasks. */
function listActiveMediaGenerationTasksForSession(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  taskLabel?: string;
  excludeDeliveringCompletion?: boolean;
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
    if (params.agentId && resolveMediaGenerationTaskRequesterAgentId(task) !== params.agentId) {
      return false;
    }
    if (sourcePrefix && !mediaGenerationSourceMatches(task, sourcePrefix)) {
      return false;
    }
    if (taskLabel && !mediaGenerationTaskLabelMatches(task, taskLabel)) {
      return false;
    }
    if (
      params.excludeDeliveringCompletion &&
      task.progressSummary === MEDIA_GENERATION_DELIVERING_COMPLETION_PROGRESS
    ) {
      return false;
    }
    return true;
  });
  return [
    ...matches.filter((task) => task.status === "running"),
    ...matches.filter((task) => task.status !== "running"),
  ];
}

/** Finds a task that should block duplicate media generation for a session. */
function findDuplicateGuardMediaGenerationTaskForSession(params: {
  sessionKey?: string;
  agentId?: string;
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
      agentId: params.agentId,
      taskKind: params.taskKind,
      sourcePrefix: params.sourcePrefix,
      taskLabel: params.taskLabel,
    }) ??
    undefined
  );
}

/** Builds structured status details for one media generation task. */
function buildMediaGenerationTaskStatusDetails(params: {
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

/** Builds structured status details for a list of media generation tasks. */
function buildMediaGenerationTaskStatusListDetails(params: {
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

/** Builds user-facing status text for one media generation task. */
function buildMediaGenerationTaskStatusText(params: {
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

/** Builds user-facing status text for multiple active media generation tasks. */
function buildMediaGenerationTaskStatusListText(params: {
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

/** Builds prompt context warning an agent about an active media generation task. */
function buildActiveMediaGenerationTaskPromptContextForSession(params: {
  sessionKey?: string;
  agentId?: string;
  taskKind: string;
  sourcePrefix: string;
  nounLabel: string;
  toolName: string;
  completionLabel: string;
}): string | undefined {
  const task = findActiveMediaGenerationTaskForSession({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    taskKind: params.taskKind,
    sourcePrefix: params.sourcePrefix,
    excludeDeliveringCompletion: true,
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

/** Specializes shared task lookup, duplicate guards, and status text for one media tool. */
export function createMediaGenerationTaskStatusOwner(params: {
  taskKind: string;
  toolName: string;
  nounLabel: string;
  completionLabel: string;
  promptCompletionLabel: string;
}) {
  const taskIdentity = { taskKind: params.taskKind, sourcePrefix: params.toolName };
  const taskPresentation = {
    sourcePrefix: params.toolName,
    nounLabel: params.nounLabel,
    toolName: params.toolName,
  };
  return {
    findActiveTaskForSession(
      this: void,
      sessionKey?: string,
      request?: { prompt?: string; agentId?: string },
    ) {
      return findActiveMediaGenerationTaskForSession({
        ...taskIdentity,
        sessionKey,
        taskLabel: request?.prompt,
        agentId: request?.agentId,
      });
    },
    listActiveTasksForSession(this: void, sessionKey?: string, agentId?: string) {
      return listActiveMediaGenerationTasksForSession({ ...taskIdentity, sessionKey, agentId });
    },
    findDuplicateGuardTaskForSession(
      this: void,
      sessionKey?: string,
      request?: { prompt?: string; requestKey?: string; agentId?: string },
    ) {
      return findDuplicateGuardMediaGenerationTaskForSession({
        ...taskIdentity,
        sessionKey,
        taskLabel: request?.prompt,
        requestKey: request?.requestKey,
        agentId: request?.agentId,
        maxAgeMs: RECENT_MEDIA_GENERATION_TASK_START_CACHE_MS,
      });
    },
    buildTaskStatusDetails(this: void, task: TaskRecord) {
      return buildMediaGenerationTaskStatusDetails({ task, sourcePrefix: params.toolName });
    },
    buildTaskStatusListDetails(this: void, tasks: TaskRecord[]) {
      return buildMediaGenerationTaskStatusListDetails({ tasks, sourcePrefix: params.toolName });
    },
    buildTaskStatusText(this: void, task: TaskRecord, options?: { duplicateGuard?: boolean }) {
      return buildMediaGenerationTaskStatusText({
        ...taskPresentation,
        task,
        completionLabel: params.completionLabel,
        duplicateGuard: options?.duplicateGuard,
      });
    },
    buildTaskStatusListText(this: void, tasks: TaskRecord[]) {
      return buildMediaGenerationTaskStatusListText({
        ...taskPresentation,
        tasks,
        completionLabel: params.promptCompletionLabel,
      });
    },
    buildActiveTaskPromptContextForSession(this: void, sessionKey?: string, agentId?: string) {
      return buildActiveMediaGenerationTaskPromptContextForSession({
        ...taskIdentity,
        ...taskPresentation,
        sessionKey,
        agentId,
        completionLabel: params.promptCompletionLabel,
      });
    },
  };
}
