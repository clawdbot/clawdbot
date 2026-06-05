// Workboard plugin module implements store behavior.
import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import {
  WORKBOARD_DIAGNOSTIC_KINDS,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EXECUTION_ENGINES,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_NOTIFICATION_KINDS,
  WORKBOARD_PRIORITIES,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
  type WorkboardCard,
  type WorkboardArtifact,
  type WorkboardAttachment,
  type WorkboardAttemptStatus,
  type WorkboardAutomation,
  type WorkboardBoardMetadata,
  type WorkboardClaim,
  type WorkboardComment,
  type WorkboardDiagnostic,
  type WorkboardDiagnosticAction,
  type WorkboardDiagnosticKind,
  type WorkboardDiagnosticSeverity,
  type WorkboardEvent,
  type WorkboardEventKind,
  type WorkboardExecution,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardExecutionStatus,
  type WorkboardLink,
  type WorkboardLinkType,
  type WorkboardMetadata,
  type WorkboardNotification,
  type WorkboardNotificationKind,
  type WorkboardNotificationSubscription,
  type WorkboardOrchestrationSettings,
  type WorkboardPriority,
  type WorkboardProof,
  type WorkboardProofStatus,
  type WorkboardRunAttempt,
  type WorkboardStatus,
  type WorkboardTemplateId,
  type WorkboardWorkerLog,
  type WorkboardWorkerProtocol,
  type WorkboardWorkspace,
} from "./types.js";
export type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardKeyedStore,
} from "./persistence-types.js";

const POSITION_STEP = 1000;
const MAX_CARDS = 2000;
const MAX_CARD_EVENTS = 50;
const MAX_CARD_ATTEMPTS = 30;
const MAX_CARD_COMMENTS = 50;
const MAX_CARD_LINKS = 50;
const MAX_CARD_PROOF = 40;
const MAX_CARD_ARTIFACTS = 40;
const MAX_CARD_ATTACHMENTS = 20;
const MAX_ATTACHMENT_ENTRIES = MAX_CARDS * (MAX_CARD_ATTACHMENTS + 1);
const MAX_CARD_WORKER_LOGS = 40;
const MAX_ATTACHMENT_BYTES = 256 * 1024;
const MAX_CARD_DIAGNOSTICS = 12;
const MAX_CARD_NOTIFICATIONS = 20;
const MAX_CARD_METADATA_BYTES = 24 * 1024;
const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
const READY_STRANDED_MS = 60 * 60 * 1000;
const RUNNING_HEARTBEAT_STALE_MS = 20 * 60 * 1000;
const BLOCKED_TOO_LONG_MS = 24 * 60 * 60 * 1000;
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

function secondsToDurationMs(seconds: number): number {
  const ms = Math.trunc(seconds) * 1000;
  return Number.isFinite(ms)
    ? Math.min(MAX_DATE_TIMESTAMP_MS, Math.max(1, ms))
    : MAX_DATE_TIMESTAMP_MS;
}

function addWorkboardDurationMs(now: number, durationMs: number): number {
  return resolveExpiresAtMsFromDurationMs(durationMs, { nowMs: now }) ?? MAX_DATE_TIMESTAMP_MS;
}

export type WorkboardCardInput = {
  title?: unknown;
  notes?: unknown;
  status?: unknown;
  priority?: unknown;
  labels?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  taskId?: unknown;
  sourceUrl?: unknown;
  execution?: unknown;
  metadata?: unknown;
  templateId?: unknown;
  position?: unknown;
  tenant?: unknown;
  boardId?: unknown;
  createdByCardId?: unknown;
  idempotencyKey?: unknown;
  skills?: unknown;
  workspace?: unknown;
  maxRuntimeSeconds?: unknown;
  maxRetries?: unknown;
  scheduledAt?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  parents?: unknown;
};

export type WorkboardCardPatch = Partial<WorkboardCardInput>;
export type WorkboardCommentInput = { body?: unknown };
export type WorkboardLinkInput = {
  type?: unknown;
  targetCardId?: unknown;
  title?: unknown;
  url?: unknown;
};
export type WorkboardLinkedCreateInput = WorkboardCardInput & {
  parents?: unknown;
};
export type WorkboardProofInput = {
  status?: unknown;
  label?: unknown;
  command?: unknown;
  url?: unknown;
  note?: unknown;
};
export type WorkboardArtifactInput = {
  label?: unknown;
  url?: unknown;
  path?: unknown;
  mimeType?: unknown;
};
export type WorkboardAttachmentInput = {
  fileName?: unknown;
  contentBase64?: unknown;
  mimeType?: unknown;
  note?: unknown;
};
export type WorkboardWorkerLogInput = {
  level?: unknown;
  message?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
};
export type WorkboardProtocolViolationInput = {
  detail?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
};
export type WorkboardClaimInput = {
  ownerId?: unknown;
  token?: unknown;
  ttlSeconds?: unknown;
};
export type WorkboardHeartbeatInput = {
  token?: unknown;
  ownerId?: unknown;
  note?: unknown;
};
export type WorkboardBulkInput = {
  ids?: unknown;
  patch?: unknown;
  archived?: unknown;
};
export type WorkboardCompleteInput = {
  ownerId?: unknown;
  token?: unknown;
  summary?: unknown;
  proof?: unknown;
  artifacts?: unknown;
  createdCardIds?: unknown;
};
export type WorkboardBlockInput = {
  ownerId?: unknown;
  token?: unknown;
  reason?: unknown;
};
export type WorkboardDispatchResult = {
  promoted: WorkboardCard[];
  reclaimed: WorkboardCard[];
  blocked: WorkboardCard[];
  orchestrated: WorkboardCard[];
  count: number;
};
export type WorkboardListOptions = {
  boardId?: unknown;
};
export type WorkboardBoardSummary = {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  defaultWorkspace?: WorkboardWorkspace;
  orchestration?: WorkboardOrchestrationSettings;
  total: number;
  active: number;
  archived: number;
  byStatus: Partial<Record<WorkboardStatus, number>>;
  updatedAt?: number;
  archivedAt?: number;
};
export type WorkboardStatsResult = WorkboardBoardSummary & {
  byAgent: Record<string, number>;
  oldestReadyAgeMs?: number;
};
export type WorkboardPromoteInput = {
  force?: unknown;
  reason?: unknown;
};
export type WorkboardReassignInput = {
  agentId?: unknown;
  status?: unknown;
  resetFailures?: unknown;
  reason?: unknown;
};
export type WorkboardReclaimInput = {
  status?: unknown;
  reason?: unknown;
};
export type WorkboardBoardInput = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  color?: unknown;
  defaultWorkspace?: unknown;
  orchestration?: unknown;
  archived?: unknown;
};
export type WorkboardSpecifyInput = WorkboardCardPatch & {
  summary?: unknown;
};
export type WorkboardDecomposeChildInput = WorkboardLinkedCreateInput & {
  idempotencyKey?: unknown;
};
export type WorkboardDecomposeInput = {
  summary?: unknown;
  children?: unknown;
  completeParent?: unknown;
};
export type WorkboardNotificationSubscribeInput = {
  boardId?: unknown;
  cardId?: unknown;
  sessionKey?: unknown;
  runId?: unknown;
  target?: unknown;
  eventKinds?: unknown;
};
export type WorkboardNotificationListOptions = {
  boardId?: unknown;
  cardId?: unknown;
};
export type WorkboardNotificationEventsInput = WorkboardNotificationListOptions & {
  subscriptionId?: unknown;
  limit?: unknown;
};
export type WorkboardMutationScope = {
  ownerId?: unknown;
  token?: unknown;
};

export type WorkboardDiagnosticsResult = {
  diagnostics: Array<{
    card: WorkboardCard;
    diagnostics: WorkboardDiagnostic[];
  }>;
  count: number;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoardId(value: unknown, fallback?: string): string | undefined {
  const raw = normalizeBoundedString(value, fallback, 80, "board id");
  if (!raw) {
    return undefined;
  }
  const boardId = raw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(boardId)) {
    throw new Error(
      "board id must start with a letter or number and use letters, numbers, dots, dashes, or underscores.",
    );
  }
  return boardId;
}

function normalizeBoardIdRequired(value: unknown): string {
  return normalizeBoardId(value) ?? "default";
}

