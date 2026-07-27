import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { normalizeString, workboardCardRunId, workboardCardSessionKey } from "./card-state.ts";
import { formatError, isRecord } from "./normalization-utils.ts";
import { normalizeTaskSummary, normalizeTasksPage } from "./normalization.ts";
import { getWorkboardRuntime, type WorkboardHost } from "./runtime.ts";
import type { WorkboardCard, WorkboardTaskLinkState, WorkboardTaskSummary } from "./types.ts";

const WORKBOARD_TASKS_LIST_LIMIT = 500;
const WORKBOARD_TASK_POLL_BATCH_SIZE = 32;
const WORKBOARD_TASK_DISCOVERY_BATCH_SIZE = 4;
export const WORKBOARD_TASK_LOOKUP_RETRY_DELAYS_MS = [100, 250, 500] as const;

export async function listWorkboardTasks(
  client: GatewayBrowserClient,
): Promise<WorkboardTaskSummary[]> {
  const tasks: WorkboardTaskSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const payload = await client.request("tasks.list", {
      limit: WORKBOARD_TASKS_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const page = normalizeTasksPage(payload);
    tasks.push(...page.tasks);
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      return tasks;
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function taskUpdatedAtValue(task: WorkboardTaskSummary): number {
  if (typeof task.updatedAt === "number") {
    return task.updatedAt;
  }
  if (typeof task.updatedAt === "string") {
    const parsed = Date.parse(task.updatedAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function taskLifecycleSourceUpdatedAt(task: WorkboardTaskSummary): number | undefined {
  const updatedAt = taskUpdatedAtValue(task);
  return updatedAt > 0 ? updatedAt : undefined;
}

export function sessionUpdatedAtValue(session: GatewaySessionRow): number | undefined {
  return typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
    ? session.updatedAt
    : undefined;
}

export function taskSessionKeyMatchesCardSession(
  taskSessionKey: string | undefined,
  cardSessionKey: string,
): boolean {
  if (!taskSessionKey) {
    return false;
  }
  if (taskSessionKey === cardSessionKey) {
    return true;
  }
  return (
    cardSessionKey.startsWith("subagent:workboard-") &&
    taskSessionKey.endsWith(`:${cardSessionKey}`)
  );
}

export function taskMatchesCard(task: WorkboardTaskSummary, card: WorkboardCard): boolean {
  const cardTaskId = normalizeString(card.taskId);
  if (cardTaskId && (task.taskId === cardTaskId || task.id === cardTaskId)) {
    return true;
  }
  const cardSessionKey = workboardCardSessionKey(card);
  const taskSessionMatches = cardSessionKey
    ? [task.sessionKey, task.childSessionKey, task.ownerKey].some((taskSessionKey) =>
        taskSessionKeyMatchesCardSession(taskSessionKey, cardSessionKey),
      )
    : false;
  const cardRunId = workboardCardRunId(card);
  if (cardRunId && task.runId === cardRunId) {
    return cardSessionKey ? taskSessionMatches : true;
  }
  return taskSessionMatches;
}

function taskMatchesCanonicalCardLink(task: WorkboardTaskSummary, card: WorkboardCard): boolean {
  const cardTaskId = normalizeString(card.taskId);
  if (cardTaskId) {
    // Exact persisted task IDs stay authoritative when card run metadata is stale
    // or an otherwise matching task summary omits its optional run ID.
    return task.taskId === cardTaskId || task.id === cardTaskId;
  }
  const cardRunId = workboardCardRunId(card);
  if (cardRunId && task.runId !== cardRunId) {
    return false;
  }
  return taskMatchesCard(task, card);
}

export function taskMatchesTrackedCardLink(
  task: WorkboardTaskSummary,
  card: WorkboardCard,
  missingTaskIds: ReadonlySet<string>,
): boolean {
  const cardTaskId = normalizeString(card.taskId);
  return cardTaskId && missingTaskIds.has(cardTaskId)
    ? taskMatchesCard(task, card)
    : taskMatchesCanonicalCardLink(task, card);
}

function selectRotatingBatch<T>(
  host: WorkboardHost,
  items: readonly T[],
  limit: number,
  offsetKey: "taskPollOffset" | "taskDiscoveryOffset",
): T[] {
  const runtime = getWorkboardRuntime(host);
  if (items.length <= limit) {
    runtime[offsetKey] = 0;
    return [...items];
  }
  const offset = (runtime[offsetKey] ?? 0) % items.length;
  const batch = Array.from(
    { length: limit },
    (_, index) => items[(offset + index) % items.length],
  ).filter((item): item is T => item !== undefined);
  runtime[offsetKey] = (offset + batch.length) % items.length;
  return batch;
}

export function selectWorkboardTaskPollIds(
  host: WorkboardHost,
  cards: readonly WorkboardCard[],
  previousTasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>,
  missingTaskIds: ReadonlySet<string>,
): string[] {
  // Prepared summaries cover links between polls; rotate a hard-bounded batch
  // so active, terminal, and unresolved task IDs are eventually revalidated.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const previousTask = previousTasksByCardId.get(card.id);
    const previousMatches = previousTask
      ? taskMatchesTrackedCardLink(previousTask, card, missingTaskIds)
      : false;
    let taskId: string | undefined;
    if (previousMatches && previousTask) {
      taskId = previousTask.taskId;
    } else if (!previousMatches) {
      taskId = normalizeString(card.taskId) ?? undefined;
    }
    if (taskId && missingTaskIds.has(taskId)) {
      continue;
    }
    if (taskId && !seen.has(taskId)) {
      seen.add(taskId);
      ids.push(taskId);
    }
  }
  return selectRotatingBatch(host, ids, WORKBOARD_TASK_POLL_BATCH_SIZE, "taskPollOffset");
}

type WorkboardTaskDiscoveryQuery = {
  sessionKey?: string;
  cursor?: string;
};

export function selectWorkboardTaskDiscoveryQueries(
  host: WorkboardHost,
  cards: readonly WorkboardCard[],
  previousTasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>,
  missingTaskIds: ReadonlySet<string>,
): WorkboardTaskDiscoveryQuery[] {
  const queries: WorkboardTaskDiscoveryQuery[] = [];
  const seenSessionKeys = new Set<string>();
  let hasUnfilteredQuery = false;
  for (const card of cards) {
    const previousTask = previousTasksByCardId.get(card.id);
    const cardTaskId = normalizeString(card.taskId);
    const hasCanonicalTask =
      Boolean(cardTaskId && !missingTaskIds.has(cardTaskId)) ||
      (previousTask ? taskMatchesTrackedCardLink(previousTask, card, missingTaskIds) : false);
    const sessionKey = workboardCardSessionKey(card);
    if (card.status !== "running" || hasCanonicalTask || !sessionKey) {
      continue;
    }
    // The gateway filter is exact-match only. Default-agent Workboard sessions
    // omit the canonical agent prefix, so rotate through bounded unfiltered pages.
    if (sessionKey.startsWith("subagent:workboard-")) {
      if (!hasUnfilteredQuery) {
        hasUnfilteredQuery = true;
        const cursor = getWorkboardRuntime(host).defaultTaskDiscoveryCursor;
        queries.push(cursor ? { cursor } : {});
      }
    } else if (!seenSessionKeys.has(sessionKey)) {
      seenSessionKeys.add(sessionKey);
      queries.push({ sessionKey });
    }
  }
  return selectRotatingBatch(
    host,
    queries,
    WORKBOARD_TASK_DISCOVERY_BATCH_SIZE,
    "taskDiscoveryOffset",
  );
}

export function isMissingTaskLookupError(error: unknown, taskId: string): boolean {
  // tasks.get currently has no structured not-found detail code.
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message === `task not found: ${taskId}`
  );
}

export async function getWorkboardTaskPollBatch(
  client: GatewayBrowserClient,
  taskIds: readonly string[],
  discoveryQueries: readonly WorkboardTaskDiscoveryQuery[],
): Promise<{
  tasks: WorkboardTaskSummary[];
  missingTaskIds: Set<string>;
  nextUnfilteredCursor?: string | null;
  error: string | null;
}> {
  const results = await Promise.allSettled([
    ...taskIds.map(async (taskId) => {
      try {
        const payload = await client.request("tasks.get", { taskId });
        const task = isRecord(payload) ? normalizeTaskSummary(payload.task) : null;
        return { tasks: task ? [task] : [] };
      } catch (error) {
        if (isMissingTaskLookupError(error, taskId)) {
          return { tasks: [], missingTaskId: taskId };
        }
        throw error;
      }
    }),
    ...discoveryQueries.map(async (query) => {
      const payload = await client.request("tasks.list", {
        ...query,
        limit: WORKBOARD_TASKS_LIST_LIMIT,
      });
      const page = normalizeTasksPage(payload);
      return {
        tasks: page.tasks,
        ...(query.sessionKey ? {} : { nextUnfilteredCursor: page.nextCursor ?? null }),
      };
    }),
  ]);
  const tasks: WorkboardTaskSummary[] = [];
  const missingTaskIds = new Set<string>();
  let nextUnfilteredCursor: string | null | undefined;
  let error: string | null = null;
  for (const result of results) {
    if (result.status === "fulfilled") {
      tasks.push(...result.value.tasks);
      if ("missingTaskId" in result.value && result.value.missingTaskId) {
        missingTaskIds.add(result.value.missingTaskId);
      }
      if ("nextUnfilteredCursor" in result.value) {
        nextUnfilteredCursor = result.value.nextUnfilteredCursor;
      }
    } else {
      error ??= formatError(result.reason);
    }
  }
  return { tasks, missingTaskIds, nextUnfilteredCursor, error };
}

type WorkboardTaskIndex = {
  byId: Map<string, WorkboardTaskSummary[]>;
  byRunId: Map<string, WorkboardTaskSummary[]>;
  bySessionKey: Map<string, WorkboardTaskSummary[]>;
};

function addTaskIndexEntry(
  index: Map<string, WorkboardTaskSummary[]>,
  key: string | undefined,
  task: WorkboardTaskSummary,
) {
  if (!key) {
    return;
  }
  const tasks = index.get(key) ?? [];
  tasks.push(task);
  index.set(key, tasks);
}

function buildWorkboardTaskIndex(tasks: readonly WorkboardTaskSummary[]): WorkboardTaskIndex {
  const index: WorkboardTaskIndex = {
    byId: new Map(),
    byRunId: new Map(),
    bySessionKey: new Map(),
  };
  for (const task of tasks) {
    addTaskIndexEntry(index.byId, task.id, task);
    addTaskIndexEntry(index.byId, task.taskId, task);
    addTaskIndexEntry(index.byRunId, task.runId, task);
    for (const sessionKey of [task.sessionKey, task.childSessionKey, task.ownerKey]) {
      addTaskIndexEntry(index.bySessionKey, sessionKey, task);
      const nestedWorkboardSessionIndex = sessionKey?.lastIndexOf(":subagent:workboard-") ?? -1;
      if (nestedWorkboardSessionIndex >= 0) {
        addTaskIndexEntry(
          index.bySessionKey,
          sessionKey?.slice(nestedWorkboardSessionIndex + 1),
          task,
        );
      }
    }
  }
  return index;
}

function findLatestTaskForCard(
  index: WorkboardTaskIndex,
  card: WorkboardCard,
  missingTaskIds?: ReadonlySet<string>,
): WorkboardTaskSummary | null {
  const cardTaskId = normalizeString(card.taskId);
  if (cardTaskId) {
    let latestExact: WorkboardTaskSummary | null = null;
    for (const task of index.byId.get(cardTaskId) ?? []) {
      if (
        taskMatchesCanonicalCardLink(task, card) &&
        (!latestExact || taskUpdatedAtValue(task) > taskUpdatedAtValue(latestExact))
      ) {
        latestExact = task;
      }
    }
    if (latestExact || !missingTaskIds?.has(cardTaskId)) {
      return latestExact;
    }
  }
  const candidates = new Set<WorkboardTaskSummary>();
  const addCandidates = (tasks: readonly WorkboardTaskSummary[] | undefined) => {
    for (const task of tasks ?? []) {
      candidates.add(task);
    }
  };
  addCandidates(index.byRunId.get(workboardCardRunId(card) ?? ""));
  addCandidates(index.bySessionKey.get(workboardCardSessionKey(card) ?? ""));
  let latest: WorkboardTaskSummary | null = null;
  for (const task of candidates) {
    if (
      taskMatchesCard(task, card) &&
      (!latest || taskUpdatedAtValue(task) > taskUpdatedAtValue(latest))
    ) {
      latest = task;
    }
  }
  return latest;
}

export function selectWorkboardMissingTaskConfirmationIds(
  host: WorkboardHost,
  cards: readonly WorkboardCard[],
  tasks: readonly WorkboardTaskSummary[],
  missingTaskIds: ReadonlySet<string>,
  previousTasksByCardId: ReadonlyMap<string, WorkboardTaskSummary> = new Map(),
  confirmedTaskIds: ReadonlySet<string> = new Set(),
  limit = WORKBOARD_TASK_POLL_BATCH_SIZE,
): string[] {
  const taskIndex = buildWorkboardTaskIndex(tasks);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const previousTask = previousTasksByCardId.get(card.id);
    const previousMatches = previousTask
      ? taskMatchesTrackedCardLink(previousTask, card, missingTaskIds)
      : false;
    const taskId =
      previousMatches && previousTask ? previousTask.taskId : normalizeString(card.taskId);
    if (
      !taskId ||
      seen.has(taskId) ||
      missingTaskIds.has(taskId) ||
      confirmedTaskIds.has(taskId) ||
      findLatestTaskForCard(taskIndex, card, missingTaskIds)
    ) {
      continue;
    }
    seen.add(taskId);
    ids.push(taskId);
  }
  return Number.isFinite(limit) ? selectRotatingBatch(host, ids, limit, "taskPollOffset") : ids;
}

export function applyTaskSummariesToState(
  state: WorkboardTaskLinkState,
  tasks: readonly WorkboardTaskSummary[],
  options: {
    missingTaskIds?: ReadonlySet<string>;
  } = {},
) {
  const tasksByCardId = new Map<string, WorkboardTaskSummary>();
  const taskIndex = buildWorkboardTaskIndex(tasks);
  // Keep historical card links read-only while remembering exact ledger misses.
  // Confirmed misses stop blocking starts without writes from passive refresh paths.
  const missingTaskIds = new Set([...state.missingTaskIds, ...(options.missingTaskIds ?? [])]);
  const cards = state.cards.map((card) => {
    const cardTaskId = normalizeString(card.taskId);
    const task = findLatestTaskForCard(taskIndex, card, missingTaskIds);
    if (!task) {
      return card;
    }
    tasksByCardId.set(card.id, task);
    const replacesMissingTask =
      Boolean(cardTaskId && missingTaskIds.has(cardTaskId)) &&
      task.taskId !== cardTaskId &&
      task.id !== cardTaskId;
    if (cardTaskId && !replacesMissingTask) {
      missingTaskIds.delete(cardTaskId);
    }
    missingTaskIds.delete(task.taskId);
    if (card.taskId === task.taskId || replacesMissingTask) {
      return card;
    }
    return { ...card, taskId: task.taskId };
  });
  const linkedTaskIds = new Set(
    cards
      .map((card) => normalizeString(card.taskId))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );
  state.cards = cards;
  state.tasksByCardId = tasksByCardId;
  state.missingTaskIds = new Set([...missingTaskIds].filter((taskId) => linkedTaskIds.has(taskId)));
}
