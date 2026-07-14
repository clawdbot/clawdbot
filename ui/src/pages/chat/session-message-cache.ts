// Control UI chat module implements bounded visible-message caching.
import {
  DEFAULT_MAIN_KEY,
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import { getSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

const MAX_CACHED_CHAT_MESSAGES = 100;

export type ChatMessageCache = Map<string, unknown[]>;

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
  const parsed = parseAgentSessionKey(sessionKey);
  const normalized = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
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

export function cacheChatMessages(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  messages: unknown[],
): void {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  if (messages.length === 0) {
    cache.delete(cacheKey);
    return;
  }
  setSessionCacheValue(cache, cacheKey, messages.slice(-MAX_CACHED_CHAT_MESSAGES));
}

export function appendChatMessageToCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
  message: unknown,
): void {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  const messages = getSessionCacheValue(cache, cacheKey) ?? [];
  cacheChatMessages(cache, host, target, [...messages, message]);
}

export function readChatMessagesFromCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): unknown[] {
  const cacheKey = resolveChatMessageCacheKey(host, target);
  return [...(getSessionCacheValue(cache, cacheKey) ?? [])];
}

export function clearChatMessagesFromCache(
  cache: ChatMessageCache,
  host: ChatMessageCacheHost,
  target: ChatMessageCacheTarget,
): void {
  cache.delete(resolveChatMessageCacheKey(host, target));
}
