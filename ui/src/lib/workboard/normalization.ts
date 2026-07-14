import {
  normalizeEvents,
  normalizeExecution,
  normalizeMetadata,
} from "./metadata-normalization.ts";
import { isRecord } from "./normalization-utils.ts";
import {
  WORKBOARD_PRIORITIES,
  WORKBOARD_STATUSES,
  type WorkboardCard,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardTaskStatus,
  type WorkboardTaskSummary,
} from "./types.ts";

function normalizeCard(value: unknown): WorkboardCard | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id : "";
  const title = typeof value.title === "string" ? value.title : "";
  const status = WORKBOARD_STATUSES.includes(value.status as WorkboardStatus)
    ? (value.status as WorkboardStatus)
    : "todo";
  const priority = WORKBOARD_PRIORITIES.includes(value.priority as WorkboardPriority)
    ? (value.priority as WorkboardPriority)
    : "normal";
  if (!id || !title) {
    return null;
  }
  const execution = normalizeExecution(value.execution);
  const events = normalizeEvents(value.events);
  const metadata = normalizeMetadata(value.metadata);
  return {
    id,
    title,
    status,
    priority,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : [],
    position: typeof value.position === "number" ? value.position : 0,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.sourceUrl === "string" ? { sourceUrl: value.sourceUrl } : {}),
    ...(execution ? { execution } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.completedAt === "number" ? { completedAt: value.completedAt } : {}),
    ...(events.length ? { events } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function normalizeCardsPayload(payload: unknown): {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
} {
  if (!isRecord(payload)) {
    return { cards: [], statuses: WORKBOARD_STATUSES };
  }
  const cards = Array.isArray(payload.cards)
    ? payload.cards.map(normalizeCard).filter((card): card is WorkboardCard => card !== null)
    : [];
  const statuses = Array.isArray(payload.statuses)
    ? payload.statuses.filter((status): status is WorkboardStatus =>
        WORKBOARD_STATUSES.includes(status as WorkboardStatus),
      )
    : WORKBOARD_STATUSES;
  return { cards, statuses: statuses.length ? statuses : WORKBOARD_STATUSES };
}

export function normalizeCardPayload(payload: unknown): WorkboardCard {
  const card = isRecord(payload) ? normalizeCard(payload.card) : null;
  if (!card) {
    throw new Error("workboard response did not include a card");
  }
  return card;
}

function normalizeTaskStatus(value: unknown): WorkboardTaskStatus | null {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
    case "timed_out":
      return value;
    default:
      return null;
  }
}

export function normalizeTaskSummary(value: unknown): WorkboardTaskSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
  const taskId = typeof value.taskId === "string" && value.taskId.trim() ? value.taskId.trim() : id;
  const status = normalizeTaskStatus(value.status);
  if (!id || !taskId || !status) {
    return null;
  }
  return {
    id,
    taskId,
    status,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.childSessionKey === "string"
      ? { childSessionKey: value.childSessionKey }
      : {}),
    ...(typeof value.ownerKey === "string" ? { ownerKey: value.ownerKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.sourceId === "string" ? { sourceId: value.sourceId } : {}),
    ...(typeof value.updatedAt === "number" || typeof value.updatedAt === "string"
      ? { updatedAt: value.updatedAt }
      : {}),
    ...(typeof value.progressSummary === "string"
      ? { progressSummary: value.progressSummary }
      : {}),
    ...(typeof value.terminalSummary === "string"
      ? { terminalSummary: value.terminalSummary }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

export function normalizeTasksPage(payload: unknown): {
  tasks: WorkboardTaskSummary[];
  nextCursor: string | null;
} {
  if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
    return { tasks: [], nextCursor: null };
  }
  return {
    tasks: payload.tasks
      .map(normalizeTaskSummary)
      .filter((task): task is WorkboardTaskSummary => task !== null),
    nextCursor:
      typeof payload.nextCursor === "string" && payload.nextCursor.trim()
        ? payload.nextCursor.trim()
        : null,
  };
}
