// Control UI chat module implements bounded visible-message caching.
import {
  createSessionProjection,
  readSessionMessageSequence,
  reduceSessionProjection,
} from "@openclaw/gateway-client/browser";
import type { UiSessionDefaultsHost } from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";
import { resolveChatSnapshotKey } from "./session-snapshot-invalidation.ts";

export { resolveChatSnapshotKey } from "./session-snapshot-invalidation.ts";

// JSON code-unit weight bounds retained payloads without allocating another
// UTF-8 buffer on the route-switch path.
const MAX_CACHED_CHAT_SNAPSHOT_WEIGHT = 12 * 1024 * 1024;
export const MAX_CACHED_CHAT_WEIGHT = 24 * 1024 * 1024;
// History reconciliation replaces changed messages and retains unchanged
// objects, so serialization weight can follow the same immutable identity.
const cachedMessageWeights = new WeakMap<object, number>();
const appendedEventClaims = new WeakMap<ChatMessageCache, WeakSet<object>>();

export type ChatSessionSnapshot = {
  deltaCursor?: string;
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

export type ChatCacheObserver = {
  delete: (sessionKey: string) => void | Promise<void>;
  write: (sessionKey: string, snapshot: ChatSessionSnapshot) => void;
};

const chatCacheObservers = new WeakMap<ChatMessageCache, ChatCacheObserver>();

type ChatMessageCacheTarget = {
  sessionKey: string;
  agentId?: string | null;
};

type ChatMessageCacheHost = Pick<
  UiSessionDefaultsHost,
  "assistantAgentId" | "agentsList" | "hello"
>;

export function observeChatCache(cache: ChatMessageCache, observer: ChatCacheObserver): void {
  chatCacheObservers.set(cache, observer);
}

function deleteChatSnapshot(cache: ChatMessageCache, cacheKey: string): void {
  cache.delete(cacheKey);
  void chatCacheObservers.get(cache)?.delete(cacheKey);
}

export function applyChatCacheSnapshot(
  state: {
    chatDisplayedLeafEntryId?: string | null;
    chatHistoryPagination: ChatHistoryPagination;
    chatMessages: unknown[];
    currentSessionId?: string | null;
  },
  snapshot: ChatSessionSnapshot,
): void {
  state.chatMessages = snapshot.messages;
  state.chatHistoryPagination = snapshot.pagination;
  state.currentSessionId = snapshot.sessionId;
  state.chatDisplayedLeafEntryId = snapshot.displayedLeafEntryId;
}

function publishChatSnapshot(
  cache: ChatMessageCache,
  cacheKey: string,
  snapshot: ChatSessionSnapshot,
): void {
  chatCacheObservers.get(cache)?.write(cacheKey, snapshot);
}

export function appendChatMessageToCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  message: unknown,
  eventClaim?: object,
): void {
  const cacheKey = resolveChatSnapshotKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (!existing) {
    return;
  }
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
  const messageWeight = serializedArrayItemWeight(message);
  if (messageWeight === null) {
    deleteChatSnapshot(cache, cacheKey);
    return;
  }
  const messages = eventClaim
    ? reduceSessionProjection(createSessionProjection({}, existing.snapshot.messages), {
        type: "messagePersisted",
        message,
        envelope: eventClaim,
      }).messages.slice()
    : [...existing.snapshot.messages, message];
  const snapshot = {
    ...(existing.snapshot.deltaCursor !== undefined
      ? { deltaCursor: existing.snapshot.deltaCursor }
      : {}),
    ...(Object.hasOwn(existing.snapshot, "displayedLeafEntryId")
      ? { displayedLeafEntryId: existing.snapshot.displayedLeafEntryId }
      : {}),
    messages,
    pagination: existing.snapshot.pagination,
    sessionId: existing.snapshot.sessionId,
  };
  if (eventClaim) {
    cacheChatSessionSnapshot(cache, host, target, snapshot);
    return;
  }
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
  publishChatSnapshot(cache, cacheKey, snapshot);
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
  deleteChatSnapshot(cache, resolveChatSnapshotKey(host, target));
}

export function cacheChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  snapshot: ChatSessionSnapshot,
): void {
  const cacheKey = resolveChatSnapshotKey(host, target);
  const existing = getSessionCacheValue(cache, cacheKey);
  if (
    existing?.snapshot.messages === snapshot.messages &&
    existing.snapshot.deltaCursor === snapshot.deltaCursor &&
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
    deleteChatSnapshot(cache, cacheKey);
    return;
  }
  const bounded = boundChatSessionSnapshot(snapshot);
  if (!bounded) {
    deleteChatSnapshot(cache, cacheKey);
    return;
  }
  setSessionCacheValue(cache, cacheKey, bounded);
  trimChatSessionSnapshotCache(cache);
  publishChatSnapshot(cache, cacheKey, bounded.snapshot);
}

export function readChatSessionSnapshot(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): ChatSessionSnapshot | null {
  return getSessionCacheValue(cache, resolveChatSnapshotKey(host, target))?.snapshot ?? null;
}

export function measureChatSnapshotWeight(snapshot: ChatSessionSnapshot): number | null {
  const messageWeights = measureMessageWeights(snapshot.messages);
  if (!messageWeights) {
    return null;
  }
  return measuredSnapshotWeight(
    snapshot.deltaCursor,
    snapshot.pagination,
    snapshot.sessionId,
    snapshot.displayedLeafEntryId,
    messageWeights.reduce((sum, weight) => sum + weight, 0),
    messageWeights.length,
  );
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
      snapshot.deltaCursor,
      pagination,
      snapshot.sessionId,
      snapshot.displayedLeafEntryId,
      retainedMessageWeight,
      messageWeights.length - start,
    );
    if (weight !== null && weight <= MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
      if (start === 0) {
        return { snapshot, weight };
      }
      return {
        snapshot: {
          ...(snapshot.deltaCursor !== undefined ? { deltaCursor: snapshot.deltaCursor } : {}),
          ...(Object.hasOwn(snapshot, "displayedLeafEntryId")
            ? { displayedLeafEntryId: snapshot.displayedLeafEntryId }
            : {}),
          messages: snapshot.messages.slice(start),
          pagination: { ...pagination },
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
  deltaCursor: string | undefined,
  pagination: ChatHistoryPagination,
  sessionId: string | null,
  displayedLeafEntryId: string | null | undefined,
  messageWeight: number,
  messageCount: number,
): number | null {
  const envelopeWeight = serializedWeight({
    ...(deltaCursor !== undefined ? { deltaCursor } : {}),
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