function normalizeBoardMetadata(
  input: WorkboardBoardInput,
  fallback: WorkboardBoardMetadata | undefined,
  now = Date.now(),
): WorkboardBoardMetadata {
  const id = normalizeBoardId(input.id, fallback?.id) ?? "default";
  const name = normalizeBoundedString(input.name, fallback?.name, 120, "board name");
  const description = normalizeBoundedString(
    input.description,
    fallback?.description,
    1000,
    "board description",
  );
  const icon = normalizeBoundedString(input.icon, fallback?.icon, 40, "board icon");
  const color = normalizeBoundedString(input.color, fallback?.color, 40, "board color");
  const defaultWorkspace = Object.hasOwn(input, "defaultWorkspace")
    ? normalizeWorkspace(input.defaultWorkspace, fallback?.defaultWorkspace)
    : fallback?.defaultWorkspace;
  const orchestration = Object.hasOwn(input, "orchestration")
    ? normalizeOrchestration(input.orchestration, fallback?.orchestration)
    : fallback?.orchestration;
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === false
      ? undefined
      : now
    : fallback?.archivedAt;
  return {
    id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
    ...(defaultWorkspace ? { defaultWorkspace } : {}),
    ...(orchestration ? { orchestration } : {}),
    createdAt: fallback?.createdAt ?? now,
    updatedAt: now,
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function normalizeOrchestration(
  value: unknown,
  fallback?: WorkboardOrchestrationSettings,
): WorkboardOrchestrationSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const autoDecompose =
    typeof record.autoDecompose === "boolean" ? record.autoDecompose : fallback?.autoDecompose;
  const autoDecomposePerDispatch =
    typeof record.autoDecomposePerDispatch === "number" &&
    Number.isFinite(record.autoDecomposePerDispatch)
      ? Math.max(1, Math.min(20, Math.trunc(record.autoDecomposePerDispatch)))
      : fallback?.autoDecomposePerDispatch;
  const defaultAssignee = normalizeBoundedString(
    record.defaultAssignee,
    fallback?.defaultAssignee,
    120,
    "default assignee",
  );
  const orchestratorProfile = normalizeBoundedString(
    record.orchestratorProfile,
    fallback?.orchestratorProfile,
    120,
    "orchestrator profile",
  );
  const next: WorkboardOrchestrationSettings = {
    ...(autoDecompose !== undefined ? { autoDecompose } : {}),
    ...(autoDecomposePerDispatch ? { autoDecomposePerDispatch } : {}),
    ...(defaultAssignee ? { defaultAssignee } : {}),
    ...(orchestratorProfile ? { orchestratorProfile } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

function normalizeNotificationKinds(value: unknown): WorkboardNotificationKind[] | undefined {
  if (value == null) {
    return undefined;
  }
  const entries = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const kinds: WorkboardNotificationKind[] = [];
  for (const entry of entries) {
    const kind = typeof entry === "string" ? entry.trim() : "";
    if (!WORKBOARD_NOTIFICATION_KINDS.includes(kind as WorkboardNotificationKind)) {
      throw new Error(
        `notification kind must be one of: ${WORKBOARD_NOTIFICATION_KINDS.join(", ")}.`,
      );
    }
    const notificationKind = kind as WorkboardNotificationKind;
    if (!kinds.includes(notificationKind)) {
      kinds.push(notificationKind);
    }
  }
  return kinds.length ? kinds : undefined;
}

function normalizeNotificationSubscription(
  input: WorkboardNotificationSubscribeInput,
  fallback?: WorkboardNotificationSubscription,
  now = Date.now(),
): WorkboardNotificationSubscription {
  const boardId = normalizeBoardId(input.boardId, fallback?.boardId) ?? "default";
  const cardId = normalizeBoundedString(input.cardId, fallback?.cardId, 120, "card id");
  const sessionKey = normalizeBoundedString(
    input.sessionKey,
    fallback?.sessionKey,
    240,
    "session key",
  );
  const runId = normalizeBoundedString(input.runId, fallback?.runId, 160, "run id");
  const target = normalizeBoundedString(input.target, fallback?.target, 240, "notification target");
  if (!cardId && !sessionKey && !runId && !target) {
    throw new Error("notification subscription needs cardId, sessionKey, runId, or target.");
  }
  const eventKinds = normalizeNotificationKinds(input.eventKinds);
  return {
    id: fallback?.id ?? randomUUID(),
    boardId,
    ...(cardId ? { cardId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(target ? { target } : {}),
    ...(eventKinds ? { eventKinds } : {}),
    ...(fallback?.lastEventAt ? { lastEventAt: fallback.lastEventAt } : {}),
    ...(fallback?.lastEventId ? { lastEventId: fallback.lastEventId } : {}),
    ...(fallback?.lastEventSequence ? { lastEventSequence: fallback.lastEventSequence } : {}),
    ...(fallback?.deliveredEventIds?.length
      ? { deliveredEventIds: fallback.deliveredEventIds }
      : {}),
    createdAt: fallback?.createdAt ?? now,
    updatedAt: now,
  };
}

function normalizeTitle(value: unknown): string {
  const title = normalizeOptionalString(value);
  if (!title) {
    throw new Error("title is required.");
  }
  if (title.length > 180) {
    throw new Error("title must be 180 characters or fewer.");
  }
  return title;
}

function normalizeNotes(value: unknown): string | undefined {
  const notes = normalizeOptionalString(value);
  if (!notes) {
    return undefined;
  }
  if (notes.length > 4000) {
    throw new Error("notes must be 4000 characters or fewer.");
  }
  return notes;
}

function normalizeBoundedString(
  value: unknown,
  fallback: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeStatus(value: unknown, fallback: WorkboardStatus): WorkboardStatus {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_STATUSES as readonly string[]).includes(value)) {
    return value as WorkboardStatus;
  }
  throw new Error(`status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`);
}

function normalizePriority(value: unknown, fallback: WorkboardPriority): WorkboardPriority {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_PRIORITIES as readonly string[]).includes(value)) {
    return value as WorkboardPriority;
  }
  throw new Error(`priority must be one of: ${WORKBOARD_PRIORITIES.join(", ")}.`);
}

function normalizeLabels(value: unknown, fallback: string[] = []): string[] {
  if (value == null) {
    return fallback;
  }
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!entries) {
    throw new Error("labels must be an array or comma-separated string.");
  }
  const labels: string[] = [];
  for (const entry of entries) {
    const label = normalizeOptionalString(entry);
    if (!label || labels.includes(label)) {
      continue;
    }
    if (label.length > 40) {
      throw new Error("labels must be 40 characters or fewer.");
    }
    labels.push(label);
    if (labels.length >= 12) {
      break;
    }
  }
  return labels;
}

function normalizeStringList(value: unknown, fieldName: string, maxLength = 80): string[] {
  if (value == null) {
    return [];
  }
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!entries) {
    throw new Error(`${fieldName} must be an array or comma-separated string.`);
  }
  const values: string[] = [];
  for (const entry of entries) {
    if (Array.isArray(value) && typeof entry !== "string") {
      throw new Error(`${fieldName} entries must be strings.`);
    }
    const normalized = normalizeBoundedString(entry, undefined, maxLength, fieldName);
    if (normalized && !values.includes(normalized)) {
      values.push(normalized);
    }
    if (values.length > 20) {
      throw new Error(`${fieldName} supports at most 20 entries.`);
    }
  }
  return values;
}

function normalizePosition(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a number.`);
  }
  return Math.max(1, Math.trunc(value));
}

function isAbsoluteWorkspacePath(value: string): boolean {
  return (
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}

function normalizeWorkspace(
  value: unknown,
  fallback?: WorkboardWorkspace,
): WorkboardWorkspace | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "scratch" || record.kind === "dir" || record.kind === "worktree"
      ? record.kind
      : fallback?.kind;
  if (!kind) {
    throw new Error("workspace kind must be scratch, dir, or worktree.");
  }
  const workspacePath = normalizeBoundedString(record.path, fallback?.path, 2000, "workspace path");
  if (kind === "dir" && (!workspacePath || !isAbsoluteWorkspacePath(workspacePath))) {
    throw new Error("dir workspace path must be absolute.");
  }
  const branch = normalizeBoundedString(record.branch, fallback?.branch, 160, "workspace branch");
  return {
    kind,
    ...(workspacePath ? { path: workspacePath } : {}),
    ...(branch ? { branch } : {}),
  };
}

function normalizeAutomation(
  value: unknown,
  fallback: WorkboardAutomation = {},
): WorkboardAutomation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.keys(fallback).length ? fallback : undefined;
  }
  const record = value as Record<string, unknown>;
  const tenant = normalizeBoundedString(record.tenant, fallback.tenant, 80, "tenant");
  const boardId = Object.hasOwn(record, "boardId")
    ? normalizeBoardId(record.boardId, fallback.boardId)
    : fallback.boardId;
  const createdByCardId = normalizeBoundedString(
    record.createdByCardId,
    fallback.createdByCardId,
    120,
    "created by card id",
  );
  const idempotencyKey = normalizeBoundedString(
    record.idempotencyKey,
    fallback.idempotencyKey,
    160,
    "idempotency key",
  );
  const summary = normalizeBoundedString(record.summary, fallback.summary, 2000, "summary");
  const skills = Object.hasOwn(record, "skills")
    ? normalizeStringList(record.skills, "skills")
    : fallback.skills;
  const createdCardIds = Object.hasOwn(record, "createdCardIds")
    ? normalizeStringList(record.createdCardIds, "created card ids", 120)
    : fallback.createdCardIds;
  const scheduledAt = Object.hasOwn(record, "scheduledAt")
    ? normalizeTimestamp(record.scheduledAt, 0) || undefined
    : fallback.scheduledAt;
  const maxRuntimeSeconds = Object.hasOwn(record, "maxRuntimeSeconds")
    ? normalizePositiveInteger(record.maxRuntimeSeconds, "max runtime seconds")
    : fallback.maxRuntimeSeconds;
  const maxRetries = Object.hasOwn(record, "maxRetries")
    ? normalizePositiveInteger(record.maxRetries, "max retries")
    : fallback.maxRetries;
  const dispatchCount = Object.hasOwn(record, "dispatchCount")
    ? normalizeTimestamp(record.dispatchCount, 0) || undefined
    : fallback.dispatchCount;
  const lastDispatchAt = Object.hasOwn(record, "lastDispatchAt")
    ? normalizeTimestamp(record.lastDispatchAt, 0) || undefined
    : fallback.lastDispatchAt;
  const workspace = Object.hasOwn(record, "workspace")
    ? normalizeWorkspace(record.workspace, fallback.workspace)
    : fallback.workspace;
  const next = removeUndefinedAutomationFields({
    ...(tenant ? { tenant } : {}),
    ...(boardId ? { boardId } : {}),
    ...(createdByCardId ? { createdByCardId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(skills?.length ? { skills } : {}),
    ...(workspace ? { workspace } : {}),
    ...(maxRuntimeSeconds ? { maxRuntimeSeconds } : {}),
    ...(maxRetries ? { maxRetries } : {}),
    ...(scheduledAt ? { scheduledAt } : {}),
    ...(summary ? { summary } : {}),
    ...(createdCardIds?.length ? { createdCardIds } : {}),
    ...(dispatchCount ? { dispatchCount } : {}),
    ...(lastDispatchAt ? { lastDispatchAt } : {}),
  });
  return Object.keys(next).length ? next : undefined;
}

function deriveChildIdempotencyKey(
  parentKey: string | undefined,
  index: number,
): string | undefined {
  if (!parentKey) {
    return undefined;
  }
  const key = `${parentKey}:child:${index}`;
  return key.length <= 160 ? key : undefined;
}

function normalizeExecutionEngine(
  value: unknown,
  fallback: WorkboardExecutionEngine,
): WorkboardExecutionEngine {
  if (
    typeof value === "string" &&
    WORKBOARD_EXECUTION_ENGINES.includes(value as WorkboardExecutionEngine)
  ) {
    return value as WorkboardExecutionEngine;
  }
  return fallback;
}

function normalizeExecutionMode(
  value: unknown,
  fallback: WorkboardExecutionMode,
): WorkboardExecutionMode {
  if (
    typeof value === "string" &&
    WORKBOARD_EXECUTION_MODES.includes(value as WorkboardExecutionMode)
  ) {
    return value as WorkboardExecutionMode;
  }
  return fallback;
}

function normalizeExecutionStatus(
  value: unknown,
  fallback: WorkboardExecutionStatus,
): WorkboardExecutionStatus {
  if (
    typeof value === "string" &&
    WORKBOARD_EXECUTION_STATUSES.includes(value as WorkboardExecutionStatus)
  ) {
    return value as WorkboardExecutionStatus;
  }
  return fallback;
}

function normalizeAttemptStatus(
  value: unknown,
  fallback: WorkboardAttemptStatus,
): WorkboardAttemptStatus {
  if (
    typeof value === "string" &&
    WORKBOARD_ATTEMPT_STATUSES.includes(value as WorkboardAttemptStatus)
  ) {
    return value as WorkboardAttemptStatus;
  }
  return fallback;
}

function normalizeLinkType(value: unknown, fallback: WorkboardLinkType): WorkboardLinkType {
  if (typeof value === "string" && WORKBOARD_LINK_TYPES.includes(value as WorkboardLinkType)) {
    return value as WorkboardLinkType;
  }
  return fallback;
}

function normalizeProofStatus(
  value: unknown,
  fallback: WorkboardProofStatus,
): WorkboardProofStatus {
  if (
    typeof value === "string" &&
    WORKBOARD_PROOF_STATUSES.includes(value as WorkboardProofStatus)
  ) {
    return value as WorkboardProofStatus;
  }
  return fallback;
}

function normalizeTemplateId(value: unknown): WorkboardTemplateId | undefined {
  return typeof value === "string" && WORKBOARD_TEMPLATE_IDS.includes(value as WorkboardTemplateId)
    ? (value as WorkboardTemplateId)
    : undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function normalizeEvent(value: unknown): WorkboardEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const kind = WORKBOARD_EVENT_KINDS.includes(record.kind as WorkboardEventKind)
    ? (record.kind as WorkboardEventKind)
    : null;
  const at = normalizeTimestamp(record.at, 0);
  if (!id || !kind || !at) {
    return null;
  }
  const fromStatus =
    typeof record.fromStatus === "string" &&
    WORKBOARD_STATUSES.includes(record.fromStatus as WorkboardStatus)
      ? (record.fromStatus as WorkboardStatus)
      : undefined;
  const toStatus =
    typeof record.toStatus === "string" &&
    WORKBOARD_STATUSES.includes(record.toStatus as WorkboardStatus)
      ? (record.toStatus as WorkboardStatus)
      : undefined;
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  return {
    id,
    kind,
    at,
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

function normalizeEvents(value: unknown): WorkboardEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeEvent)
    .filter((event): event is WorkboardEvent => event !== null)
    .slice(-MAX_CARD_EVENTS);
}

function normalizeAttempt(value: unknown): WorkboardRunAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const startedAt = normalizeTimestamp(record.startedAt, 0);
  if (!id || !startedAt) {
    return null;
  }
  const endedAt = normalizeTimestamp(record.endedAt, 0);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  const error = normalizeBoundedString(record.error, undefined, 800, "attempt error");
  const model = normalizeBoundedString(record.model, undefined, 160, "attempt model");
  return {
    id,
    status: normalizeAttemptStatus(record.status, "running"),
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    ...(typeof record.engine === "string" &&
    WORKBOARD_EXECUTION_ENGINES.includes(record.engine as WorkboardExecutionEngine)
      ? { engine: record.engine as WorkboardExecutionEngine }
      : {}),
    ...(typeof record.mode === "string" &&
    WORKBOARD_EXECUTION_MODES.includes(record.mode as WorkboardExecutionMode)
      ? { mode: record.mode as WorkboardExecutionMode }
      : {}),
    ...(model ? { model } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(error ? { error } : {}),
  };
}

function normalizeComment(value: unknown): WorkboardComment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const body = normalizeBoundedString(record.body, undefined, 2000, "comment body");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !body || !createdAt) {
    return null;
  }
  const updatedAt = normalizeTimestamp(record.updatedAt, 0);
  return { id, body, createdAt, ...(updatedAt ? { updatedAt } : {}) };
}

function normalizeLink(value: unknown): WorkboardLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !createdAt) {
    return null;
  }
  const targetCardId = normalizeBoundedString(record.targetCardId, undefined, 120, "link target");
  const title = normalizeBoundedString(record.title, undefined, 180, "link title");
  const url = normalizeBoundedString(record.url, undefined, 2000, "link URL");
  if (!targetCardId && !url) {
    return null;
  }
  return {
    id,
    type: normalizeLinkType(record.type, "relates_to"),
    createdAt,
    ...(targetCardId ? { targetCardId } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
  };
}

function isDependencyLink(link: WorkboardLink): boolean {
  return link.type === "parent" || link.type === "child";
}

function normalizeProof(value: unknown): WorkboardProof | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !createdAt) {
    return null;
  }
  const label = normalizeBoundedString(record.label, undefined, 160, "proof label");
  const command = normalizeBoundedString(record.command, undefined, 1000, "proof command");
  const url = normalizeBoundedString(record.url, undefined, 2000, "proof URL");
  const note = normalizeBoundedString(record.note, undefined, 2000, "proof note");
  return {
    id,
    status: normalizeProofStatus(record.status, "unknown"),
    createdAt,
    ...(label ? { label } : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeArtifact(value: unknown): WorkboardArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id) ?? randomUUID();
  const createdAt = normalizeTimestamp(record.createdAt, Date.now());
  const label = normalizeBoundedString(record.label, undefined, 160, "artifact label");
  const url = normalizeBoundedString(record.url, undefined, 2000, "artifact URL");
  const artifactPath = normalizeBoundedString(record.path, undefined, 2000, "artifact path");
  const mimeType = normalizeBoundedString(record.mimeType, undefined, 160, "artifact MIME type");
  if (!url && !artifactPath) {
    return null;
  }
  return {
    id,
    createdAt,
    ...(label ? { label } : {}),
    ...(url ? { url } : {}),
    ...(artifactPath ? { path: artifactPath } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

function normalizeAttachment(value: unknown): WorkboardAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const cardId = normalizeBoundedString(record.cardId, undefined, 120, "card id");
  const fileName = normalizeBoundedString(record.fileName, undefined, 240, "attachment file name");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  const byteSize =
    typeof record.byteSize === "number" && Number.isFinite(record.byteSize)
      ? Math.max(0, Math.trunc(record.byteSize))
      : 0;
  if (!id || !cardId || !fileName || !createdAt || byteSize <= 0) {
    return null;
  }
  const mimeType = normalizeBoundedString(record.mimeType, undefined, 160, "attachment MIME type");
  const note = normalizeBoundedString(record.note, undefined, 400, "attachment note");
  return {
    id,
    cardId,
    createdAt,
    fileName,
    byteSize,
    ...(mimeType ? { mimeType } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeWorkerLog(value: unknown): WorkboardWorkerLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const message = normalizeBoundedString(record.message, undefined, 800, "worker log message");
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !message || !createdAt) {
    return null;
  }
  const level =
    record.level === "warning" || record.level === "error" || record.level === "info"
      ? record.level
      : "info";
  const sessionKey = normalizeBoundedString(record.sessionKey, undefined, 240, "session key");
  const runId = normalizeBoundedString(record.runId, undefined, 160, "run id");
  return {
    id,
    level,
    message,
    createdAt,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

function normalizeWorkerProtocol(
  value: unknown,
  fallback?: WorkboardWorkerProtocol,
): WorkboardWorkerProtocol | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const state =
    record.state === "idle" ||
    record.state === "running" ||
    record.state === "completed" ||
    record.state === "blocked" ||
    record.state === "violated"
      ? record.state
      : fallback?.state;
  if (!state) {
    return undefined;
  }
  const updatedAt = normalizeTimestamp(record.updatedAt, fallback?.updatedAt ?? Date.now());
  const detail = normalizeBoundedString(record.detail, fallback?.detail, 800, "protocol detail");
  return {
    state,
    updatedAt,
    ...(detail ? { detail } : {}),
  };
}

function normalizeAttachmentInput(
  cardId: string,
  input: WorkboardAttachmentInput,
  now: number,
): { attachment: WorkboardAttachment; contentBase64: string } {
  const fileName = normalizeBoundedString(input.fileName, undefined, 240, "attachment file name");
  if (!fileName) {
    throw new Error("attachment fileName is required.");
  }
  const contentBase64 =
    typeof input.contentBase64 === "string" && input.contentBase64
      ? input.contentBase64
      : undefined;
  if (!contentBase64) {
    throw new Error("attachment contentBase64 is required.");
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) ||
    contentBase64.length % 4 !== 0 ||
    contentBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
  ) {
    throw new Error("attachment contentBase64 must be canonical base64.");
  }
  const decoded = Buffer.from(contentBase64, "base64");
  if (decoded.toString("base64") !== contentBase64) {
    throw new Error("attachment contentBase64 must be canonical base64.");
  }
  const byteSize = decoded.length;
  if (byteSize <= 0 || byteSize > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`);
  }
  const mimeType = normalizeBoundedString(input.mimeType, undefined, 160, "attachment MIME type");
  const note = normalizeBoundedString(input.note, undefined, 400, "attachment note");
  const attachment: WorkboardAttachment = {
    id: randomUUID(),
    cardId,
    createdAt: now,
    fileName,
    byteSize,
    ...(mimeType ? { mimeType } : {}),
    ...(note ? { note } : {}),
  };
  return { attachment, contentBase64 };
}

function normalizeClaim(value: unknown, fallback?: WorkboardClaim): WorkboardClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const ownerId = normalizeBoundedString(record.ownerId, fallback?.ownerId, 120, "claim owner");
  const token = normalizeBoundedString(record.token, fallback?.token, 160, "claim token");
  const claimedAt = normalizeTimestamp(record.claimedAt, fallback?.claimedAt ?? Date.now());
  const lastHeartbeatAt = normalizeTimestamp(
    record.lastHeartbeatAt,
    fallback?.lastHeartbeatAt ?? claimedAt,
  );
  const expiresAt = normalizeTimestamp(record.expiresAt, fallback?.expiresAt ?? 0);
  if (!ownerId || !token || !claimedAt || !lastHeartbeatAt) {
    return undefined;
  }
  return {
    ownerId,
    token,
    claimedAt,
    lastHeartbeatAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function normalizeDiagnosticAction(value: unknown): WorkboardDiagnosticAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "claim" ||
    record.kind === "unblock" ||
    record.kind === "reassign" ||
    record.kind === "add_proof" ||
    record.kind === "open_session"
      ? record.kind
      : undefined;
  const label = normalizeBoundedString(record.label, undefined, 120, "diagnostic action label");
  return kind && label ? { kind, label } : null;
}

function normalizeDiagnostic(value: unknown): WorkboardDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = WORKBOARD_DIAGNOSTIC_KINDS.includes(record.kind as WorkboardDiagnosticKind)
    ? (record.kind as WorkboardDiagnosticKind)
    : undefined;
  const severity = WORKBOARD_DIAGNOSTIC_SEVERITIES.includes(
    record.severity as WorkboardDiagnosticSeverity,
  )
    ? (record.severity as WorkboardDiagnosticSeverity)
    : "warning";
  const title = normalizeBoundedString(record.title, undefined, 160, "diagnostic title");
  const detail = normalizeBoundedString(record.detail, undefined, 800, "diagnostic detail");
  const firstSeenAt = normalizeTimestamp(record.firstSeenAt, Date.now());
  const lastSeenAt = normalizeTimestamp(record.lastSeenAt, firstSeenAt);
  if (!kind || !title || !detail) {
    return null;
  }
  return {
    kind,
    severity,
    title,
    detail,
    firstSeenAt,
    lastSeenAt,
    count:
      typeof record.count === "number" && Number.isFinite(record.count)
        ? Math.max(1, Math.trunc(record.count))
        : 1,
    actions: Array.isArray(record.actions)
      ? record.actions
          .map(normalizeDiagnosticAction)
          .filter((action): action is WorkboardDiagnosticAction => action !== null)
          .slice(0, 4)
      : [],
  };
}

