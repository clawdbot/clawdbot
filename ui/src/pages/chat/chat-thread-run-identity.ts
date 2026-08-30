import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { userTurnSendIdentity, type TurnInsertionBounds } from "./chat-thread-items.ts";
import { chatItemStartsUserTurn, safeNormalizeMessage } from "./chat-turn-boundary.ts";
import { readLiveTerminalRunId } from "./terminal-message-identity.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

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

export function readAssistantStreamSegmentIdentity(
  message: unknown,
): { itemId: string; runId?: string } | undefined {
  const record = asRecord(message);
  if (normalizeLowercaseStringOrEmpty(record?.role) !== "assistant") {
    return undefined;
  }
  const fallback = asRecord(record?.openclawStreamFallback);
  const itemId = normalizeOptionalString(fallback?.itemId);
  return itemId ? { itemId, ...optionalRunIdentity(transcriptRunId(message)) } : undefined;
}

export function isKeyedAssistantStreamFallbackMessage(message: unknown): boolean {
  return readAssistantStreamSegmentIdentity(message) !== undefined;
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

/** A persisted invocation owns its live echo's interval even without a user send key. */
export function applyPersistedToolInvocationBounds(
  items: ChatItem[],
  tools: Array<{ key: string; message: unknown }>,
  insertionBounds: Map<string, TurnInsertionBounds>,
): void {
  const invocations = new Map<string, TurnInsertionBounds | null>();
  let bounds: TurnInsertionBounds = {};
  for (const item of items) {
    if (item.kind === "divider") {
      invocations.clear();
    }
    if (chatItemStartsUserTurn(item) || item.kind === "divider") {
      bounds.beforeKey = item.key;
      bounds = { afterKey: item.key };
    } else if (item.kind === "message") {
      for (const ref of extractToolMessageRefs(item.message)) {
        if (!ref.runId) {
          continue;
        }
        const key = buildToolStreamIdentity(ref.runId, ref.id);
        // Reused identities on opposite sides of a user/reset remain ambiguous.
        invocations.set(
          key,
          invocations.has(key) && invocations.get(key) !== bounds ? null : bounds,
        );
      }
    }
  }
  for (const tool of tools) {
    const refs = extractToolMessageRefs(tool.message);
    const matching = refs.map((ref) =>
      ref.runId ? invocations.get(buildToolStreamIdentity(ref.runId, ref.id)) : undefined,
    );
    const [first] = matching;
    if (first && matching.every((candidate) => candidate === first)) {
      insertionBounds.set(tool.key, first);
    }
  }
}
