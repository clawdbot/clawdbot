import { randomUUID } from "node:crypto";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_CARD_ARTIFACTS,
  MAX_CARD_ATTACHMENTS,
  MAX_CARD_ATTEMPTS,
  MAX_CARD_COMMENTS,
  MAX_CARD_DIAGNOSTICS,
  MAX_CARD_EVENTS,
  MAX_CARD_LINKS,
  MAX_CARD_METADATA_BYTES,
  MAX_CARD_NOTIFICATIONS,
  MAX_CARD_PROOF,
  MAX_CARD_WORKER_LOGS,
} from "./store-constants.js";
import type {
  WorkboardAttachmentInput,
  WorkboardBoardInput,
  WorkboardNotificationSubscribeInput,
  WorkboardProofInput,
} from "./store-inputs.js";
import {
  WORKBOARD_ATTEMPT_STATUSES,
  WORKBOARD_DIAGNOSTIC_KINDS,
  WORKBOARD_DIAGNOSTIC_SEVERITIES,
  WORKBOARD_EVENT_KINDS,
  WORKBOARD_EXECUTION_ENGINES,
  WORKBOARD_EXECUTION_MODES,
  WORKBOARD_EXECUTION_STATUSES,
  WORKBOARD_LINK_TYPES,
  WORKBOARD_NOTIFICATION_KINDS,
  WORKBOARD_PRIORITIES,
  WORKBOARD_PROOF_STATUSES,
  WORKBOARD_STATUSES,
  WORKBOARD_TEMPLATE_IDS,
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

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeBoardId(value: unknown, fallback?: string): string | undefined {
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

export function normalizeBoardIdRequired(value: unknown): string {
  return normalizeBoardId(value) ?? "default";
}

export function normalizeBoardMetadata(
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

export function normalizeNotificationSubscription(
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
  const preservedFields: Partial<WorkboardNotificationSubscription> = {};
  if (fallback) {
    if (fallback.lastEventAt) {
      preservedFields.lastEventAt = fallback.lastEventAt;
    }
    if (fallback.lastEventId) {
      preservedFields.lastEventId = fallback.lastEventId;
    }
    if (fallback.lastEventSequence) {
      preservedFields.lastEventSequence = fallback.lastEventSequence;
    }
    if (fallback.deliveredEventIds?.length) {
      preservedFields.deliveredEventIds = fallback.deliveredEventIds;
    }
  }
  return {
    id: fallback?.id ?? randomUUID(),
    boardId,
    ...(cardId ? { cardId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(target ? { target } : {}),
    ...(eventKinds ? { eventKinds } : {}),
    ...preservedFields,
    createdAt: fallback?.createdAt ?? now,
    updatedAt: now,
  };
}

export function normalizeTitle(value: unknown): string {
  const title = normalizeOptionalString(value);
  if (!title) {
    throw new Error("title is required.");
  }
  if (title.length > 180) {
    throw new Error("title must be 180 characters or fewer.");
  }
  return title;
}

export function normalizeNotes(value: unknown): string | undefined {
  const notes = normalizeOptionalString(value);
  if (!notes) {
    return undefined;
  }
  if (notes.length > 4000) {
    throw new Error("notes must be 4000 characters or fewer.");
  }
  return notes;
}

export function normalizeBoundedString(
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

export function normalizeStatus(value: unknown, fallback: WorkboardStatus): WorkboardStatus {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_STATUSES as readonly string[]).includes(value)) {
    return value as WorkboardStatus;
  }
  throw new Error(`status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`);
}

export function normalizePriority(value: unknown, fallback: WorkboardPriority): WorkboardPriority {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  if ((WORKBOARD_PRIORITIES as readonly string[]).includes(value)) {
    return value as WorkboardPriority;
  }
  throw new Error(`priority must be one of: ${WORKBOARD_PRIORITIES.join(", ")}.`);
}

export function normalizeLabels(value: unknown, fallback: string[] = []): string[] {
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

export function normalizeStringList(value: unknown, fieldName: string, maxLength = 80): string[] {
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

export function normalizePosition(value: unknown, fallback: number): number {
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
  const sourcePath = normalizeBoundedString(
    record.sourcePath,
    fallback?.sourcePath,
    2000,
    "workspace source path",
  );
  if (sourcePath && !isAbsoluteWorkspacePath(sourcePath)) {
    throw new Error("workspace source path must be absolute.");
  }
  const sourceBranch = normalizeBoundedString(
    record.sourceBranch,
    fallback?.sourceBranch,
    160,
    "workspace source branch",
  );
  return {
    kind,
    ...(workspacePath ? { path: workspacePath } : {}),
    ...(branch ? { branch } : {}),
    ...(kind === "worktree" && sourcePath ? { sourcePath } : {}),
    ...(kind === "worktree" && sourceBranch ? { sourceBranch } : {}),
  };
}

export function normalizeAutomation(
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

export function deriveChildIdempotencyKey(
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

export function normalizeLinkType(value: unknown, fallback: WorkboardLinkType): WorkboardLinkType {
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

export function normalizeTemplateId(value: unknown): WorkboardTemplateId | undefined {
  return typeof value === "string" && WORKBOARD_TEMPLATE_IDS.includes(value as WorkboardTemplateId)
    ? (value as WorkboardTemplateId)
    : undefined;
}

export function normalizeTimestamp(value: unknown, fallback: number): number {
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

export function normalizeEvents(value: unknown): WorkboardEvent[] {
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

export function normalizeArtifact(value: unknown): WorkboardArtifact | null {
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

export function normalizeAttachmentInput(
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

export function normalizeProofInput(input: WorkboardProofInput, now: number): WorkboardProof {
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

export function normalizeMetadata(
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

export function normalizeExecution(value: unknown): WorkboardExecution | undefined {
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

export function syncExecutionSessionKey(
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

export function removeUndefinedMetadataFields(metadata: WorkboardMetadata): WorkboardMetadata {
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

export function clearDiagnostics(
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

export function metadataIsEmpty(metadata: WorkboardMetadata | undefined): boolean {
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

export function appendLinkPreservingDependencies(
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

export function trimMetadataToBudget(metadata: WorkboardMetadata): WorkboardMetadata {
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
