import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeQueueMode } from "../../../../src/auto-reply/reply/queue/normalize.js";
import { normalizeAgentId } from "../sessions/session-key.ts";
import type { ChatAttachment, ChatGoalDraftMode, ChatQueueItem } from "./chat-types.ts";
import { isChatGoalDraftMode } from "./goal-draft.ts";
import { normalizeSenderIdentity } from "./sender-label.ts";

export const MAX_STORED_SESSIONS = 20;
export const MAX_STORED_QUEUE_ITEMS = 50;
// Shipped v1 state could hold one full queue under each of 20 alias keys.
// Alias consolidation may exceed today's admission cap, but must retain every
// existing input while the canonical queue drains back below 50.
const MAX_RETAINED_QUEUE_ITEMS = MAX_STORED_SESSIONS * MAX_STORED_QUEUE_ITEMS;
export const INTERRUPTED_SETTINGS_WAIT_ERROR =
  "Chat settings update was interrupted. Review and retry when ready.";

export type StoredComposerSession = {
  awaitingDefaults?: true;
  draft?: string;
  goalMode?: ChatGoalDraftMode;
  draftRevision?: number;
  queue?: ChatQueueItem[];
  updatedAt: number;
};

export function sameQueuedDeliveryVersion(left: ChatQueueItem, right: ChatQueueItem): boolean {
  return (
    left.id === right.id &&
    left.sendRunId === right.sendRunId &&
    left.sendAttempts === right.sendAttempts &&
    left.sendState === right.sendState &&
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.orderKey === right.orderKey &&
    left.attachmentPayload?.key === right.attachmentPayload?.key
  );
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const entry = value;
  const id = normalizeOptionalString(entry.id);
  const mimeType = normalizeOptionalString(entry.mimeType);
  if (!id || !mimeType) {
    return null;
  }
  const restored: ChatAttachment = { id, mimeType };
  const fileName = normalizeOptionalString(entry.fileName);
  if (fileName) {
    restored.fileName = fileName;
  }
  if (typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)) {
    restored.sizeBytes = entry.sizeBytes;
  }
  const dataUrl = normalizeOptionalString(entry.dataUrl);
  if (dataUrl) {
    restored.dataUrl = dataUrl;
  }
  return restored;
}

