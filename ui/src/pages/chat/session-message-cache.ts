// Control UI chat module implements bounded visible-message caching.
import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import {
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

// JSON code-unit weight bounds retained payloads without allocating another
// UTF-8 buffer on the route-switch path.
const MAX_CACHED_CHAT_SNAPSHOT_WEIGHT = 12 * 1024 * 1024;
const MAX_CACHED_CHAT_WEIGHT = 24 * 1024 * 1024;
// History reconciliation replaces changed messages and retains unchanged
// objects, so serialization weight can follow the same immutable identity.
const cachedMessageWeights = new WeakMap<object, number>();
const appendedEventClaims = new WeakMap<ChatMessageCache, WeakSet<object>>();

type ChatSessionSnapshot = {
  displayedLeafEntryId?: string | null;
  messages: unknown[];
  pagination: ChatHistoryPagination;
  sessionId: string | null;
};

type CachedChatSessionSnapshot = {
  snapshot: ChatSessionSnapshot;
  weight: number;
};

export type ChatMessageCache = Map<string, CachedChatSessionSnapshot>;

type ChatMessageCacheTarget = {
  sessionKey: string;
  agentId?: string | null;
};

type ChatMessageCacheHost = Pick<
  UiSessionDefaultsHost,
  "assistantAgentId" | "agentsList" | "hello"
>;

function resolveCacheAgentId(host: ChatMessageCacheHost, target: ChatMessageCacheTarget): string {
  const explicitAgentId = target.agentId?.trim();
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  const parsed = parseAgentSessionKey(target.sessionKey);
  if (parsed) {
    return normalizeAgentId(parsed.agentId);
  }
  return isUiGlobalSessionKey(target.sessionKey)
    ? resolveUiSelectedGlobalAgentId(host)
    : resolveUiDefaultAgentId(host);
}

function resolveCanonicalSessionKey(host: ChatMessageCacheHost, sessionKey: string): string {
  const normalizedSessionKey = normalizeSessionKeyForUiComparison(sessionKey);
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  const normalized = parsed
    ? normalizedSessionKey.split(":").slice(2).join(":")
    : normalizedSessionKey;
  const configuredMainKey = resolveUiConfiguredMainKey(host);
  return isUiGlobalSessionKey(sessionKey) ||
    normalized === DEFAULT_MAIN_KEY ||
    normalized === configuredMainKey
    ? DEFAULT_MAIN_KEY
    : normalized;
}

function resolveChatMessageCacheKey(
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): string {
  const agentId = resolveCacheAgentId(host, target);
  const sessionKey = resolveCanonicalSessionKey(host, target.sessionKey);
  return `agent:${agentId}:${sessionKey}`;
}

export function appendChatMessageToCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  message: unknown,
  eventClaim?: object,
): void {
  if (eventClaim) {
    let claims = appendedEventClaims.get(cache);
    if (!claims) {
      claims = new WeakSet();
      appendedEventClaims.set(cache, claims);
    }
    if (claims.has(eventClaim)) {
      return;
    }
    claims.add(eventClaim);
  }
  const cacheKey = resolveChatMessageCacheKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (!existing) {
    cacheChatSessionSnapshot(cache, host, target, {
      messages: [message],
      pagination: { hasMore: false },
      sessionId: null,
    });
    return;
  }
  const messageWeight = serializedArrayItemWeight(message);
  if (messageWeight === null) {
    cache.delete(cacheKey);
    return;
  }
  const snapshot = {
    ...(Object.hasOwn(existing.snapshot, "displayedLeafEntryId")
      ? { displayedLeafEntryId: existing.snapshot.displayedLeafEntryId }
      : {}),
    messages: [...existing.snapshot.messages, message],
    pagination: existing.snapshot.pagination,
    sessionId: existing.snapshot.sessionId,
  };
  const weight = existing.weight + messageWeight + (existing.snapshot.messages.length > 0 ? 1 : 0);
  if (weight > MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
    cacheChatSessionSnapshot(cache, host, target, snapshot);
    return;
  }
  setSessionCacheValue(cache, cacheKey, {
    snapshot,
    weight,
  });
  trimChatSessionSnapshotCache(cache);
}

export function readChatMessagesFromCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): unknown[] {
  return readChatSessionSnapshot(cache, host, target)?.messages ?? [];
}

export function clearChatMessagesFromCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): void {
  cache.delete(resolveChatMessageCacheKey(host, target));
}

export function cacheChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  snapshot: ChatSessionSnapshot,
): void {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (
    existing?.snapshot.messages === snapshot.messages &&
    existing.snapshot.sessionId === snapshot.sessionId &&
    existing.snapshot.displayedLeafEntryId === snapshot.displayedLeafEntryId &&
    samePagination(existing.snapshot.pagination, snapshot.pagination)
  ) {
    return;
  }
  if (
    snapshot.messages.length === 0 &&
    snapshot.sessionId === null &&
    !snapshot.pagination.hasMore &&
    (snapshot.pagination.totalMessages ?? 0) === 0 &&
    snapshot.pagination.completeSnapshot !== true
  ) {
    cache.delete(cacheKey);
    return;
  }
  const bounded = boundChatSessionSnapshot(snapshot);
  if (!bounded) {
    cache.delete(cacheKey);
    return;
  }
  setSessionCacheValue(cache, cacheKey, bounded);
  trimChatSessionSnapshotCache(cache);
}

