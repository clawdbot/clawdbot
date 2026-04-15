import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

export const MATRIX_ANNOTATION_RELATION_TYPE = "m.annotation";
export const MATRIX_REACTION_EVENT_TYPE = "m.reaction";

export type MatrixReactionEventContent = {
  "m.relates_to": {
    rel_type: typeof MATRIX_ANNOTATION_RELATION_TYPE;
    event_id: string;
    key: string;
  };
};

export type MatrixReactionSummary = {
  key: string;
  count: number;
  users: string[];
};

export type MatrixReactionAnnotation = {
  key: string;
  eventId?: string;
};

type MatrixReactionEventLike = {
  content?: unknown;
  sender?: string | null;
  event_id?: string | null;
};

export function normalizeMatrixReactionMessageId(messageId: string): string {
  const normalized = messageId.trim();
  if (!normalized) {
    throw new Error("Matrix reaction requires a messageId");
  }
  return normalized;
}

export function normalizeMatrixReactionEmoji(emoji: string): string {
  const normalized = emoji.trim();
  if (!normalized) {
    throw new Error("Matrix reaction requires an emoji");
  }
  return normalized;
}

export function buildMatrixReactionContent(
  messageId: string,
  emoji: string,
): MatrixReactionEventContent {
  return {
    "m.relates_to": {
      rel_type: MATRIX_ANNOTATION_RELATION_TYPE,
      event_id: normalizeMatrixReactionMessageId(messageId),
      key: normalizeMatrixReactionEmoji(emoji),
    },
  };
}

export function buildMatrixReactionRelationsPath(roomId: string, messageId: string): string {
  return `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(normalizeMatrixReactionMessageId(messageId))}/${MATRIX_ANNOTATION_RELATION_TYPE}/${MATRIX_REACTION_EVENT_TYPE}`;
}

export function extractMatrixReactionAnnotation(
  content: unknown,
): MatrixReactionAnnotation | undefined {
  if (!content || typeof content !== "object") {
    return undefined;
  }
  const relatesTo = (
    content as {
      "m.relates_to"?: {
        rel_type?: unknown;
        event_id?: unknown;
        key?: unknown;
      };
    }
  )["m.relates_to"];
  if (!relatesTo || typeof relatesTo !== "object") {
    return undefined;
  }
  if (
    typeof relatesTo.rel_type === "string" &&
    relatesTo.rel_type !== MATRIX_ANNOTATION_RELATION_TYPE
  ) {
    return undefined;
  }
  const key = normalizeOptionalString(relatesTo.key) ?? "";
  if (!key) {
    return undefined;
  }
  const eventId = normalizeOptionalString(relatesTo.event_id) ?? "";
  return {
    key,
    eventId: eventId || undefined,
  };
}

export function extractMatrixReactionKey(content: unknown): string | undefined {
  return extractMatrixReactionAnnotation(content)?.key;
}

export function summarizeMatrixReactionEvents(
  events: Iterable<Pick<MatrixReactionEventLike, "content" | "sender">>,
): MatrixReactionSummary[] {
  const summaries = new Map<string, MatrixReactionSummary>();
  for (const event of events) {
    const key = extractMatrixReactionKey(event.content);
    if (!key) {
      continue;
    }
    const sender = normalizeOptionalString(event.sender) ?? "";
    const entry = summaries.get(key) ?? { key, count: 0, users: [] };
    entry.count += 1;
    if (sender && !entry.users.includes(sender)) {
      entry.users.push(sender);
    }
    summaries.set(key, entry);
  }
  return Array.from(summaries.values());
}

export function selectOwnMatrixReactionEventIds(
  events: Iterable<Pick<MatrixReactionEventLike, "content" | "event_id" | "sender">>,
  userId: string,
  emoji?: string,
): string[] {
  const senderId = normalizeOptionalString(userId) ?? "";
  if (!senderId) {
    return [];
  }
  const targetEmoji = normalizeOptionalString(emoji);
  const ids: string[] = [];
  for (const event of events) {
    if ((normalizeOptionalString(event.sender) ?? "") !== senderId) {
      continue;
    }
    if (targetEmoji && extractMatrixReactionKey(event.content) !== targetEmoji) {
      continue;
    }
    const eventId = normalizeOptionalString(event.event_id);
    if (eventId) {
      ids.push(eventId);
    }
  }
  return ids;
}