export function normalizeStoredQueueItem(value: unknown): ChatQueueItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const entry = value;
  const id = normalizeOptionalString(entry.id);
  const text = typeof entry.text === "string" ? entry.text : "";
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now();
  if (
    !id ||
    (!text.trim() &&
      !Array.isArray(entry.attachments) &&
      entry.attachmentPayload === undefined &&
      entry.attachmentStorageError === undefined)
  ) {
    return null;
  }
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments
        .map(normalizeChatAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : [];
  const item: ChatQueueItem = { id, text, createdAt };
  if (entry.attachmentPayload !== undefined) {
    const payload = entry.attachmentPayload;
    if (
      isRecord(payload) &&
      typeof payload.key === "string" &&
      typeof payload.recoveryScope === "string" &&
      typeof payload.tabId === "string"
    ) {
      item.attachmentPayload = {
        key: payload.key,
        recoveryScope: payload.recoveryScope,
        tabId: payload.tabId,
      };
    } else {
      item.attachmentStorageError = "missing";
    }
  }
  if (
    entry.attachmentStorageError === "missing" ||
    entry.attachmentStorageError === "unavailable" ||
    entry.attachmentStorageError === "capacity"
  ) {
    item.attachmentStorageError = entry.attachmentStorageError;
  }
  if (Array.isArray(entry.attachments) && attachments.length !== entry.attachments.length) {
    item.attachmentStorageError = "missing";
  }
  if (item.attachmentPayload && !attachments.length) {
    item.attachmentStorageError = "missing";
  }

  if (entry.intent !== undefined) {
    const intent = entry.intent;
    // Never restore a structured admission as ordinary text after losing its intent.
    if (
      !isRecord(intent) ||
      Object.keys(intent).length !== 3 ||
      intent.kind !== "session-goal-start" ||
      intent.version !== 1 ||
      typeof intent.issuedAtMs !== "number" ||
      !Number.isSafeInteger(intent.issuedAtMs) ||
      intent.issuedAtMs <= 0
    ) {
      return null;
    }
    item.intent = { kind: intent.kind, version: intent.version, issuedAtMs: intent.issuedAtMs };
    const sessionId = normalizeOptionalString(entry.sessionId);
    if (sessionId) {
      item.sessionId = sessionId;
    }
    if (entry.expectedLeafEntryId === null || typeof entry.expectedLeafEntryId === "string") {
      item.expectedLeafEntryId = entry.expectedLeafEntryId;
    }
  }
  if (typeof entry.orderKey === "number" && Number.isFinite(entry.orderKey)) {
    item.orderKey = entry.orderKey;
  }
  const sender = normalizeSenderIdentity(entry.sender as Record<string, unknown> | undefined);
  if (sender) {
    item.sender = sender;
  }
  const legacySteer =
    entry.kind === "steered" ||
    normalizeOptionalString(entry.steerTargetRunId) !== undefined ||
    entry.sendState === "steering";
  const queueMode = legacySteer
    ? "steer"
    : normalizeQueueMode(typeof entry.queueMode === "string" ? entry.queueMode : undefined);
  if (queueMode) {
    item.queueMode = queueMode;
  }
  if (attachments.length) {
    item.attachments = attachments;
  }
  const refreshSessions = normalizeOptionalBoolean(entry.refreshSessions);
  if (refreshSessions !== undefined) {
    item.refreshSessions = refreshSessions;
  }
  const replyToId = normalizeOptionalString(entry.replyToId);
  if (replyToId) {
    item.replyToId = replyToId;
  }
  if (entry.sendState === "steering" || entry.sendState === "executing-command") {
    item.sendState = "unconfirmed";
  } else if (entry.sendState === "sending") {
    item.sendState = "waiting-reconnect";
  } else if (
    entry.sendState === "failed" ||
    entry.sendState === "unconfirmed" ||
    entry.sendState === "waiting-idle" ||
    entry.sendState === "waiting-reconnect"
  ) {
    item.sendState = entry.sendState;
  } else if (entry.sendState === "waiting-model") {
    item.sendState = "failed";
    item.sendError = INTERRUPTED_SETTINGS_WAIT_ERROR;
  }
  const sendError = normalizeOptionalString(entry.sendError);
  if (sendError) {
    item.sendError = sendError;
  }
  const sendRunId = normalizeOptionalString(entry.sendRunId);
  if (sendRunId) {
    item.sendRunId = sendRunId;
  }
  if (typeof entry.sendAttempts === "number" && Number.isFinite(entry.sendAttempts)) {
    item.sendAttempts = entry.sendAttempts;
  }
  const localCommandArgs = normalizeOptionalString(entry.localCommandArgs);
  if (localCommandArgs) {
    item.localCommandArgs = localCommandArgs;
  }
  const localCommandName = normalizeOptionalString(entry.localCommandName);
  if (localCommandName) {
    item.localCommandName = localCommandName;
  }
  const sessionKey = normalizeOptionalString(entry.sessionKey);
  if (sessionKey) {
    item.sessionKey = sessionKey;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  if (agentId) {
    item.agentId = normalizeAgentId(agentId);
  }
  return item;
}

export function normalizeStoredSession(value: unknown): StoredComposerSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const entry = value;
  const draft = typeof entry.draft === "string" ? entry.draft : undefined;
  if (entry.goalMode !== undefined && !isChatGoalDraftMode(entry.goalMode)) {
    return null;
  }
  const goalMode = entry.goalMode;
  // Reject oversize input as a whole; migration keeps its source bytes intact.
  if (Array.isArray(entry.queue) && entry.queue.length > MAX_RETAINED_QUEUE_ITEMS) {
    return null;
  }
  const normalizedQueue = Array.isArray(entry.queue)
    ? entry.queue
        .map(normalizeStoredQueueItem)
        .filter((item): item is ChatQueueItem => item !== null)
    : undefined;
  // v1 writers used bounded tombstones. Consume them while reading legacy
  // state, but never copy them into the item-level outbox representation.
  const removedQueueItemIds = Array.isArray(entry.removedQueueItemIds)
    ? entry.removedQueueItemIds
        .map(normalizeOptionalString)
        .filter((id): id is string => id !== undefined)
    : undefined;
  const removedIds = new Set(removedQueueItemIds ?? []);
  const queue = normalizedQueue?.filter((item) => !removedIds.has(item.id));
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const storedDraftRevision =
    typeof entry.draftRevision === "number" && Number.isSafeInteger(entry.draftRevision)
      ? entry.draftRevision
      : undefined;
  // Legacy rows did not version drafts, so their row timestamp is the best
  // available ordering signal. Queue-only rows must not claim draft ownership.
  const draftRevision = storedDraftRevision ?? (draft ? updatedAt : undefined);
  if (!draft && !goalMode && draftRevision === undefined && (!queue || queue.length === 0)) {
    return null;
  }
  return {
    ...(entry.awaitingDefaults === true ? { awaitingDefaults: true } : {}),
    ...(draft ? { draft } : {}),
    ...(goalMode ? { goalMode } : {}),
    ...(draftRevision !== undefined ? { draftRevision } : {}),
    ...(queue && queue.length > 0 ? { queue } : {}),
    updatedAt,
  };
}