function normalizeNotification(value: unknown): WorkboardNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeOptionalString(record.id) ?? randomUUID();
  const kind = WORKBOARD_NOTIFICATION_KINDS.includes(record.kind as WorkboardNotificationKind)
    ? (record.kind as WorkboardNotificationKind)
    : undefined;
  const createdAt = normalizeTimestamp(record.createdAt, Date.now());
  const sequence = normalizeTimestamp(record.sequence, 0) || undefined;
  const message = normalizeBoundedString(record.message, undefined, 240, "notification message");
  if (!kind || !message) {
    return null;
  }
  const sessionKey = normalizeBoundedString(record.sessionKey, undefined, 240, "session key");
  const runId = normalizeBoundedString(record.runId, undefined, 120, "run id");
  return {
    id,
    kind,
    createdAt,
    ...(sequence ? { sequence } : {}),
    message,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

function normalizeProofInput(input: WorkboardProofInput, now: number): WorkboardProof {
  const label = normalizeBoundedString(input.label, undefined, 160, "proof label");
  const command = normalizeBoundedString(input.command, undefined, 1000, "proof command");
  const url = normalizeBoundedString(input.url, undefined, 2000, "proof URL");
  const note = normalizeBoundedString(input.note, undefined, 2000, "proof note");
  return {
    id: randomUUID(),
    status: normalizeProofStatus(input.status, "unknown"),
    createdAt: now,
    ...(label ? { label } : {}),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeMetadata(
  value: unknown,
  fallback: WorkboardMetadata = {},
  options: { allowDependencyLinks?: boolean } = {},
): WorkboardMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return trimMetadataToBudget(fallback);
  }
  const record = value as Record<string, unknown>;
  const stale =
    record.stale && typeof record.stale === "object" && !Array.isArray(record.stale)
      ? (record.stale as Record<string, unknown>)
      : null;
  const hasArchivedAt = Object.hasOwn(record, "archivedAt");
  const hasStale = Object.hasOwn(record, "stale");
  const hasLifecycleStatusSourceUpdatedAt = Object.hasOwn(record, "lifecycleStatusSourceUpdatedAt");
  const links = Array.isArray(record.links)
    ? record.links.map(normalizeLink).filter((link): link is WorkboardLink => link !== null)
    : undefined;
  const normalizedLinks =
    links === undefined
      ? fallback.links
      : options.allowDependencyLinks === false
        ? (() => {
            const dependencyLinks = (fallback.links ?? []).filter(isDependencyLink);
            const ordinaryCapacity = Math.max(0, MAX_CARD_LINKS - dependencyLinks.length);
            return [
              ...dependencyLinks.slice(-MAX_CARD_LINKS),
              ...(ordinaryCapacity > 0
                ? links.filter((link) => !isDependencyLink(link)).slice(-ordinaryCapacity)
                : []),
            ];
          })()
        : links.slice(-MAX_CARD_LINKS);
  return trimMetadataToBudget({
    attempts: Array.isArray(record.attempts)
      ? record.attempts
          .map(normalizeAttempt)
          .filter((attempt): attempt is WorkboardRunAttempt => attempt !== null)
          .slice(-MAX_CARD_ATTEMPTS)
      : fallback.attempts,
    comments: Array.isArray(record.comments)
      ? record.comments
          .map(normalizeComment)
          .filter((comment): comment is WorkboardComment => comment !== null)
          .slice(-MAX_CARD_COMMENTS)
      : fallback.comments,
    links: normalizedLinks,
    proof: Array.isArray(record.proof)
      ? record.proof
          .map(normalizeProof)
          .filter((proof): proof is WorkboardProof => proof !== null)
          .slice(-MAX_CARD_PROOF)
      : fallback.proof,
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts
          .map(normalizeArtifact)
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : fallback.artifacts,
    attachments: Array.isArray(record.attachments)
      ? record.attachments
          .map(normalizeAttachment)
          .filter((attachment): attachment is WorkboardAttachment => attachment !== null)
          .slice(-MAX_CARD_ATTACHMENTS)
      : fallback.attachments,
    workerLogs: Array.isArray(record.workerLogs)
      ? record.workerLogs
          .map(normalizeWorkerLog)
          .filter((log): log is WorkboardWorkerLog => log !== null)
          .slice(-MAX_CARD_WORKER_LOGS)
      : fallback.workerLogs,
    workerProtocol: Object.hasOwn(record, "workerProtocol")
      ? normalizeWorkerProtocol(record.workerProtocol, fallback.workerProtocol)
      : fallback.workerProtocol,
    automation: Object.hasOwn(record, "automation")
      ? normalizeAutomation(record.automation, fallback.automation)
      : fallback.automation,
    claim: Object.hasOwn(record, "claim")
      ? record.claim
        ? normalizeClaim(record.claim, fallback.claim)
        : undefined
      : fallback.claim,
    diagnostics: Array.isArray(record.diagnostics)
      ? record.diagnostics
          .map(normalizeDiagnostic)
          .filter(
            (diagnosticLocal): diagnosticLocal is WorkboardDiagnostic => diagnosticLocal !== null,
          )
          .slice(-MAX_CARD_DIAGNOSTICS)
      : fallback.diagnostics,
    notifications: Array.isArray(record.notifications)
      ? record.notifications
          .map(normalizeNotification)
          .filter((notification): notification is WorkboardNotification => notification !== null)
          .slice(-MAX_CARD_NOTIFICATIONS)
      : fallback.notifications,
    templateId: normalizeTemplateId(record.templateId) ?? fallback.templateId,
    archivedAt: hasArchivedAt
      ? normalizeTimestamp(record.archivedAt, 0) || undefined
      : fallback.archivedAt,
    stale: hasStale
      ? stale
        ? {
            detectedAt: normalizeTimestamp(stale.detectedAt, Date.now()),
            lastSessionUpdatedAt: normalizeTimestamp(stale.lastSessionUpdatedAt, 0) || undefined,
            reason:
              normalizeBoundedString(stale.reason, fallback.stale?.reason, 240, "stale reason") ??
              "Session has not reported recent activity.",
          }
        : undefined
      : fallback.stale,
    lifecycleStatusSourceUpdatedAt: hasLifecycleStatusSourceUpdatedAt
      ? normalizeTimestamp(record.lifecycleStatusSourceUpdatedAt, 0)
      : fallback.lifecycleStatusSourceUpdatedAt,
    failureCount:
      typeof record.failureCount === "number" && Number.isFinite(record.failureCount)
        ? Math.max(0, Math.trunc(record.failureCount))
        : fallback.failureCount,
  });
}

function normalizeExecution(value: unknown): WorkboardExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const now = Date.now();
  const model = normalizeOptionalString(record.model);
  const id = normalizeOptionalString(record.id) ?? randomUUID();
  if (!model) {
    return undefined;
  }
  const startedAt = normalizeTimestamp(record.startedAt, now);
  const updatedAt = normalizeTimestamp(record.updatedAt, startedAt);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const runId = normalizeOptionalString(record.runId);
  return {
    id,
    kind: "agent-session",
    engine: normalizeExecutionEngine(record.engine, "codex"),
    mode: normalizeExecutionMode(record.mode, "autonomous"),
    status: normalizeExecutionStatus(record.status, "idle"),
    model,
    startedAt,
    updatedAt,
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
  };
}

function syncExecutionSessionKey(
  execution: WorkboardExecution | undefined,
  sessionKey: string | undefined,
): WorkboardExecution | undefined {
  if (!execution) {
    return undefined;
  }
  return removeUndefinedExecutionFields({
    ...execution,
    sessionKey,
    updatedAt: Date.now(),
  });
}

function removeUndefinedExecutionFields(execution: WorkboardExecution): WorkboardExecution {
  const next = { ...execution };
  if (next.sessionKey === undefined) {
    delete next.sessionKey;
  }
  if (next.runId === undefined) {
    delete next.runId;
  }
  return next;
}

function removeUndefinedAutomationFields(automation: WorkboardAutomation): WorkboardAutomation {
  const next = { ...automation };
  for (const key of [
    "tenant",
    "boardId",
    "createdByCardId",
    "idempotencyKey",
    "skills",
    "workspace",
    "maxRuntimeSeconds",
    "maxRetries",
    "scheduledAt",
    "summary",
    "createdCardIds",
    "dispatchCount",
    "lastDispatchAt",
  ] as const) {
    const value = next[key];
    if (
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && value !== null && Object.keys(value).length === 0)
    ) {
      delete next[key];
    }
  }
  return next;
}

function removeUndefinedMetadataFields(metadata: WorkboardMetadata): WorkboardMetadata {
  const next = { ...metadata };
  for (const key of [
    "attempts",
    "comments",
    "links",
    "proof",
    "artifacts",
    "attachments",
    "workerLogs",
    "workerProtocol",
    "automation",
    "claim",
    "diagnostics",
    "notifications",
    "templateId",
    "archivedAt",
    "stale",
    "lifecycleStatusSourceUpdatedAt",
    "failureCount",
  ] as const) {
    const value = next[key];
    if (
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === "number" && value === 0 && key === "failureCount")
    ) {
      delete next[key];
    }
  }
  return next;
}

function clearDiagnostics(
  metadata: WorkboardMetadata | undefined,
  kinds: readonly WorkboardDiagnosticKind[],
): WorkboardMetadata {
  if (!metadata?.diagnostics) {
    return metadata ?? {};
  }
  return {
    ...metadata,
    diagnostics: metadata.diagnostics.filter((entry) => !kinds.includes(entry.kind)),
  };
}

function metadataIsEmpty(metadata: WorkboardMetadata | undefined): boolean {
  return !metadata || Object.keys(metadata).length === 0;
}

