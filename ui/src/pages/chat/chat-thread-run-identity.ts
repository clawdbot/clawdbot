import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { userTurnSendIdentity, type TurnInsertionBounds } from "./chat-thread-items.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";

export function transcriptRunId(message: unknown): string | undefined {
  const identity = readSessionMessageIdentity(message);
  if (identity?.runId) {
    return identity.runId;
  }
  const record = asRecord(message);
  return (
    readLiveTerminalRunId(message) ??
    normalizeOptionalString(record?.runId) ??
    normalizeOptionalString(asRecord(record?.openclawStreamFallback)?.runId)
  );
}

export function isKeyedAssistantStreamFallbackMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (normalizeLowercaseStringOrEmpty(record?.role) !== "assistant") {
    return false;
  }
  const fallback = asRecord(record?.openclawStreamFallback);
  return typeof fallback?.itemId === "string" && fallback.itemId.trim().length > 0;
}

export function optionalRunIdentity(value: unknown): { runId: string } | undefined {
  const runId = normalizeOptionalString(value);
  return runId ? { runId } : undefined;
}

export function optionalBoundaryIdentity(value: unknown): { boundaryId: string } | undefined {
  const runId = normalizeOptionalString(value);
  return runId ? { boundaryId: `send:${runId}` } : undefined;
}

export function streamPartRunId(
  part: Extract<ChatItem, { kind: "stream" | "reading-indicator" | "question" }>,
): string | undefined {
  return part.kind === "question" ? undefined : part.runId;
}

export function streamPartBoundaryId(
  part: Extract<ChatItem, { kind: "stream" | "reading-indicator" | "question" }>,
): string | undefined {
  return part.kind === "question" ? undefined : part.boundaryId;
}

function isUserChatItem(item: ChatItem): boolean {
  if (item.kind !== "message") {
    return false;
  }
  const normalized = safeNormalizeMessage(item.message);
  return normalized ? normalizeRoleForGrouping(normalized.role).toLowerCase() === "user" : false;
}

export function findCurrentTurnBounds(items: ChatItem[]): TurnInsertionBounds | null {
  const index = items.findLastIndex(isUserChatItem);
  const item = items[index];
  return index >= 0 && item ? { afterKey: item.key } : null;
}

export function findRunTurnBounds(items: ChatItem[], runId: string): TurnInsertionBounds | null {
  const sendIdentity = `send:${runId}`;
  const index = items.findIndex(
    (item) =>
      item.kind === "message" &&
      isUserChatItem(item) &&
      userTurnSendIdentity(item.message) === sendIdentity,
  );
  const item = items[index];
  if (index < 0 || !item) {
    return null;
  }
  const nextUser = items.slice(index + 1).find(isUserChatItem);
  return { afterKey: item.key, ...(nextUser ? { beforeKey: nextUser.key } : {}) };
}

export function resolveRunInsertionBounds(
  items: ChatItem[],
  runId: unknown,
  currentRunId: string | null | undefined,
  currentTurnBounds: TurnInsertionBounds | null,
): TurnInsertionBounds | null {
  if (typeof runId !== "string" || !runId.trim()) {
    return currentRunId != null ? currentTurnBounds : null;
  }
  const runBounds = findRunTurnBounds(items, runId);
  if (runId === currentRunId) {
    // Active runs can span steers: the original prompt is a floor, not a ceiling.
    return runBounds ? { afterKey: runBounds.afterKey } : currentTurnBounds;
  }
  if (runBounds || currentRunId == null) {
    return runBounds;
  }
  // Legacy rows may lack the user-run identity needed for exact bounds. Keep
  // them ordered before the current prompt instead of attaching them to it.
  return currentTurnBounds?.afterKey ? { beforeKey: currentTurnBounds.afterKey } : null;
}