export function readChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): ChatSessionSnapshot | null {
  return getSessionCacheValue(cache, resolveChatMessageCacheKey(host, target))?.snapshot ?? null;
}

function boundChatSessionSnapshot(snapshot: ChatSessionSnapshot): CachedChatSessionSnapshot | null {
  const messageWeights = measureMessageWeights(snapshot.messages);
  if (!messageWeights) {
    return null;
  }
  let retainedMessageWeight = messageWeights.reduce((sum, weight) => sum + weight, 0);
  let start = 0;
  while (true) {
    const pagination =
      start === 0
        ? snapshot.pagination
        : capSnapshotPagination(snapshot.pagination, snapshot.messages, start);
    if (!pagination) {
      return null;
    }
    const weight = measuredSnapshotWeight(
      pagination,
      snapshot.sessionId,
      snapshot.displayedLeafEntryId,
      retainedMessageWeight,
      messageWeights.length - start,
    );
    if (weight !== null && weight <= MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
      const messages = start === 0 ? snapshot.messages : snapshot.messages.slice(start);
      return {
        snapshot: {
          ...(Object.hasOwn(snapshot, "displayedLeafEntryId")
            ? { displayedLeafEntryId: snapshot.displayedLeafEntryId }
            : {}),
          messages,
          pagination: start === 0 ? pagination : { ...pagination },
          sessionId: snapshot.sessionId,
        },
        weight,
      };
    }
    if (start >= snapshot.messages.length) {
      return null;
    }
    const boundarySeq = readSessionMessageSequence(snapshot.messages[start]);
    retainedMessageWeight -= messageWeights[start] ?? 0;
    start += 1;
    if (boundarySeq === null) {
      continue;
    }
    while (start < snapshot.messages.length) {
      if (readSessionMessageSequence(snapshot.messages[start]) !== boundarySeq) {
        break;
      }
      retainedMessageWeight -= messageWeights[start] ?? 0;
      start += 1;
    }
  }
}

function measureMessageWeights(messages: unknown[]): number[] | null {
  const weights: number[] = [];
  for (const message of messages) {
    const weight = serializedArrayItemWeight(message);
    if (weight === null) {
      return null;
    }
    weights.push(weight);
  }
  return weights;
}

function measuredSnapshotWeight(
  pagination: ChatHistoryPagination,
  sessionId: string | null,
  displayedLeafEntryId: string | null | undefined,
  messageWeight: number,
  messageCount: number,
): number | null {
  const envelopeWeight = serializedWeight({
    ...(displayedLeafEntryId !== undefined ? { displayedLeafEntryId } : {}),
    messages: [],
    pagination,
    sessionId,
  });
  return envelopeWeight === null
    ? null
    : envelopeWeight + messageWeight + Math.max(0, messageCount - 1);
}

function serializedArrayItemWeight(value: unknown): number | null {
  if (value && typeof value === "object") {
    const cached = cachedMessageWeights.get(value);
    if (cached !== undefined) {
      return cached;
    }
  }
  try {
    const serialized = JSON.stringify([value]);
    const weight = serialized ? Math.max(0, serialized.length - 2) : 0;
    if (value && typeof value === "object") {
      cachedMessageWeights.set(value, weight);
    }
    return weight;
  } catch {
    return null;
  }
}

function capSnapshotPagination(
  pagination: ChatHistoryPagination,
  messages: unknown[],
  start = 0,
): ChatHistoryPagination | null {
  const totalMessages = pagination.totalMessages;
  let oldestSeq: number | null = null;
  for (let index = start; index < messages.length; index += 1) {
    oldestSeq = readSessionMessageSequence(messages[index]);
    if (oldestSeq !== null) {
      break;
    }
  }
  if (typeof totalMessages !== "number" || oldestSeq === null) {
    return null;
  }
  const retainedDepth = totalMessages - oldestSeq + 1;
  if (retainedDepth <= 0) {
    return null;
  }
  return oldestSeq > 1
    ? { hasMore: true, nextOffset: retainedDepth, totalMessages }
    : { hasMore: false, totalMessages };
}

function serializedWeight(value: unknown): number | null {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return null;
  }
}

function samePagination(left: ChatHistoryPagination, right: ChatHistoryPagination): boolean {
  if (left.hasMore !== right.hasMore || left.totalMessages !== right.totalMessages) {
    return false;
  }
  if (left.hasMore && right.hasMore) {
    return left.nextOffset === right.nextOffset;
  }
  return !left.hasMore && !right.hasMore && left.completeSnapshot === right.completeSnapshot;
}

function trimChatSessionSnapshotCache(cache: ChatMessageCache): void {
  let weight = 0;
  for (const cached of cache.values()) {
    weight += cached.weight;
  }
  while (weight > MAX_CACHED_CHAT_WEIGHT) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    weight -= cache.get(oldestKey)?.weight ?? 0;
    cache.delete(oldestKey);
  }
}