function metadataByteSize(metadata: WorkboardMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

function dropFirst<T>(items: readonly T[] | undefined): T[] | undefined {
  if (!items?.length) {
    return undefined;
  }
  const next = items.slice(1);
  return next.length ? next : undefined;
}

function dropFirstNonDependencyLink(
  items: readonly WorkboardLink[] | undefined,
): WorkboardLink[] | undefined {
  if (!items?.length) {
    return undefined;
  }
  const index = items.findIndex((link) => !isDependencyLink(link));
  if (index < 0) {
    return items.slice();
  }
  const next = items.filter((_, itemIndex) => itemIndex !== index);
  return next.length ? next : undefined;
}

function appendLinkPreservingDependencies(
  links: readonly WorkboardLink[],
  link: WorkboardLink,
): WorkboardLink[] {
  const next = [...links, link];
  if (next.length <= MAX_CARD_LINKS) {
    return next;
  }
  const dropIndex = next.findIndex((entry) => !isDependencyLink(entry));
  if (dropIndex < 0 || dropIndex === next.length - 1) {
    throw new Error("card link limit reached.");
  }
  return next.filter((_, index) => index !== dropIndex);
}

function trimMetadataToBudget(metadata: WorkboardMetadata): WorkboardMetadata {
  let next = removeUndefinedMetadataFields(metadata);
  while (metadataByteSize(next) > MAX_CARD_METADATA_BYTES) {
    const currentSize = metadataByteSize(next);
    if (next.attempts?.length) {
      next = removeUndefinedMetadataFields({ ...next, attempts: dropFirst(next.attempts) });
    } else if (next.diagnostics?.length) {
      next = removeUndefinedMetadataFields({ ...next, diagnostics: dropFirst(next.diagnostics) });
    } else if (next.notifications?.length) {
      next = removeUndefinedMetadataFields({
        ...next,
        notifications: dropFirst(next.notifications),
      });
    } else if (next.proof?.length) {
      next = removeUndefinedMetadataFields({ ...next, proof: dropFirst(next.proof) });
    } else if (next.artifacts?.length) {
      next = removeUndefinedMetadataFields({ ...next, artifacts: dropFirst(next.artifacts) });
    } else if (next.attachments?.length) {
      next = removeUndefinedMetadataFields({
        ...next,
        attachments: dropFirst(next.attachments),
      });
    } else if (next.workerLogs?.length) {
      next = removeUndefinedMetadataFields({ ...next, workerLogs: dropFirst(next.workerLogs) });
    } else if (next.links?.length) {
      const links = dropFirstNonDependencyLink(next.links);
      if (links?.length === next.links.length) {
        next = removeUndefinedMetadataFields({ ...next, comments: dropFirst(next.comments) });
      } else {
        next = removeUndefinedMetadataFields({ ...next, links });
      }
    } else if (next.comments?.length) {
      next = removeUndefinedMetadataFields({ ...next, comments: dropFirst(next.comments) });
    }
    if (metadataByteSize(next) >= currentSize) {
      break;
    }
  }
  return next;
}

function compareCards(left: WorkboardCard, right: WorkboardCard): number {
  if (left.status !== right.status) {
    return WORKBOARD_STATUSES.indexOf(left.status) - WORKBOARD_STATUSES.indexOf(right.status);
  }
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  return left.createdAt - right.createdAt;
}

function cardSessionKey(card: WorkboardCard): string | undefined {
  return card.sessionKey ?? card.execution?.sessionKey;
}

function cardRunId(card: WorkboardCard): string | undefined {
  return card.runId ?? card.execution?.runId;
}

function executionAttemptStatus(execution: WorkboardExecution): WorkboardAttemptStatus {
  if (execution.status === "running") {
    return "running";
  }
  if (execution.status === "blocked") {
    return "blocked";
  }
  if (execution.status === "done" || execution.status === "review") {
    return "succeeded";
  }
  return "stopped";
}

function syncExecutionAttemptMetadata(
  metadata: WorkboardMetadata,
  execution: WorkboardExecution | undefined,
  now: number,
): WorkboardMetadata {
  if (!execution) {
    return metadata;
  }
  const attemptStatus = executionAttemptStatus(execution);
  const attempts = [...(metadata.attempts ?? [])];
  const key = execution.runId ?? execution.sessionKey ?? execution.id;
  const existingIndex = attempts.findIndex(
    (attempt) =>
      (execution.runId && attempt.runId === execution.runId) ||
      (!execution.runId && attempt.id === key),
  );
  const existingAttempt = existingIndex >= 0 ? attempts[existingIndex] : undefined;
  const nextAttempt: WorkboardRunAttempt = {
    id: existingAttempt?.id ?? key,
    status: attemptStatus,
    startedAt: existingAttempt?.startedAt ?? execution.startedAt,
    engine: execution.engine,
    mode: execution.mode,
    model: execution.model,
    ...(execution.sessionKey ? { sessionKey: execution.sessionKey } : {}),
    ...(execution.runId ? { runId: execution.runId } : {}),
    ...(attemptStatus !== "running" && { endedAt: execution.updatedAt || now }),
    ...(attemptStatus !== "succeeded" && existingAttempt?.error
      ? { error: existingAttempt.error }
      : {}),
  };
  if (existingIndex >= 0) {
    attempts[existingIndex] = nextAttempt;
  } else {
    attempts.push(nextAttempt);
  }
  const previousFailed =
    existingAttempt?.status === "blocked" || existingAttempt?.status === "failed";
  const attemptFailed = attemptStatus === "blocked" || attemptStatus === "failed";
  const failureCount = attemptFailed
    ? previousFailed
      ? metadata.failureCount
      : (metadata.failureCount ?? 0) + 1
    : attemptStatus === "succeeded"
      ? 0
      : metadata.failureCount;
  return removeUndefinedMetadataFields({
    ...metadata,
    attempts: attempts.slice(-MAX_CARD_ATTEMPTS),
    failureCount,
  });
}

function appendEvent(
  card: WorkboardCard,
  event: Omit<WorkboardEvent, "id" | "at">,
  at = Date.now(),
): WorkboardEvent[] {
  return [
    ...normalizeEvents(card.events),
    {
      id: randomUUID(),
      at,
      ...event,
    },
  ].slice(-MAX_CARD_EVENTS);
}

function latestMetadataIdChanged(
  existing: readonly { id: string }[] | undefined,
  next: readonly { id: string }[] | undefined,
): boolean {
  const latestId = next?.at(-1)?.id;
  return Boolean(latestId && latestId !== existing?.at(-1)?.id);
}

function lifecycleStatusSourceUpdatedAtFromPatch(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  if (!Object.hasOwn(metadata, "lifecycleStatusSourceUpdatedAt")) {
    return undefined;
  }
  const sourceUpdatedAt = normalizeTimestamp(
    (metadata as Record<string, unknown>).lifecycleStatusSourceUpdatedAt,
    0,
  );
  return sourceUpdatedAt;
}

function latestStatusTransitionAt(card: WorkboardCard): number | undefined {
  for (let index = (card.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = card.events?.[index];
    if (
      (event?.kind === "moved" || event?.kind === "created") &&
      ((event.kind === "created" && card.status !== "todo") ||
        (event.kind === "moved" && event.fromStatus !== event.toStatus)) &&
      event.toStatus === card.status &&
      typeof event.at === "number" &&
      Number.isFinite(event.at)
    ) {
      return event.at;
    }
  }
  return undefined;
}

function shouldSkipPersistedLifecycleStatusUpdate(
  existing: WorkboardCard,
  sourceUpdatedAt: number,
): boolean {
  const lifecycleStatusSourceUpdatedAt = existing.metadata?.lifecycleStatusSourceUpdatedAt;
  if (lifecycleStatusSourceUpdatedAt !== undefined) {
    return sourceUpdatedAt < lifecycleStatusSourceUpdatedAt;
  }
  const statusTransitionAt = latestStatusTransitionAt(existing);
  return statusTransitionAt !== undefined && sourceUpdatedAt < statusTransitionAt;
}

function updateEvent(
  existing: WorkboardCard,
  next: WorkboardCard,
): Omit<WorkboardEvent, "id" | "at"> {
  if (
    existing.metadata?.workerProtocol?.state !== next.metadata?.workerProtocol?.state &&
    next.metadata?.workerProtocol?.state === "violated"
  ) {
    return { kind: "protocol_violation" };
  }
  if (existing.status !== next.status || existing.position !== next.position) {
    return {
      kind: "moved",
      fromStatus: existing.status,
      toStatus: next.status,
    };
  }
  if (cardSessionKey(existing) !== cardSessionKey(next)) {
    return {
      kind: "linked",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
    };
  }
  if (existing.metadata?.claim?.token !== next.metadata?.claim?.token) {
    return { kind: "claimed" };
  }
  if (existing.metadata?.claim?.lastHeartbeatAt !== next.metadata?.claim?.lastHeartbeatAt) {
    return { kind: "heartbeat" };
  }
  if (
    existing.execution?.status !== next.execution?.status ||
    existing.execution?.engine !== next.execution?.engine ||
    cardRunId(existing) !== cardRunId(next)
  ) {
    const existingAttempts = existing.metadata?.attempts ?? [];
    const nextAttempts = next.metadata?.attempts ?? [];
    const latestAttempt = nextAttempts.at(-1);
    if (nextAttempts.length > existingAttempts.length) {
      return {
        kind: "attempt_started",
        ...(latestAttempt?.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt?.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    const previousAttempt = latestAttempt
      ? existingAttempts.find((attempt) => attempt.id === latestAttempt.id)
      : undefined;
    if (latestAttempt && previousAttempt?.status !== latestAttempt.status) {
      return {
        kind: "attempt_updated",
        ...(latestAttempt.sessionKey ? { sessionKey: latestAttempt.sessionKey } : {}),
        ...(latestAttempt.runId ? { runId: latestAttempt.runId } : {}),
      };
    }
    return {
      kind: "execution_updated",
      ...(cardSessionKey(next) ? { sessionKey: cardSessionKey(next) } : {}),
      ...(cardRunId(next) ? { runId: cardRunId(next) } : {}),
    };
  }
  if (
    (existing.metadata?.comments?.length ?? 0) !== (next.metadata?.comments?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.comments, next.metadata?.comments)
  ) {
    return { kind: "comment_added" };
  }
  if (
    (existing.metadata?.links?.length ?? 0) !== (next.metadata?.links?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.links, next.metadata?.links)
  ) {
    return { kind: "link_added" };
  }
  if (
    (existing.metadata?.proof?.length ?? 0) !== (next.metadata?.proof?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.proof, next.metadata?.proof)
  ) {
    return { kind: "proof_added" };
  }
  if (
    (existing.metadata?.artifacts?.length ?? 0) !== (next.metadata?.artifacts?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.artifacts, next.metadata?.artifacts)
  ) {
    return { kind: "artifact_added" };
  }
  if (
    (existing.metadata?.attachments?.length ?? 0) !== (next.metadata?.attachments?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.attachments, next.metadata?.attachments)
  ) {
    return (next.metadata?.attachments?.length ?? 0) > (existing.metadata?.attachments?.length ?? 0)
      ? { kind: "attachment_added" }
      : { kind: "edited" };
  }
  if (existing.metadata?.workerProtocol?.state !== next.metadata?.workerProtocol?.state) {
    return { kind: "orchestration" };
  }
  if (
    (existing.metadata?.workerLogs?.length ?? 0) !== (next.metadata?.workerLogs?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.workerLogs, next.metadata?.workerLogs)
  ) {
    return { kind: "orchestration" };
  }
  if ((existing.metadata?.diagnostics?.length ?? 0) !== (next.metadata?.diagnostics?.length ?? 0)) {
    return { kind: "diagnostic" };
  }
  if (
    (existing.metadata?.notifications?.length ?? 0) !==
      (next.metadata?.notifications?.length ?? 0) ||
    latestMetadataIdChanged(existing.metadata?.notifications, next.metadata?.notifications)
  ) {
    return { kind: "notification" };
  }
  if (
    existing.metadata?.automation?.dispatchCount !== next.metadata?.automation?.dispatchCount ||
    existing.metadata?.automation?.lastDispatchAt !== next.metadata?.automation?.lastDispatchAt
  ) {
    return { kind: "dispatch" };
  }
  if (!existing.metadata?.archivedAt && next.metadata?.archivedAt) {
    return { kind: "archived" };
  }
  if (existing.metadata?.archivedAt && !next.metadata?.archivedAt) {
    return { kind: "unarchived" };
  }
  if (!existing.metadata?.stale && next.metadata?.stale) {
    return { kind: "stale" };
  }
  return { kind: "edited" };
}

function removeUndefinedCardFields(card: WorkboardCard): WorkboardCard {
  const next = { ...card };
  for (const key of [
    "notes",
    "agentId",
    "sessionKey",
    "runId",
    "taskId",
    "sourceUrl",
    "execution",
    "startedAt",
    "completedAt",
    "metadata",
  ] as const) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  if (metadataIsEmpty(next.metadata)) {
    delete next.metadata;
  }
  return next;
}

function assertCanMutateClaimedCard(
  card: WorkboardCard,
  scope: WorkboardMutationScope | undefined,
) {
  if (!scope) {
    return;
  }
  const claim = card.metadata?.claim;
  if (!claim) {
    return;
  }
  const ownerId = normalizeOptionalString(scope.ownerId);
  const token = normalizeOptionalString(scope.token);
  if (claim.ownerId === ownerId || (token && claim.token === token)) {
    return;
  }
  throw new Error(`card is claimed by ${claim.ownerId}.`);
}

function retryBudgetExhausted(card: WorkboardCard): boolean {
  const maxRetries = card.metadata?.automation?.maxRetries;
  return Boolean(maxRetries && (card.metadata?.failureCount ?? 0) > maxRetries);
}

function diagnostic(
  params: {
    kind: WorkboardDiagnosticKind;
    severity: WorkboardDiagnosticSeverity;
    title: string;
    detail: string;
    actions: WorkboardDiagnosticAction[];
  },
  now: number,
): WorkboardDiagnostic {
  return {
    ...params,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  };
}

function mergeDiagnostics(
  previous: readonly WorkboardDiagnostic[] | undefined,
  next: WorkboardDiagnostic[],
): WorkboardDiagnostic[] {
  const byKind = new Map(previous?.map((entry) => [entry.kind, entry]));
  return next.map((entry) => {
    const prior = byKind.get(entry.kind);
    return prior
      ? {
          ...entry,
          firstSeenAt: prior.firstSeenAt,
          count: prior.count + 1,
        }
      : entry;
  });
}

function computeCardDiagnostics(card: WorkboardCard, now: number): WorkboardDiagnostic[] {
  const diagnostics: WorkboardDiagnostic[] = [];
  const claim = card.metadata?.claim;
  const lastHeartbeatAt = claim?.lastHeartbeatAt ?? card.execution?.updatedAt ?? card.updatedAt;
  if (
    (card.status === "todo" || card.status === "backlog" || card.status === "ready") &&
    card.agentId &&
    now - card.updatedAt > READY_STRANDED_MS
  ) {
    diagnostics.push(
      diagnostic(
        {
          kind: "stranded_ready",
          severity: "warning",
          title: "Assigned card is waiting",
          detail: "The card has an assigned agent but has not been claimed recently.",
          actions: [{ kind: "claim", label: "Claim card" }],
        },
        now,
      ),
    );
  }
  if (card.status === "running" && now - lastHeartbeatAt > RUNNING_HEARTBEAT_STALE_MS) {
    diagnostics.push(
      diagnostic(
        {
          kind: "running_without_heartbeat",
          severity: "error",
          title: "Running card has no recent heartbeat",
          detail: "The linked run or claim has not reported recent activity.",
          actions: [
            { kind: "open_session", label: "Open session" },
            { kind: "reassign", label: "Reassign card" },
          ],
        },
        now,
      ),
    );
  }
  if (card.status === "blocked" && now - card.updatedAt > BLOCKED_TOO_LONG_MS) {
    diagnostics.push(
      diagnostic(
        {
          kind: "blocked_too_long",
          severity: "warning",
          title: "Blocked card needs attention",
          detail: "The card has been blocked for more than a day.",
          actions: [{ kind: "unblock", label: "Move to todo" }],
        },
        now,
      ),
    );
  }
  if ((card.metadata?.failureCount ?? 0) >= 2) {
    diagnostics.push(
      diagnostic(
        {
          kind: "repeated_failures",
          severity: "error",
          title: "Repeated run failures",
          detail: "Multiple attempts failed or blocked on this card.",
          actions: [{ kind: "reassign", label: "Reassign card" }],
        },
        now,
      ),
    );
  }
  if (
    card.status === "done" &&
    !(
      card.metadata?.proof?.length ||
      card.metadata?.artifacts?.length ||
      card.metadata?.attachments?.length
    )
  ) {
    diagnostics.push(
      diagnostic(
        {
          kind: "missing_proof",
          severity: "warning",
          title: "Done card has no proof",
          detail: "The card is marked done without proof or an attached artifact.",
          actions: [{ kind: "add_proof", label: "Add proof" }],
        },
        now,
      ),
    );
  }
  if (card.sessionKey && !card.execution && card.status === "running") {
    diagnostics.push(
      diagnostic(
        {
          kind: "orphaned_session",
          severity: "warning",
          title: "Running card has only a loose session link",
          detail: "The card is running but has no execution record for lifecycle handoff.",
          actions: [{ kind: "open_session", label: "Open session" }],
        },
        now,
      ),
    );
  }
  return diagnostics;
}

function capText(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function cardResultSummary(card: WorkboardCard): string | undefined {
  return (
    card.metadata?.automation?.summary ??
    card.metadata?.comments?.findLast((comment) => comment.body.trim())?.body ??
    card.metadata?.proof?.findLast((proof) => proof.note?.trim())?.note
  );
}

function buildWorkerContext(card: WorkboardCard, cards: readonly WorkboardCard[] = []): string {
  const lines = [
    `# Workboard card ${card.id}`,
    `Title: ${card.title}`,
    `Status: ${card.status}`,
    `Priority: ${card.priority}`,
    `Board: ${cardBoardId(card)}`,
    `Agent: ${card.agentId ?? "(default)"}`,
  ];
  if (card.notes) {
    lines.push("", "## Notes", capText(card.notes, 4000) ?? "");
  }
  const attempts = card.metadata?.attempts?.slice(-8) ?? [];
  if (attempts.length) {
    lines.push("", "## Recent attempts");
    for (const attempt of attempts) {
      lines.push(
        `- ${attempt.status} ${attempt.model ?? ""} ${attempt.error ? `error=${capText(attempt.error, 240)}` : ""}`.trim(),
      );
    }
  }
  const comments = card.metadata?.comments?.slice(-12) ?? [];
  if (comments.length) {
    lines.push("", "## Recent comments");
    for (const comment of comments) {
      lines.push(`- ${capText(comment.body, 400)}`);
    }
  }
  const proof = card.metadata?.proof?.slice(-8) ?? [];
  if (proof.length) {
    lines.push("", "## Proof");
    for (const entry of proof) {
      lines.push(
        `- ${entry.status}: ${capText(entry.label ?? entry.command ?? entry.url ?? entry.note, 400)}`,
      );
    }
  }
  const artifacts = card.metadata?.artifacts?.slice(-8) ?? [];
  if (artifacts.length) {
    lines.push("", "## Artifacts");
    for (const artifact of artifacts) {
      lines.push(`- ${capText(artifact.label ?? artifact.url ?? artifact.path, 400)}`);
    }
  }
  const attachments = card.metadata?.attachments?.slice(-8) ?? [];
  if (attachments.length) {
    lines.push("", "## Attachments");
    for (const attachment of attachments) {
      const detail = [
        attachment.fileName,
        `${attachment.byteSize} bytes`,
        attachment.mimeType,
        attachment.note,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- ${capText(detail, 500)}`);
    }
  }
  if (card.metadata?.workerProtocol) {
    const protocol = card.metadata.workerProtocol;
    lines.push("", "## Worker protocol");
    lines.push(`${protocol.state}: ${capText(protocol.detail, 500) ?? "no detail"}`);
  }
  const workerLogs = card.metadata?.workerLogs?.slice(-8) ?? [];
  if (workerLogs.length) {
    lines.push("", "## Worker logs");
    for (const log of workerLogs) {
      lines.push(`- ${log.level}: ${capText(log.message, 500)}`);
    }
  }
  const links = card.metadata?.links?.slice(-8) ?? [];
  if (links.length) {
    lines.push("", "## Links");
    for (const link of links) {
      lines.push(`- ${link.type}: ${link.title ?? link.url ?? link.targetCardId ?? ""}`);
    }
  }
  const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
  const parentResults = cardParentIds(card)
    .map((parentId) => cardsById.get(parentId))
    .filter((parent): parent is WorkboardCard => parent !== undefined && parent.status === "done")
    .slice(-6);
  if (parentResults.length) {
    lines.push("", "## Parent results");
    for (const parent of parentResults) {
      lines.push(
        `- ${parent.id} ${parent.title}: ${capText(cardResultSummary(parent), 500) ?? "done"}`,
      );
    }
  }
  const recentAgentWork =
    card.agentId && cards.length
      ? cards
          .filter(
            (entry) =>
              entry.id !== card.id &&
              cardBoardId(entry) === cardBoardId(card) &&
              entry.agentId === card.agentId &&
              entry.status === "done",
          )
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 5)
      : [];
  if (recentAgentWork.length) {
    lines.push("", `## Recent done work by ${card.agentId}`);
    for (const entry of recentAgentWork) {
      lines.push(
        `- ${entry.id} ${entry.title}: ${capText(cardResultSummary(entry), 300) ?? "done"}`,
      );
    }
  }
  const automation = card.metadata?.automation;
  if (automation) {
    lines.push("", "## Automation");
    if (automation.tenant) {
      lines.push(`Tenant: ${automation.tenant}`);
    }
    if (automation.boardId) {
      lines.push(`Board: ${automation.boardId}`);
    }
    if (automation.skills?.length) {
      lines.push(`Skills: ${automation.skills.join(", ")}`);
    }
    if (automation.workspace) {
      lines.push(
        `Workspace: ${automation.workspace.kind}${automation.workspace.path ? ` ${automation.workspace.path}` : ""}`,
      );
    }
    if (automation.summary) {
      lines.push(`Summary: ${capText(automation.summary, 400)}`);
    }
  }
  const diagnostics = computeCardDiagnostics(card, Date.now());
  if (diagnostics.length) {
    lines.push("", "## Active diagnostics");
    for (const entry of diagnostics) {
      lines.push(`- ${entry.severity}: ${entry.title}`);
    }
  }
  return lines.join("\n");
}

function cardParentIds(card: WorkboardCard): string[] {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "parent" && link.targetCardId)
    .map((link) => link.targetCardId!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

function cardChildIds(card: WorkboardCard): string[] {
  return (card.metadata?.links ?? [])
    .filter((link) => link.type === "child" && link.targetCardId)
    .map((link) => link.targetCardId!)
    .filter((id, index, ids) => ids.indexOf(id) === index);
}

function latestRunningAttempt(card: WorkboardCard): WorkboardRunAttempt | undefined {
  return card.metadata?.attempts?.findLast((attempt) => attempt.status === "running");
}

function isDependencyPromotableStatus(status: WorkboardStatus): boolean {
  return (
    status === "backlog" ||
    status === "triage" ||
    status === "todo" ||
    status === "scheduled" ||
    status === "ready"
  );
}

function isActiveDependencyTarget(
  card: WorkboardCard,
  options: { allowStatusOnly?: boolean } = {},
): boolean {
  return (
    Boolean(card.metadata?.claim) ||
    card.execution?.status === "running" ||
    Boolean(latestRunningAttempt(card)) ||
    (!options.allowStatusOnly && (card.status === "running" || card.status === "review"))
  );
}

function closeRunningAttempts(
  attempts: WorkboardRunAttempt[] | undefined,
  now: number,
  status: WorkboardAttemptStatus,
  reason?: string,
): WorkboardRunAttempt[] | undefined {
  if (!attempts?.some((attempt) => attempt.status === "running")) {
    return attempts;
  }
  return attempts.map((attempt) =>
    attempt.status === "running"
      ? { ...attempt, status, endedAt: now, ...(reason ? { error: reason } : {}) }
      : attempt,
  );
}

function notificationSequence(event: WorkboardNotification): number | undefined {
  return typeof event.sequence === "number" && Number.isFinite(event.sequence)
    ? Math.trunc(event.sequence)
    : undefined;
}

function compareNotifications(a: WorkboardNotification, b: WorkboardNotification): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  const aSequence = notificationSequence(a);
  const bSequence = notificationSequence(b);
  if (aSequence !== undefined && bSequence !== undefined) {
    return aSequence - bSequence || a.id.localeCompare(b.id);
  }
  if (aSequence !== undefined) {
    return -1;
  }
  if (bSequence !== undefined) {
    return 1;
  }
  return a.id.localeCompare(b.id);
}

export class WorkboardStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private lastNotificationSequence = 0;
  private readonly boardStore: WorkboardKeyedStore<PersistedWorkboardBoard>;
  private readonly subscriptionStore: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
  private readonly attachmentStore: WorkboardKeyedStore<PersistedWorkboardAttachment>;

  constructor(
    private readonly store: WorkboardKeyedStore,
    stores: {
      boards?: WorkboardKeyedStore<PersistedWorkboardBoard>;
      subscriptions?: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
      attachments?: WorkboardKeyedStore<PersistedWorkboardAttachment>;
    } = {},
  ) {
    this.boardStore =
      stores.boards ?? (store as unknown as WorkboardKeyedStore<PersistedWorkboardBoard>);
    this.subscriptionStore =
      stores.subscriptions ??
      (store as unknown as WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>);
    this.attachmentStore =
      stores.attachments ?? (store as unknown as WorkboardKeyedStore<PersistedWorkboardAttachment>);
  }

  private async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async updateMetadata(
    id: string,
    mutate: (existing: WorkboardCard) => WorkboardMetadata,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      return await this.updateCard(id, { metadata: mutate(existing) });
    });
  }

  private async deleteDetachedAttachments(
    existing: WorkboardCard,
    next: WorkboardCard,
  ): Promise<void> {
    const nextIds = new Set(next.metadata?.attachments?.map((attachment) => attachment.id) ?? []);
    for (const attachment of existing.metadata?.attachments ?? []) {
      if (!nextIds.has(attachment.id)) {
        await this.attachmentStore.delete(attachment.id);
      }
    }
  }

  private nextNotificationSequence(now: number): number {
    const base = Math.max(0, Math.trunc(now)) * 1000;
    this.lastNotificationSequence = Math.max(this.lastNotificationSequence + 1, base);
    return this.lastNotificationSequence;
  }

  async list(options: WorkboardListOptions = {}): Promise<WorkboardCard[]> {
    const boardId = normalizeBoardId(options.boardId);
    const entries = await this.store.entries();
    return entries
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedWorkboardCard => entry?.version === 1 && Boolean(entry.card?.id),
      )
      .map((entry) => entry.card)
      .filter((card) => !boardId || cardBoardId(card) === boardId)
      .toSorted(compareCards);
  }

  async listBoards(): Promise<{ boards: WorkboardBoardSummary[] }> {
    const boards = new Map<string, WorkboardBoardSummary>();
    for (const entry of await this.boardStore.entries()) {
      if (entry.value?.version !== 1 || !entry.value.board?.id) {
        continue;
      }
      const board = entry.value.board;
      boards.set(board.id, {
        id: board.id,
        ...(board.name ? { name: board.name } : {}),
        ...(board.description ? { description: board.description } : {}),
        ...(board.icon ? { icon: board.icon } : {}),
        ...(board.color ? { color: board.color } : {}),
        ...(board.defaultWorkspace ? { defaultWorkspace: board.defaultWorkspace } : {}),
        ...(board.orchestration ? { orchestration: board.orchestration } : {}),
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        updatedAt: board.updatedAt,
        ...(board.archivedAt ? { archivedAt: board.archivedAt } : {}),
      });
    }
    if (!boards.has("default")) {
      boards.set("default", {
        id: "default",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      });
    }
    for (const card of await this.list()) {
      const boardId = cardBoardId(card);
      const summary =
        boards.get(boardId) ??
        ({
          id: boardId,
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
        } satisfies WorkboardBoardSummary);
      summary.total += 1;
      if (card.metadata?.archivedAt) {
        summary.archived += 1;
      } else {
        summary.active += 1;
      }
      summary.byStatus[card.status] = (summary.byStatus[card.status] ?? 0) + 1;
      summary.updatedAt = Math.max(summary.updatedAt ?? 0, card.updatedAt);
      boards.set(boardId, summary);
    }
    return {
      boards: [...boards.values()].toSorted((a, b) =>
        a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id),
      ),
    };
  }

  async upsertBoard(input: WorkboardBoardInput): Promise<WorkboardBoardMetadata> {
    return await this.enqueueMutation(async () => {
      const id = normalizeBoardIdRequired(input.id);
      const existing = await this.boardStore.lookup(id);
      const board = normalizeBoardMetadata({ ...input, id }, existing?.board);
      await this.boardStore.register(id, { version: 1, board });
      return board;
    });
  }

  async archiveBoard(id: unknown, archived: unknown = true): Promise<WorkboardBoardMetadata> {
    return await this.upsertBoard({ id, archived });
  }

  async deleteBoard(id: unknown): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => {
      const boardId = normalizeBoardIdRequired(id);
      if (boardId === "default") {
        throw new Error("default board cannot be deleted.");
      }
      if ((await this.list({ boardId })).length > 0) {
        throw new Error("board still has cards; archive it or move/delete the cards first.");
      }
      for (const entry of await this.subscriptionStore.entries()) {
        if (entry.value?.version === 1 && entry.value.subscription?.boardId === boardId) {
          await this.subscriptionStore.delete(entry.key);
        }
      }
      return { deleted: await this.boardStore.delete(boardId) };
    });
  }

  async stats(input: WorkboardListOptions = {}, now = Date.now()): Promise<WorkboardStatsResult> {
    const cards = await this.list(input);
    const boardId = normalizeBoardId(input.boardId) ?? "all";
    const byStatus: Partial<Record<WorkboardStatus, number>> = {};
    const byAgent = Object.create(null) as Record<string, number>;
    let oldestReadyAt: number | undefined;
    let updatedAt: number | undefined;
    let archived = 0;
    for (const card of cards) {
      byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
      byAgent[card.agentId ?? "(default)"] = (byAgent[card.agentId ?? "(default)"] ?? 0) + 1;
      if (card.metadata?.archivedAt) {
        archived += 1;
      }
      if (card.status === "ready") {
        oldestReadyAt = Math.min(oldestReadyAt ?? card.updatedAt, card.updatedAt);
      }
      updatedAt = Math.max(updatedAt ?? 0, card.updatedAt);
    }
    return {
      id: boardId,
      total: cards.length,
      active: cards.length - archived,
      archived,
      byStatus,
      byAgent,
      ...(oldestReadyAt ? { oldestReadyAgeMs: Math.max(0, now - oldestReadyAt) } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  async get(id: string): Promise<WorkboardCard | undefined> {
    const entry = await this.store.lookup(id.trim());
    return entry?.version === 1 ? entry.card : undefined;
  }

  private async removeReferencesToCard(cardId: string): Promise<void> {
    for (const card of await this.list()) {
      const links = card.metadata?.links;
      if (!links?.some((link) => link.targetCardId === cardId)) {
        continue;
      }
      await this.updateCard(card.id, {
        metadata: {
          ...card.metadata,
          links: links.filter((link) => link.targetCardId !== cardId),
        },
      });
    }
  }

  async create(
    input: WorkboardLinkedCreateInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => await this.createDirect(input, scope));
  }

  private async createDirect(
    input: WorkboardLinkedCreateInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const requestedStatus = normalizeStatus(input.status, "todo");
    const cards = await this.list();
    const parents = normalizeStringList(input.parents, "parents", 120);
    const automation = normalizeAutomation({
      tenant: input.tenant,
      boardId: input.boardId,
      createdByCardId: input.createdByCardId,
      idempotencyKey: input.idempotencyKey,
      skills: input.skills,
      workspace: input.workspace,
      maxRuntimeSeconds: input.maxRuntimeSeconds,
      maxRetries: input.maxRetries,
      scheduledAt: input.scheduledAt,
    });
    const heldBySchedule =
      Boolean(automation?.scheduledAt && automation.scheduledAt > now) &&
      requestedStatus !== "blocked";
    let status: WorkboardStatus = heldBySchedule ? "scheduled" : requestedStatus;
    let heldByDependencies = false;
    if (parents.length > 0 && (status === "running" || status === "review")) {
      status = "todo";
      heldByDependencies = true;
    }
    if (automation?.idempotencyKey) {
      const existing = cards.find(
        (card) =>
          card.metadata?.automation?.idempotencyKey === automation.idempotencyKey &&
          card.metadata?.automation?.tenant === automation.tenant &&
          cardBoardId(card) === (automation.boardId ?? "default"),
      );
      if (existing) {
        return existing;
      }
    }
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    const parentCards = parents.map((parentId) => {
      const parent = cardsById.get(parentId);
      if (!parent) {
        throw new Error(`card not found: ${parentId}`);
      }
      return parent;
    });
    const childAutomation = normalizeAutomation(
      {
        ...automation,
        createdByCardId:
          automation?.createdByCardId ?? (parents.length === 1 ? parents[0] : undefined),
      },
      automation,
    );
    const normalizedPosition = normalizePosition(input.position, Number.NaN);
    const position = Number.isFinite(normalizedPosition)
      ? normalizedPosition
      : Math.max(
          0,
          ...cards.filter((card) => card.status === status).map((card) => card.position),
        ) + POSITION_STEP;
    const notes = normalizeNotes(input.notes);
    const agentId = normalizeOptionalString(input.agentId);
    const sessionKey = normalizeOptionalString(input.sessionKey);
    const runId = normalizeOptionalString(input.runId);
    const taskId = normalizeOptionalString(input.taskId);
    const sourceUrl = normalizeOptionalString(input.sourceUrl);
    const normalizedExecution = normalizeExecution(input.execution);
    const execution =
      normalizedExecution?.status === "running" && (heldBySchedule || heldByDependencies)
        ? undefined
        : normalizedExecution;
    const startedAt =
      input.startedAt === undefined
        ? status === "running"
          ? now
          : undefined
        : normalizeTimestamp(input.startedAt, 0) || undefined;
    const completedAt =
      input.completedAt === undefined
        ? status === "done"
          ? now
          : undefined
        : normalizeTimestamp(input.completedAt, 0) || undefined;
    const metadata = normalizeMetadata(
      input.metadata,
      {
        templateId: normalizeTemplateId(input.templateId),
        ...(childAutomation ? { automation: childAutomation } : {}),
      },
      { allowDependencyLinks: false },
    );
    const syncedMetadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(metadata, execution, now),
    );
    let card: WorkboardCard = {
      id: randomUUID(),
      title: normalizeTitle(input.title),
      status,
      priority: normalizePriority(input.priority, "normal"),
      labels: normalizeLabels(input.labels),
      position,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          id: randomUUID(),
          kind: "created",
          at: now,
          toStatus: status,
          ...(sessionKey ? { sessionKey } : {}),
          ...(runId ? { runId } : {}),
        },
      ],
      ...(notes ? { notes } : {}),
      ...(agentId ? { agentId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(execution ? { execution } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(!metadataIsEmpty(syncedMetadata) ? { metadata: syncedMetadata } : {}),
    };
    await this.store.register(card.id, { version: 1, card });
    try {
      for (const parent of parentCards) {
        card = await this.linkCardsDirect(parent.id, card.id, now, {
          allowStatusOnlyActiveChild: true,
          scope,
        });
      }
    } catch (error) {
      await this.store.delete(card.id);
      await this.removeReferencesToCard(card.id);
      throw error;
    }
    return card;
  }

  async update(id: string, patch: WorkboardCardPatch): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () =>
        await this.updateCard(id, patch, {
          allowMetadataDependencyLinks: false,
          enforceStatusHolds: true,
        }),
    );
  }

  private async updateCard(
    id: string,
    patch: WorkboardCardPatch,
    options: { allowMetadataDependencyLinks?: boolean; enforceStatusHolds?: boolean } = {},
  ): Promise<WorkboardCard> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`card not found: ${id}`);
    }
    const lifecycleStatusSourceUpdatedAt = lifecycleStatusSourceUpdatedAtFromPatch(patch.metadata);
    const existingLifecycleStatusSourceUpdatedAt =
      existing.metadata?.lifecycleStatusSourceUpdatedAt;
    const hasFreshLifecycleStatusSource =
      lifecycleStatusSourceUpdatedAt !== undefined &&
      lifecycleStatusSourceUpdatedAt !== existingLifecycleStatusSourceUpdatedAt;
    let effectivePatch = patch;
    if (
      patch.status !== undefined &&
      lifecycleStatusSourceUpdatedAt !== undefined &&
      shouldSkipPersistedLifecycleStatusUpdate(existing, lifecycleStatusSourceUpdatedAt)
    ) {
      // Ignore stale lifecycle status writes, but still accept any non-status updates in the patch.
      effectivePatch = { ...patch, status: undefined };
      if (patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)) {
        const metadataPatch = patch.metadata as Record<string, unknown>;
        const { lifecycleStatusSourceUpdatedAt: _ignored, ...rest } = metadataPatch;
        effectivePatch.metadata = Object.keys(rest).length > 0 ? rest : undefined;
      }
      const hasSemanticPatch = Object.entries(effectivePatch).some(
        ([key, value]) => key !== "status" && key !== "metadata" && value !== undefined,
      );
      if (!hasSemanticPatch && effectivePatch.metadata === undefined) {
        return existing;
      }
    }
    const status = normalizeStatus(effectivePatch.status, existing.status);
    const now = Date.now();
    const startedAt =
      effectivePatch.startedAt === undefined
        ? status === "running"
          ? (existing.startedAt ?? now)
          : existing.startedAt
        : normalizeTimestamp(effectivePatch.startedAt, 0) || undefined;
    const completedAt =
      effectivePatch.completedAt === undefined
        ? status === "done"
          ? (existing.completedAt ?? now)
          : undefined
        : normalizeTimestamp(effectivePatch.completedAt, 0) || undefined;
    const sessionKey =
      effectivePatch.sessionKey === undefined
        ? existing.sessionKey
        : normalizeOptionalString(effectivePatch.sessionKey);
    const execution =
      effectivePatch.execution === undefined
        ? effectivePatch.sessionKey === undefined
          ? existing.execution
          : syncExecutionSessionKey(existing.execution, sessionKey)
        : normalizeExecution(effectivePatch.execution);
    let metadata = normalizeMetadata(effectivePatch.metadata, existing.metadata, {
      allowDependencyLinks: options.allowMetadataDependencyLinks !== false,
    });
    if (status !== existing.status && !hasFreshLifecycleStatusSource) {
      // Status patches often spread existing metadata. Only a newly supplied
      // lifecycle source is provenance; copied markers must not survive a manual transition.
      metadata = { ...metadata, lifecycleStatusSourceUpdatedAt: undefined };
    }
    const automationPatch: Record<string, unknown> = {};
    for (const key of [
      "tenant",
      "boardId",
      "createdByCardId",
      "idempotencyKey",
      "skills",
      "workspace",
      "maxRuntimeSeconds",
      "maxRetries",
      "scheduledAt",
    ] as const) {
      if (Object.hasOwn(effectivePatch, key) && effectivePatch[key] !== undefined) {
        automationPatch[key] = effectivePatch[key];
      }
    }
    if (Object.keys(automationPatch).length > 0) {
      metadata = trimMetadataToBudget({
        ...metadata,
        automation: normalizeAutomation(automationPatch, metadata.automation),
      });
    }
    const next = removeUndefinedCardFields({
      ...existing,
      title:
        effectivePatch.title === undefined ? existing.title : normalizeTitle(effectivePatch.title),
      notes:
        effectivePatch.notes === undefined ? existing.notes : normalizeNotes(effectivePatch.notes),
      status,
      priority:
        effectivePatch.priority === undefined
          ? existing.priority
          : normalizePriority(effectivePatch.priority, existing.priority),
      labels:
        effectivePatch.labels === undefined
          ? existing.labels
          : normalizeLabels(effectivePatch.labels),
      agentId:
        effectivePatch.agentId === undefined
          ? existing.agentId
          : normalizeOptionalString(effectivePatch.agentId),
      sessionKey,
      runId:
        effectivePatch.runId === undefined
          ? existing.runId
          : normalizeOptionalString(effectivePatch.runId),
      taskId:
        effectivePatch.taskId === undefined
          ? existing.taskId
          : normalizeOptionalString(effectivePatch.taskId),
      sourceUrl:
        effectivePatch.sourceUrl === undefined
          ? existing.sourceUrl
          : normalizeOptionalString(effectivePatch.sourceUrl),
      execution,
      metadata:
        effectivePatch.templateId === undefined
          ? metadata
          : { ...metadata, templateId: normalizeTemplateId(effectivePatch.templateId) },
      position:
        effectivePatch.position === undefined
          ? existing.position
          : normalizePosition(effectivePatch.position, existing.position),
      updatedAt: now,
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    });
    next.metadata = trimMetadataToBudget(
      syncExecutionAttemptMetadata(next.metadata ?? {}, execution, now),
    );
    next.events = appendEvent(next, updateEvent(existing, next), now);
    if (options.enforceStatusHolds && effectivePatch.status !== undefined) {
      await this.assertActiveStatusAllowed(existing, next, now);
    }
    if (status !== "done") {
      delete next.completedAt;
    }
    if (effectivePatch.startedAt !== undefined && !startedAt) {
      delete next.startedAt;
    }
    if (effectivePatch.completedAt !== undefined && !completedAt) {
      delete next.completedAt;
    }
    if (metadataIsEmpty(next.metadata)) {
      delete next.metadata;
    }
    await this.store.register(next.id, { version: 1, card: next });
    await this.deleteDetachedAttachments(existing, next);
    return next;
  }

  private async assertActiveStatusAllowed(
    existing: WorkboardCard,
    next: WorkboardCard,
    now: number,
  ): Promise<void> {
    if (
      next.status !== "ready" &&
      next.status !== "running" &&
      next.status !== "review" &&
      next.status !== "done"
    ) {
      return;
    }
    const parents = cardParentIds(next);
    const cards =
      parents.length > 0 ? new Map((await this.list()).map((card) => [card.id, card])) : undefined;
    if (
      parents.length > 0 &&
      !parents.every((parentId) => cards?.get(parentId)?.status === "done")
    ) {
      throw new Error("card dependencies are not done.");
    }
    if (next.status === "done") {
      return;
    }
    const scheduledAt = next.metadata?.automation?.scheduledAt;
    if ((scheduledAt && scheduledAt > now) || (existing.status === "scheduled" && !scheduledAt)) {
      throw new Error("card is scheduled for later.");
    }
  }

  async move(id: string, status: unknown, position: unknown): Promise<WorkboardCard> {
    return await this.update(id, {
      status,
      position,
    });
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return await this.enqueueMutation(async () => await this.deleteDirect(id));
  }

  private async deleteDirect(id: string): Promise<{ deleted: boolean }> {
    const cardId = id.trim();
    const deleted = await this.store.delete(cardId);
    if (!deleted) {
      return { deleted: false };
    }
    for (const entry of await this.subscriptionStore.entries()) {
      if (entry.value?.version === 1 && entry.value.subscription?.cardId === cardId) {
        await this.subscriptionStore.delete(entry.key);
      }
    }
    for (const entry of await this.attachmentStore.entries()) {
      if (entry.value?.version === 1 && entry.value.attachment?.cardId === cardId) {
        await this.attachmentStore.delete(entry.key);
      }
    }
    await this.removeReferencesToCard(cardId);
    return { deleted: true };
  }

  async addComment(
    id: string,
    input: WorkboardCommentInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const body = normalizeBoundedString(input.body, undefined, 2000, "comment body");
    if (!body) {
      throw new Error("comment body is required.");
    }
    const comment = { id: randomUUID(), body, createdAt: now };
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      return {
        ...existing.metadata,
        comments: [...(existing.metadata?.comments ?? []), comment].slice(-MAX_CARD_COMMENTS),
      };
    });
  }

  async addLink(id: string, input: WorkboardLinkInput): Promise<WorkboardCard> {
    const now = Date.now();
    const targetCardId = normalizeBoundedString(input.targetCardId, undefined, 120, "link target");
    const url = normalizeBoundedString(input.url, undefined, 2000, "link URL");
    const title = normalizeBoundedString(input.title, undefined, 180, "link title");
    if (!targetCardId && !url) {
      throw new Error("link targetCardId or url is required.");
    }
    const type = normalizeLinkType(input.type, "relates_to");
    if (type === "parent" || type === "child") {
      throw new Error("parent and child dependency links must use linkDependency.");
    }
    const link: WorkboardLink = {
      id: randomUUID(),
      type,
      createdAt: now,
      ...(targetCardId ? { targetCardId } : {}),
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
    };
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      links: appendLinkPreservingDependencies(existing.metadata?.links ?? [], link),
    }));
  }

  async linkCards(
    parentId: string,
    childId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(
      async () => await this.linkCardsDirect(parentId, childId, Date.now(), { scope }),
    );
  }

  private async linkCardsDirect(
    parentId: string,
    childId: string,
    now = Date.now(),
    options: { allowStatusOnlyActiveChild?: boolean; scope?: WorkboardMutationScope } = {},
  ): Promise<WorkboardCard> {
    if (parentId.trim() === childId.trim()) {
      throw new Error("parent and child cards must differ.");
    }
    const parent = await this.get(parentId);
    const child = await this.get(childId);
    if (!parent) {
      throw new Error(`card not found: ${parentId}`);
    }
    if (!child) {
      throw new Error(`card not found: ${childId}`);
    }
    assertCanMutateClaimedCard(parent, options.scope);
    assertCanMutateClaimedCard(child, options.scope);
    if (child.status === "done" || child.status === "blocked") {
      const cardsById = new Map((await this.list()).map((card) => [card.id, card]));
      const parentIds = [...cardParentIds(child), parent.id].filter(
        (id, index, ids) => ids.indexOf(id) === index,
      );
      if (parentIds.some((id) => cardsById.get(id)?.status !== "done")) {
        throw new Error("terminal child cards cannot gain incomplete parent dependencies.");
      }
    }
    if (isActiveDependencyTarget(child, { allowStatusOnly: options.allowStatusOnlyActiveChild })) {
      throw new Error("active child cards cannot gain parent dependencies.");
    }
    if (await this.dependsOn(parent.id, child.id)) {
      throw new Error("dependency link would create a cycle.");
    }
    const parentLinks = parent.metadata?.links ?? [];
    const childLinks = child.metadata?.links ?? [];
    const nextParentLinks = parentLinks.some(
      (link) => link.type === "child" && link.targetCardId === child.id,
    )
      ? parentLinks
      : appendLinkPreservingDependencies(parentLinks, {
          id: randomUUID(),
          type: "child" as const,
          targetCardId: child.id,
          createdAt: now,
        });
    const nextChildLinks = childLinks.some(
      (link) => link.type === "parent" && link.targetCardId === parent.id,
    )
      ? childLinks
      : appendLinkPreservingDependencies(childLinks, {
          id: randomUUID(),
          type: "parent" as const,
          targetCardId: parent.id,
          createdAt: now,
        });
    await this.updateCard(parent.id, {
      metadata: { ...parent.metadata, links: nextParentLinks },
    });
    const nextChild = await this.updateCard(child.id, {
      metadata: { ...child.metadata, links: nextChildLinks },
    });
    return await this.promoteDependencyReady(nextChild.id);
  }

  async linkParents(childId: string, parentIds: readonly string[]): Promise<WorkboardCard> {
    let child = await this.get(childId);
    if (!child) {
      throw new Error(`card not found: ${childId}`);
    }
    for (const parentId of parentIds) {
      child = await this.linkCards(parentId, child.id);
    }
    return child;
  }

  private async dependencyTargetStatus(card: WorkboardCard, now: number): Promise<WorkboardStatus> {
    const scheduledAt = card.metadata?.automation?.scheduledAt;
    const parents = cardParentIds(card);
    if (card.status === "scheduled" && !scheduledAt) {
      return "scheduled";
    }
    if (parents.length === 0) {
      if (scheduledAt && scheduledAt > now && isDependencyPromotableStatus(card.status)) {
        return "scheduled";
      }
      return card.status === "scheduled" ? "ready" : card.status;
    }
    const cards = new Map((await this.list()).map((entry) => [entry.id, entry]));
    const parentsDone = parents.every((parentId) => cards.get(parentId)?.status === "done");
    if (
      !parentsDone &&
      scheduledAt &&
      scheduledAt > now &&
      isDependencyPromotableStatus(card.status)
    ) {
      return "scheduled";
    }
    if (!parentsDone && isDependencyPromotableStatus(card.status)) {
      return "todo";
    }
    if (
      parentsDone &&
      scheduledAt &&
      scheduledAt > now &&
      isDependencyPromotableStatus(card.status)
    ) {
      return "scheduled";
    }
    return parentsDone && isDependencyPromotableStatus(card.status) ? "ready" : card.status;
  }

  private async dependsOn(cardId: string, targetParentId: string): Promise<boolean> {
    const cards = new Map((await this.list()).map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === targetParentId) {
        return true;
      }
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      const card = cards.get(id);
      return Boolean(card && cardParentIds(card).some(visit));
    };
    return visit(cardId);
  }

  private async recordDispatch(card: WorkboardCard, now: number): Promise<WorkboardCard> {
    const metadata = trimMetadataToBudget(
      normalizeMetadata(
        {
          ...card.metadata,
          automation: normalizeAutomation(
            {
              ...card.metadata?.automation,
              dispatchCount: (card.metadata?.automation?.dispatchCount ?? 0) + 1,
              lastDispatchAt: now,
            },
            card.metadata?.automation,
          ),
        },
        card.metadata,
      ),
    );
    const next = removeUndefinedCardFields({
      ...card,
      ...(!metadataIsEmpty(metadata) ? { metadata } : { metadata: undefined }),
      events: appendEvent(card, { kind: "dispatch" }, now),
    });
    await this.store.register(card.id, { version: 1, card: next });
    return next;
  }

  private async recordOrchestrationCandidate(
    card: WorkboardCard,
    now: number,
  ): Promise<WorkboardCard> {
    const metadata = trimMetadataToBudget({
      ...card.metadata,
      workerLogs: [
        ...(card.metadata?.workerLogs ?? []),
        {
          id: randomUUID(),
          level: "info" as const,
          message: "Auto orchestration marked this triage card for specification or decomposition.",
          createdAt: now,
        },
      ].slice(-MAX_CARD_WORKER_LOGS),
      workerProtocol: {
        state: "idle" as const,
        updatedAt: now,
        detail: "Awaiting workboard_specify or workboard_decompose.",
      },
    });
    const next = removeUndefinedCardFields({
      ...card,
      ...(!metadataIsEmpty(metadata) ? { metadata } : { metadata: undefined }),
      events: appendEvent(card, { kind: "orchestration" }, now),
    });
    await this.store.register(card.id, { version: 1, card: next });
    return next;
  }

  private async shouldAutoOrchestrate(card: WorkboardCard): Promise<boolean> {
    if (
      card.status !== "triage" ||
      card.metadata?.archivedAt ||
      card.metadata?.workerProtocol?.state === "idle"
    ) {
      return false;
    }
    const board = await this.boardStore.lookup(cardBoardId(card));
    return board?.version === 1 && board.board.orchestration?.autoDecompose === true;
  }

  private async promoteDependencyReady(id: string, now = Date.now()): Promise<WorkboardCard> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    const target = await this.dependencyTargetStatus(card, now);
    if (target === card.status) {
      return card;
    }
    return await this.updateCard(card.id, { status: target });
  }

  async promoteReady(now = Date.now()): Promise<{ cards: WorkboardCard[]; count: number }> {
    return await this.enqueueMutation(async () => {
      const promoted: WorkboardCard[] = [];
      for (const card of await this.list()) {
        const next = await this.promoteDependencyReady(card.id, now);
        if (next.status !== card.status) {
          promoted.push(next);
        }
      }
      return { cards: promoted, count: promoted.length };
    });
  }

  async addProof(
    id: string,
    input: WorkboardProofInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const proof = normalizeProofInput(input, now);
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
      return {
        ...metadata,
        proof: [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF),
      };
    });
  }

  async addProofWithArtifact(
    id: string,
    proofInput: WorkboardProofInput,
    artifactInput: WorkboardArtifactInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const proof = normalizeProofInput(proofInput, now);
    const artifact = normalizeArtifact({ ...artifactInput, createdAt: now });
    if (!artifact) {
      throw new Error("artifact url or path is required.");
    }
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
      return {
        ...metadata,
        proof: [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF),
        artifacts: [...(metadata.artifacts ?? []), artifact].slice(-MAX_CARD_ARTIFACTS),
      };
    });
  }

  async addArtifact(
    id: string,
    input: WorkboardArtifactInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const artifact = normalizeArtifact({ ...input, createdAt: Date.now() });
    if (!artifact) {
      throw new Error("artifact url or path is required.");
    }
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
      return {
        ...metadata,
        artifacts: [...(metadata.artifacts ?? []), artifact].slice(-MAX_CARD_ARTIFACTS),
      };
    });
  }

  async addAttachment(
    id: string,
    input: WorkboardAttachmentInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const now = Date.now();
      const { attachment, contentBase64 } = normalizeAttachmentInput(id, input, now);
      await this.attachmentStore.register(attachment.id, {
        version: 1,
        attachment,
        contentBase64,
      });
      try {
        const updated = await this.updateCard(id, {
          metadata: {
            ...clearDiagnostics(existing.metadata, ["missing_proof"]),
            attachments: [...(existing.metadata?.attachments ?? []), attachment].slice(
              -MAX_CARD_ATTACHMENTS,
            ),
          },
        });
        if (!updated.metadata?.attachments?.some((entry) => entry.id === attachment.id)) {
          await this.attachmentStore.delete(attachment.id);
          throw new Error("attachment metadata was trimmed before it could be indexed.");
        }
        return updated;
      } catch (error) {
        await this.attachmentStore.delete(attachment.id);
        throw error;
      }
    });
  }

  async listAttachments(id: string): Promise<{
    card: WorkboardCard;
    attachments: WorkboardAttachment[];
  }> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return { card, attachments: card.metadata?.attachments ?? [] };
  }

  async getAttachment(id: string): Promise<PersistedWorkboardAttachment | undefined> {
    const attachmentId = id.trim();
    const entry = await this.attachmentStore.lookup(attachmentId);
    return entry?.version === 1 ? entry : undefined;
  }

  async deleteAttachment(
    cardId: string,
    attachmentId: string,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(cardId);
      if (!existing) {
        throw new Error(`card not found: ${cardId}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const attachments = existing.metadata?.attachments ?? [];
      if (!attachments.some((attachment) => attachment.id === attachmentId)) {
        throw new Error(`attachment not found: ${attachmentId}`);
      }
      await this.attachmentStore.delete(attachmentId);
      return await this.updateCard(cardId, {
        metadata: {
          ...existing.metadata,
          attachments: attachments.filter((attachment) => attachment.id !== attachmentId),
        },
      });
    });
  }

  async addWorkerLog(
    id: string,
    input: WorkboardWorkerLogInput,
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    const now = Date.now();
    const message = normalizeBoundedString(input.message, undefined, 800, "worker log message");
    if (!message) {
      throw new Error("worker log message is required.");
    }
    const level =
      input.level === "warning" || input.level === "error" || input.level === "info"
        ? input.level
        : "info";
    const sessionKey = normalizeBoundedString(input.sessionKey, undefined, 240, "session key");
    const runId = normalizeBoundedString(input.runId, undefined, 160, "run id");
    const log: WorkboardWorkerLog = {
      id: randomUUID(),
      level,
      message,
      createdAt: now,
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
    };
    return await this.updateMetadata(id, (existing) => {
      assertCanMutateClaimedCard(existing, scope);
      return {
        ...existing.metadata,
        workerLogs: [...(existing.metadata?.workerLogs ?? []), log].slice(-MAX_CARD_WORKER_LOGS),
      };
    });
  }

  async recordProtocolViolation(
    id: string,
    input: WorkboardProtocolViolationInput = {},
    scope?: WorkboardMutationScope,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const card = await this.get(id);
      if (!card) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(card, scope);
      const now = Date.now();
      const detail =
        normalizeBoundedString(input.detail, undefined, 800, "protocol violation detail") ??
        "Worker stopped without completing or blocking the card.";
      const sessionKey = normalizeBoundedString(input.sessionKey, undefined, 240, "session key");
      const runId = normalizeBoundedString(input.runId, undefined, 160, "run id");
      const log: WorkboardWorkerLog = {
        id: randomUUID(),
        level: "error",
        message: detail,
        createdAt: now,
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
      };
      const execution =
        card.execution?.status === "running"
          ? { ...card.execution, status: "blocked" as const, updatedAt: now }
          : card.execution;
      const attempts = closeRunningAttempts(card.metadata?.attempts, now, "blocked", detail);
      const notification: WorkboardNotification = {
        id: randomUUID(),
        kind: "failed",
        createdAt: now,
        sequence: this.nextNotificationSequence(now),
        message: capText(detail, 240) ?? "Worker protocol violation.",
        ...(sessionKey || cardSessionKey(card)
          ? { sessionKey: sessionKey ?? cardSessionKey(card) }
          : {}),
        ...(runId || cardRunId(card) ? { runId: runId ?? cardRunId(card) } : {}),
      };
      return await this.updateCard(card.id, {
        status: card.status === "done" ? card.status : "blocked",
        ...(execution ? { execution } : {}),
        metadata: {
          ...card.metadata,
          workerLogs: [...(card.metadata?.workerLogs ?? []), log].slice(-MAX_CARD_WORKER_LOGS),
          workerProtocol: {
            state: "violated",
            updatedAt: now,
            detail,
          },
          claim: undefined,
          ...(attempts ? { attempts } : {}),
          failureCount: (card.metadata?.failureCount ?? 0) + 1,
          notifications: [...(card.metadata?.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      });
    });
  }

  async claim(
    id: string,
    input: WorkboardClaimInput,
  ): Promise<{ card: WorkboardCard; token: string }> {
    const ownerId = normalizeBoundedString(input.ownerId, undefined, 120, "claim owner");
    if (!ownerId) {
      throw new Error("claim ownerId is required.");
    }
    const ttlSeconds =
      typeof input.ttlSeconds === "number" && Number.isFinite(input.ttlSeconds)
        ? Math.max(1, Math.trunc(input.ttlSeconds))
        : undefined;
    const token =
      normalizeBoundedString(input.token, undefined, 160, "claim token") ?? randomUUID();
    return await this.enqueueMutation(async () => {
      const now = Date.now();
      const expiresAt = addWorkboardDurationMs(
        now,
        ttlSeconds ? secondsToDurationMs(ttlSeconds) : DEFAULT_CLAIM_TTL_MS,
      );
      const guarded = await this.promoteDependencyReady(id, now);
      if (cardParentIds(guarded).length > 0 && guarded.status !== "ready") {
        throw new Error("card dependencies are not done.");
      }
      if (guarded.status === "scheduled") {
        throw new Error("card is scheduled for later.");
      }
      if (retryBudgetExhausted(guarded)) {
        throw new Error("card exhausted its retry budget.");
      }
      const existingClaim = guarded.metadata?.claim;
      if (existingClaim && isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now })) {
        throw new Error(`card already claimed by ${existingClaim.ownerId}.`);
      }
      const metadata = clearDiagnostics(guarded.metadata, ["stranded_ready"]);
      const card = await this.updateCard(id, {
        metadata: {
          ...metadata,
          claim: { ownerId, token, claimedAt: now, lastHeartbeatAt: now, expiresAt },
        },
      });
      const next = await this.updateCard(card.id, {
        status:
          card.status === "backlog" || card.status === "todo" || card.status === "ready"
            ? "running"
            : card.status,
        agentId: card.agentId ?? ownerId,
      });
      return { card: next, token };
    });
  }

  async heartbeat(id: string, input: WorkboardHeartbeatInput): Promise<WorkboardCard> {
    const note = normalizeBoundedString(input.note, undefined, 400, "heartbeat note");
    const card = await this.updateMetadata(id, (existing) => {
      const claim = existing.metadata?.claim;
      if (!claim) {
        throw new Error("card is not claimed.");
      }
      const now = Math.max(Date.now(), claim.lastHeartbeatAt + 1);
      const token = normalizeOptionalString(input.token);
      const ownerId = normalizeOptionalString(input.ownerId);
      if (token && token !== claim.token) {
        throw new Error("claim token does not match.");
      }
      if (!token && ownerId && ownerId !== claim.ownerId) {
        throw new Error("claim owner does not match.");
      }
      const nextClaim = {
        ...claim,
        lastHeartbeatAt: now,
        expiresAt: claim.expiresAt
          ? addWorkboardDurationMs(
              now,
              Math.max(
                1,
                claim.expiresAt > claim.claimedAt
                  ? claim.expiresAt - claim.lastHeartbeatAt
                  : DEFAULT_CLAIM_TTL_MS,
              ),
            )
          : undefined,
      };
      const metadata = clearDiagnostics(existing.metadata, ["running_without_heartbeat"]);
      return {
        ...metadata,
        claim: removeUndefinedMetadataFields({ claim: nextClaim }).claim,
        comments: note
          ? [...(metadata.comments ?? []), { id: randomUUID(), body: note, createdAt: now }].slice(
              -MAX_CARD_COMMENTS,
            )
          : metadata.comments,
      };
    });
    return card;
  }

  async releaseClaim(
    id: string,
    input: WorkboardHeartbeatInput & { status?: unknown } = {},
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const claim = existing.metadata?.claim;
      if (claim) {
        const token = normalizeOptionalString(input.token);
        const ownerId = normalizeOptionalString(input.ownerId);
        if (token && token !== claim.token) {
          throw new Error("claim token does not match.");
        }
        if (!token && ownerId && ownerId !== claim.ownerId) {
          throw new Error("claim owner does not match.");
        }
      }
      return await this.updateCard(
        id,
        {
          status,
          metadata: { ...existing.metadata, claim: undefined },
        },
        { enforceStatusHolds: input.status !== undefined },
      );
    });
  }

  async complete(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => await this.completeDirect(id, input, scope));
  }

  private async completeDirect(
    id: string,
    input: WorkboardCompleteInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`card not found: ${id}`);
    }
    assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
    const now = Date.now();
    const createdCardIds = normalizeStringList(input.createdCardIds, "created card ids", 120);
    const childIds = cardChildIds(existing);
    for (const createdCardId of createdCardIds) {
      const createdCard = await this.get(createdCardId);
      if (!createdCard) {
        throw new Error(`created card not found: ${createdCardId}`);
      }
      const linkedFromParent =
        childIds.includes(createdCardId) && cardParentIds(createdCard).includes(existing.id);
      if (!linkedFromParent) {
        throw new Error(`created card is not linked to this card: ${createdCardId}`);
      }
    }
    const summary = normalizeBoundedString(input.summary, undefined, 2000, "summary");
    const proofInput =
      input.proof && typeof input.proof === "object" && !Array.isArray(input.proof)
        ? (input.proof as WorkboardProofInput)
        : undefined;
    const proof = proofInput ? normalizeProofInput(proofInput, now) : undefined;
    const artifacts = Array.isArray(input.artifacts)
      ? input.artifacts
          .map((artifact) => normalizeArtifact({ ...artifact, createdAt: now }))
          .filter((artifact): artifact is WorkboardArtifact => artifact !== null)
          .slice(-MAX_CARD_ARTIFACTS)
      : [];
    const metadata = clearDiagnostics(existing.metadata, ["missing_proof"]);
    const notification: WorkboardNotification = {
      id: randomUUID(),
      kind: "completed",
      createdAt: now,
      sequence: this.nextNotificationSequence(now),
      message: capText(summary, 240) ?? "Workboard card completed.",
      ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
      ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
    };
    const execution =
      existing.execution?.status === "running"
        ? { ...existing.execution, status: "done" as const, updatedAt: now }
        : existing.execution;
    return await this.updateCard(
      id,
      {
        status: "done",
        ...(execution ? { execution } : {}),
        metadata: {
          ...metadata,
          claim: undefined,
          attempts: closeRunningAttempts(metadata.attempts, now, "succeeded"),
          failureCount: 0,
          automation: normalizeAutomation(
            {
              ...metadata.automation,
              summary,
              createdCardIds,
            },
            metadata.automation,
          ),
          comments: summary
            ? [
                ...(metadata.comments ?? []),
                { id: randomUUID(), body: summary, createdAt: now },
              ].slice(-MAX_CARD_COMMENTS)
            : metadata.comments,
          proof: proof ? [...(metadata.proof ?? []), proof].slice(-MAX_CARD_PROOF) : metadata.proof,
          artifacts: artifacts.length
            ? [...(metadata.artifacts ?? []), ...artifacts].slice(-MAX_CARD_ARTIFACTS)
            : metadata.artifacts,
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      },
      { enforceStatusHolds: true },
    );
  }

  async block(
    id: string,
    input: WorkboardBlockInput = {},
    scope: WorkboardMutationScope | null | undefined = input,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 2000, "block reason") ??
        "Workboard card blocked.";
      const metadata = existing.metadata ?? {};
      const notification: WorkboardNotification = {
        id: randomUUID(),
        kind: "failed",
        createdAt: now,
        sequence: this.nextNotificationSequence(now),
        message: capText(reason, 240) ?? "Workboard card blocked.",
        ...(cardSessionKey(existing) ? { sessionKey: cardSessionKey(existing) } : {}),
        ...(cardRunId(existing) ? { runId: cardRunId(existing) } : {}),
      };
      const execution =
        existing.execution?.status === "running"
          ? { ...existing.execution, status: "blocked" as const, updatedAt: now }
          : existing.execution;
      return await this.updateCard(id, {
        status: "blocked",
        ...(execution ? { execution } : {}),
        metadata: {
          ...metadata,
          claim: undefined,
          attempts: closeRunningAttempts(metadata.attempts, now, "blocked", reason),
          failureCount: (metadata.failureCount ?? 0) + 1,
          comments: [
            ...(metadata.comments ?? []),
            { id: randomUUID(), body: reason, createdAt: now },
          ].slice(-MAX_CARD_COMMENTS),
          notifications: [...(metadata.notifications ?? []), notification].slice(
            -MAX_CARD_NOTIFICATIONS,
          ),
        },
      });
    });
  }

  async unblock(id: string, scope?: WorkboardMutationScope): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope);
      const metadata = clearDiagnostics(existing.metadata, ["blocked_too_long"]);
      return await this.updateCard(id, { status: "todo", metadata: { ...metadata, stale: null } });
    });
  }

  async promote(
    id: string,
    input: WorkboardPromoteInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "promote reason");
      const comments = reason
        ? [
            ...(existing.metadata?.comments ?? []),
            { id: randomUUID(), body: reason, createdAt: Date.now() },
          ].slice(-MAX_CARD_COMMENTS)
        : existing.metadata?.comments;
      return await this.updateCard(
        id,
        {
          status: "ready",
          metadata: {
            ...clearDiagnostics(existing.metadata, ["stranded_ready", "blocked_too_long"]),
            comments,
            stale: null,
          },
        },
        { enforceStatusHolds: input.force !== true },
      );
    });
  }

  async reassign(
    id: string,
    input: WorkboardReassignInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const agentId =
        input.agentId === undefined ? existing.agentId : normalizeOptionalString(input.agentId);
      const status =
        input.status === undefined
          ? existing.status
          : normalizeStatus(input.status, existing.status);
      const reason = normalizeBoundedString(input.reason, undefined, 1000, "reassign reason");
      const shouldResetFailures = input.resetFailures !== false;
      const baseMetadata = shouldResetFailures
        ? clearDiagnostics(existing.metadata, ["blocked_too_long", "repeated_failures"])
        : existing.metadata;
      const metadata = {
        ...baseMetadata,
        ...(shouldResetFailures ? { failureCount: 0 } : {}),
        comments: reason
          ? [
              ...(baseMetadata?.comments ?? []),
              { id: randomUUID(), body: reason, createdAt: Date.now() },
            ].slice(-MAX_CARD_COMMENTS)
          : baseMetadata?.comments,
      };
      return await this.updateCard(id, { agentId, status, metadata }, { enforceStatusHolds: true });
    });
  }

  async reclaim(
    id: string,
    input: WorkboardReclaimInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      const now = Date.now();
      const reason =
        normalizeBoundedString(input.reason, undefined, 1000, "reclaim reason") ??
        "Workboard claim reclaimed.";
      const targetStatus =
        input.status === undefined
          ? existing.status === "running"
            ? "ready"
            : existing.status
          : normalizeStatus(input.status, existing.status);
      const reclaimed = await this.updateCard(
        id,
        {
          status: targetStatus,
          execution: existing.execution?.status === "running" ? null : existing.execution,
          metadata: {
            ...existing.metadata,
            claim: undefined,
            attempts: closeRunningAttempts(existing.metadata?.attempts, now, "stopped", reason),
            comments: [
              ...(existing.metadata?.comments ?? []),
              { id: randomUUID(), body: reason, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS),
            stale: null,
          },
        },
        { enforceStatusHolds: true },
      );
      return await this.promoteDependencyReady(reclaimed.id, now);
    });
  }

  async runs(id: string): Promise<{ card: WorkboardCard; attempts: WorkboardRunAttempt[] }> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return { card, attempts: card.metadata?.attempts ?? [] };
  }

  async specify(
    id: string,
    input: WorkboardSpecifyInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<WorkboardCard> {
    return await this.enqueueMutation(async () => {
      const existing = await this.get(id);
      if (!existing) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(existing, scope === null ? undefined : scope);
      if (
        existing.status !== "triage" &&
        existing.status !== "backlog" &&
        existing.status !== "todo"
      ) {
        throw new Error("only triage, backlog, or todo cards can be specified.");
      }
      const requestedStatus = normalizeStatus(input.status, "todo");
      if (requestedStatus !== "todo") {
        throw new Error("specified cards must move to todo.");
      }
      const now = Date.now();
      const summary = normalizeBoundedString(input.summary, undefined, 2000, "spec summary");
      const metadata = {
        ...existing.metadata,
        comments: summary
          ? [
              ...(existing.metadata?.comments ?? []),
              { id: randomUUID(), body: summary, createdAt: now },
            ].slice(-MAX_CARD_COMMENTS)
          : existing.metadata?.comments,
        automation: normalizeAutomation(
          {
            ...existing.metadata?.automation,
            summary: summary ?? existing.metadata?.automation?.summary,
          },
          existing.metadata?.automation,
        ),
      };
      const { summary: _summary, status: _status, ...cardPatch } = input;
      const updated = await this.updateCard(
        id,
        {
          ...cardPatch,
          status: "todo",
          metadata,
        },
        { enforceStatusHolds: true },
      );
      const specified = {
        ...updated,
        events: appendEvent(updated, { kind: "specified" }, now),
      };
      await this.store.register(specified.id, { version: 1, card: specified });
      return specified;
    });
  }

  async decompose(
    id: string,
    input: WorkboardDecomposeInput = {},
    scope?: WorkboardMutationScope | null,
  ): Promise<{ parent: WorkboardCard; children: WorkboardCard[] }> {
    return await this.enqueueMutation(async () => {
      const parent = await this.get(id);
      if (!parent) {
        throw new Error(`card not found: ${id}`);
      }
      assertCanMutateClaimedCard(parent, scope === null ? undefined : scope);
      const childrenInput = Array.isArray(input.children) ? input.children : [];
      if (childrenInput.length === 0) {
        throw new Error("children are required.");
      }
      if (childrenInput.length > 20) {
        throw new Error("at most 20 children can be created at once.");
      }
      const parentAutomation = parent.metadata?.automation;
      const existingCardIds = new Set((await this.list()).map((card) => card.id));
      const children: WorkboardCard[] = [];
      const reusedChildSnapshots = new Map<string, WorkboardCard>();
      try {
        for (const rawChild of childrenInput) {
          if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) {
            throw new Error("children must be objects.");
          }
          const child = rawChild as WorkboardDecomposeChildInput;
          const created = await this.createDirect(
            {
              ...child,
              parents: [parent.id],
              boardId: child.boardId ?? parentAutomation?.boardId,
              tenant: child.tenant ?? parentAutomation?.tenant,
              createdByCardId: parent.id,
              idempotencyKey:
                child.idempotencyKey ??
                deriveChildIdempotencyKey(parentAutomation?.idempotencyKey, children.length + 1),
            },
            scope === null ? undefined : scope,
          );
          const reusedUnlinkedChild =
            existingCardIds.has(created.id) && !cardParentIds(created).includes(parent.id);
          if (reusedUnlinkedChild) {
            reusedChildSnapshots.set(created.id, created);
          }
          children.push(
            cardParentIds(created).includes(parent.id)
              ? created
              : await this.linkCardsDirect(parent.id, created.id, Date.now(), {
                  allowStatusOnlyActiveChild: true,
                  scope: scope === null ? undefined : scope,
                }),
          );
        }
        const summary = normalizeBoundedString(input.summary, undefined, 2000, "decompose summary");
        const completeParent = input.completeParent !== false;
        const updatedParent = completeParent
          ? await this.completeDirect(
              parent.id,
              { summary, createdCardIds: children.map((child) => child.id) },
              scope,
            )
          : await (async () => {
              const latestParent = (await this.get(parent.id)) ?? parent;
              return await this.updateCard(
                parent.id,
                {
                  status:
                    latestParent.status === "triage" || latestParent.status === "backlog"
                      ? "todo"
                      : latestParent.status,
                  metadata: {
                    ...latestParent.metadata,
                    automation: normalizeAutomation(
                      {
                        ...latestParent.metadata?.automation,
                        summary,
                        createdCardIds: children.map((child) => child.id),
                      },
                      latestParent.metadata?.automation,
                    ),
                  },
                },
                { enforceStatusHolds: true },
              );
            })();
        const decomposedParent = {
          ...updatedParent,
          events: appendEvent(updatedParent, { kind: "decomposed" }),
        };
        await this.store.register(decomposedParent.id, { version: 1, card: decomposedParent });
        return { parent: decomposedParent, children };
      } catch (error) {
        for (const child of children.toReversed()) {
          if (!existingCardIds.has(child.id)) {
            await this.deleteDirect(child.id);
          }
        }
        for (const child of reusedChildSnapshots.values()) {
          await this.store.register(child.id, { version: 1, card: child });
        }
        await this.store.register(parent.id, { version: 1, card: parent });
        throw error;
      }
    });
  }

  async subscribeNotifications(
    input: WorkboardNotificationSubscribeInput,
  ): Promise<WorkboardNotificationSubscription> {
    return await this.enqueueMutation(async () => {
      const subscription = normalizeNotificationSubscription(input);
      await this.subscriptionStore.register(subscription.id, { version: 1, subscription });
      return subscription;
    });
  }

  async listNotificationSubscriptions(
    input: WorkboardNotificationListOptions = {},
  ): Promise<{ subscriptions: WorkboardNotificationSubscription[] }> {
    const boardId = normalizeBoardId(input.boardId);
    const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
    const subscriptions = (await this.subscriptionStore.entries())
      .map((entry) => entry.value)
      .filter(
        (entry): entry is PersistedWorkboardNotificationSubscription =>
          entry?.version === 1 && Boolean(entry.subscription?.id),
      )
      .map((entry) => entry.subscription)
      .filter((subscription) => !boardId || subscription.boardId === boardId)
      .filter((subscription) => !cardId || subscription.cardId === cardId)
      .toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { subscriptions };
  }

  async deleteNotificationSubscription(id: string): Promise<{ deleted: boolean }> {
    return { deleted: await this.subscriptionStore.delete(id.trim()) };
  }

  private async collectNotificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    const subscriptionId = normalizeBoundedString(
      input.subscriptionId,
      undefined,
      120,
      "subscription id",
    );
    const boardId = normalizeBoardId(input.boardId);
    const cardId = normalizeBoundedString(input.cardId, undefined, 120, "card id");
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.max(1, Math.min(200, Math.trunc(input.limit)))
        : 50;
    const subscriptionEntry = subscriptionId
      ? await this.subscriptionStore.lookup(subscriptionId)
      : undefined;
    if (subscriptionId && !subscriptionEntry?.subscription) {
      throw new Error(`notification subscription not found: ${subscriptionId}`);
    }
    const subscription = subscriptionEntry?.subscription;
    const effectiveCardId = subscription?.cardId ?? cardId;
    const effectiveBoardId = effectiveCardId ? undefined : (subscription?.boardId ?? boardId);
    const effectiveSessionKey = subscription?.sessionKey;
    const effectiveRunId = subscription?.runId;
    const events: WorkboardNotification[] = [];
    for (const card of await this.list({ boardId: effectiveBoardId })) {
      if (effectiveCardId && card.id !== effectiveCardId) {
        continue;
      }
      const stale = card.metadata?.stale;
      const notifications = [
        ...(card.metadata?.notifications ?? []),
        ...(stale
          ? [
              {
                id: `stale:${card.id}:${stale.detectedAt}`,
                kind: "stale" as const,
                createdAt: stale.detectedAt,
                sequence: stale.detectedAt * 1000,
                message: stale.reason,
                ...(cardSessionKey(card) ? { sessionKey: cardSessionKey(card) } : {}),
                ...(cardRunId(card) ? { runId: cardRunId(card) } : {}),
              },
            ]
          : []),
      ];
      for (const event of notifications) {
        const eventSessionKey = event.sessionKey ?? cardSessionKey(card);
        const eventRunId = event.runId ?? cardRunId(card);
        if (effectiveSessionKey && eventSessionKey !== effectiveSessionKey) {
          continue;
        }
        if (effectiveRunId && eventRunId !== effectiveRunId) {
          continue;
        }
        if (subscription?.eventKinds?.length && !subscription.eventKinds.includes(event.kind)) {
          continue;
        }
        const eventSequence = notificationSequence(event);
        if (subscription?.lastEventSequence && eventSequence !== undefined) {
          if (
            eventSequence < subscription.lastEventSequence ||
            (eventSequence === subscription.lastEventSequence &&
              event.id <= (subscription.lastEventId ?? ""))
          ) {
            continue;
          }
        } else if (
          subscription?.lastEventAt &&
          (event.createdAt < subscription.lastEventAt ||
            (event.createdAt === subscription.lastEventAt &&
              event.id <= (subscription.lastEventId ?? "")))
        ) {
          continue;
        }
        events.push(event);
      }
    }
    const sorted = events.toSorted(compareNotifications).slice(0, limit);
    return { ...(subscription ? { subscription } : {}), events: sorted };
  }

  async notificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    return await this.collectNotificationEvents(input);
  }

  async advanceNotificationEvents(input: WorkboardNotificationEventsInput = {}): Promise<{
    subscription?: WorkboardNotificationSubscription;
    events: WorkboardNotification[];
  }> {
    const subscriptionId = normalizeBoundedString(
      input.subscriptionId,
      undefined,
      120,
      "subscription id",
    );
    if (!subscriptionId) {
      throw new Error("subscriptionId is required to advance notification events.");
    }
    return await this.enqueueMutation(async () => {
      const result = await this.collectNotificationEvents({ ...input, subscriptionId });
      if (!result.subscription || !result.events.length) {
        return result;
      }
      const last = result.events.at(-1)!;
      const lastSequence = notificationSequence(last);
      const subscription: WorkboardNotificationSubscription = {
        ...result.subscription,
        lastEventAt: last.createdAt,
        lastEventId: last.id,
        ...(lastSequence !== undefined ? { lastEventSequence: lastSequence } : {}),
        updatedAt: Date.now(),
      };
      delete subscription.deliveredEventIds;
      if (lastSequence === undefined) {
        delete subscription.lastEventSequence;
      }
      await this.subscriptionStore.register(subscription.id, {
        version: 1,
        subscription,
      });
      return { subscription, events: result.events };
    });
  }

  async dispatch(now = Date.now()): Promise<WorkboardDispatchResult> {
    return await this.enqueueMutation(async () => {
      const promoted: WorkboardCard[] = [];
      const reclaimed: WorkboardCard[] = [];
      const blocked: WorkboardCard[] = [];
      const orchestrated: WorkboardCard[] = [];
      const orchestratedByBoard = new Map<string, number>();
      for (const card of await this.list()) {
        let latest = await this.promoteDependencyReady(card.id, now);
        const wasPromoted = latest.status !== card.status;
        const claim = latest.metadata?.claim;
        const latestAttempt = latestRunningAttempt(latest);
        const maxRuntimeSeconds = latest.metadata?.automation?.maxRuntimeSeconds;
        const runtimeStartedAt = latestAttempt?.startedAt ?? claim?.claimedAt ?? latest.startedAt;
        const timedOut =
          Boolean(maxRuntimeSeconds && runtimeStartedAt) &&
          now - runtimeStartedAt! > secondsToDurationMs(maxRuntimeSeconds!);
        const claimExpired = Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_MS);
        const retriesExhausted = retryBudgetExhausted(latest);
        if (latest.status === "running" && (timedOut || claimExpired)) {
          const reason = timedOut
            ? "Run exceeded the card max runtime."
            : "Claim expired without a recent heartbeat.";
          const execution =
            latest.execution?.status === "running"
              ? { ...latest.execution, status: "blocked" as const, updatedAt: now }
              : latest.execution;
          latest = await this.updateCard(latest.id, {
            status: "blocked",
            ...(execution ? { execution } : {}),
            metadata: {
              ...latest.metadata,
              claim: undefined,
              attempts: closeRunningAttempts(latest.metadata?.attempts, now, "blocked", reason),
              failureCount: (latest.metadata?.failureCount ?? 0) + 1,
              notifications: [
                ...(latest.metadata?.notifications ?? []),
                {
                  id: randomUUID(),
                  kind: "failed" as const,
                  createdAt: now,
                  sequence: this.nextNotificationSequence(now),
                  message: reason,
                },
              ].slice(-MAX_CARD_NOTIFICATIONS),
            },
          });
          blocked.push(latest);
        } else if (claimExpired) {
          latest = await this.updateCard(latest.id, {
            metadata: { ...latest.metadata, claim: undefined },
          });
          reclaimed.push(latest);
        }
        if (
          !latest.metadata?.claim &&
          retriesExhausted &&
          isDependencyPromotableStatus(latest.status)
        ) {
          latest = await this.updateCard(latest.id, {
            status: "blocked",
            metadata: {
              ...latest.metadata,
              notifications: [
                ...(latest.metadata?.notifications ?? []),
                {
                  id: randomUUID(),
                  kind: "failed" as const,
                  createdAt: now,
                  sequence: this.nextNotificationSequence(now),
                  message: "Card exhausted its retry budget.",
                },
              ].slice(-MAX_CARD_NOTIFICATIONS),
            },
          });
          blocked.push(latest);
        }
        if (latest.status === "ready") {
          latest = await this.recordDispatch(latest, now);
        }
        if (await this.shouldAutoOrchestrate(latest)) {
          const boardId = cardBoardId(latest);
          const board = await this.boardStore.lookup(boardId);
          const cap = board?.board.orchestration?.autoDecomposePerDispatch ?? 3;
          const boardCount = orchestratedByBoard.get(boardId) ?? 0;
          if (boardCount < cap) {
            latest = await this.recordOrchestrationCandidate(latest, now);
            orchestrated.push(latest);
            orchestratedByBoard.set(boardId, boardCount + 1);
          }
        }
        if (wasPromoted && latest.status !== "blocked") {
          promoted.push(latest);
        }
      }
      return {
        promoted,
        reclaimed,
        blocked,
        orchestrated,
        count: promoted.length + reclaimed.length + blocked.length + orchestrated.length,
      };
    });
  }

  async bulkUpdate(input: WorkboardBulkInput): Promise<{ cards: WorkboardCard[] }> {
    const ids = Array.isArray(input.ids)
      ? input.ids.filter((id): id is string => typeof id === "string" && id.trim() !== "")
      : [];
    if (ids.length === 0) {
      throw new Error("ids are required.");
    }
    const patch =
      input.patch && typeof input.patch === "object" && !Array.isArray(input.patch)
        ? (input.patch as WorkboardCardPatch)
        : {};
    const cards: WorkboardCard[] = [];
    for (const id of ids) {
      const updated =
        input.archived === undefined
          ? await this.update(id, patch)
          : await this.archive(id, input.archived);
      cards.push(updated);
    }
    return { cards };
  }

  async archive(id: string, archived: unknown): Promise<WorkboardCard> {
    const shouldArchive = archived !== false;
    return await this.updateMetadata(id, (existing) => ({
      ...existing.metadata,
      archivedAt: shouldArchive ? Date.now() : 0,
    }));
  }

  async exportCards(): Promise<{
    cards: WorkboardCard[];
    attachments: WorkboardAttachment[];
    exportedAt: number;
  }> {
    const cards = await this.list();
    const attachments = cards.flatMap((card) => card.metadata?.attachments ?? []);
    return { cards, attachments, exportedAt: Date.now() };
  }

  async diagnostics(now = Date.now()): Promise<WorkboardDiagnosticsResult> {
    const cards = await this.list();
    const rows = cards.flatMap((card) => {
      const diagnostics = computeCardDiagnostics(card, now);
      return diagnostics.length ? [{ card, diagnostics }] : [];
    });
    return {
      diagnostics: rows,
      count: rows.reduce((total, row) => total + row.diagnostics.length, 0),
    };
  }

  async refreshDiagnostics(now = Date.now()): Promise<WorkboardDiagnosticsResult> {
    return await this.enqueueMutation(async () => {
      const cards = await this.list();
      const rows: WorkboardDiagnosticsResult["diagnostics"] = [];
      for (const card of cards) {
        const latest = await this.get(card.id);
        if (!latest) {
          continue;
        }
        const diagnostics = mergeDiagnostics(
          latest.metadata?.diagnostics,
          computeCardDiagnostics(latest, now),
        );
        if (diagnostics.length === 0 && !latest.metadata?.diagnostics?.length) {
          continue;
        }
        const metadata = trimMetadataToBudget({ ...latest.metadata, diagnostics });
        const next = removeUndefinedCardFields({
          ...latest,
          metadata: metadataIsEmpty(metadata) ? undefined : metadata,
        });
        await this.store.register(next.id, { version: 1, card: next });
        if (diagnostics.length > 0) {
          rows.push({ card: next, diagnostics });
        }
      }
      return {
        diagnostics: rows,
        count: rows.reduce((total, row) => total + row.diagnostics.length, 0),
      };
    });
  }

  async buildWorkerContext(id: string): Promise<string> {
    const card = await this.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    return buildWorkerContext(card, await this.list());
  }

  static open(
    openKeyedStore: (options: {
      namespace: string;
      maxEntries: number;
    }) => WorkboardKeyedStore<unknown>,
  ) {
    return new WorkboardStore(
      openKeyedStore({
        namespace: "workboard.cards",
        maxEntries: MAX_CARDS,
      }) as WorkboardKeyedStore,
      {
        boards: openKeyedStore({
          namespace: "workboard.boards",
          maxEntries: 200,
        }) as WorkboardKeyedStore<PersistedWorkboardBoard>,
        subscriptions: openKeyedStore({
          namespace: "workboard.notify",
          maxEntries: 2000,
        }) as WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>,
        attachments: openKeyedStore({
          namespace: "workboard.attachments",
          maxEntries: MAX_ATTACHMENT_ENTRIES,
        }) as WorkboardKeyedStore<PersistedWorkboardAttachment>,
      },
    );
  }

  static openSqlite() {
    const stores = createWorkboardSqliteStores();
    return new WorkboardStore(stores.cards, {
      boards: stores.boards,
      subscriptions: stores.subscriptions,
      attachments: stores.attachments,
    });
  }
}
