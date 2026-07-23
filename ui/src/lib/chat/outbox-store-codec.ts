import { normalizeAgentId } from "../sessions/session-key.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "./chat-types.ts";
import { normalizeSenderIdentity } from "./sender-label.ts";

export const MAX_STORED_SESSIONS = 20;
export const MAX_STORED_QUEUE_ITEMS = 50;
// Shipped v1 state could hold one full queue under each of 20 alias keys.
// Alias consolidation may exceed today's admission cap, but must retain every
// existing input while the canonical queue drains back below 50.
export const MAX_RETAINED_QUEUE_ITEMS = MAX_STORED_SESSIONS * MAX_STORED_QUEUE_ITEMS;
export const INTERRUPTED_SETTINGS_WAIT_ERROR =
  "Chat settings update was interrupted. Review and retry when ready.";

export type StoredComposerSession = {
  draft?: string;
  draftRevision?: number;
  queue?: ChatQueueItem[];
  updatedAt: number;
};

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
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

export function normalizeSkillWorkshopRevision(
  value: unknown,
): ChatQueueSkillWorkshopRevision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const proposalId = normalizeOptionalString(entry.proposalId);
  if (!proposalId) {
    return undefined;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  return {
    proposalId,
    ...(agentId ? { agentId: normalizeAgentId(agentId) } : {}),
  };
}

function normalizeQueueItem(value: unknown): ChatQueueItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const text = typeof entry.text === "string" ? entry.text : "";
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now();
  if (!id || (!text.trim() && !Array.isArray(entry.attachments))) {
    return null;
  }
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments
        .map(normalizeChatAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : [];
  const item: ChatQueueItem = { id, text, createdAt };
  const sender = normalizeSenderIdentity(entry.sender as Record<string, unknown> | undefined);
  if (sender) {
    item.sender = sender;
  }
  if (entry.kind === "queued" || entry.kind === "steered") {
    item.kind = entry.kind;
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
  if (
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
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(entry.skillWorkshopRevision);
  if (skillWorkshopRevision) {
    item.skillWorkshopRevision = skillWorkshopRevision;
  }
  return item;
}

export function normalizeStoredSession(value: unknown): StoredComposerSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const draft = typeof entry.draft === "string" ? entry.draft : undefined;
  const normalizedQueue = Array.isArray(entry.queue)
    ? entry.queue
        .slice(0, MAX_RETAINED_QUEUE_ITEMS)
        .map(normalizeQueueItem)
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
  if (!draft && draftRevision === undefined && (!queue || queue.length === 0)) {
    return null;
  }
  return {
    ...(draft ? { draft } : {}),
    ...(draftRevision !== undefined ? { draftRevision } : {}),
    ...(queue && queue.length > 0 ? { queue } : {}),
    updatedAt,
  };
}
