import { createHash } from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";

type SelfChatCacheKeyParts = {
  accountId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  senderId: string;
};

type SelfChatLookup = SelfChatCacheKeyParts & {
  body?: string;
  timestamp?: number;
};

const SELF_CHAT_TTL_MS = 10_000;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1_000;
const MAX_SELF_CHAT_BODY_CHARS = 32_768;
const cache = new Map<string, number>();
let lastCleanupAt = 0;

function normalizeBody(body: string | undefined): string | null {
  if (!body) {
    return null;
  }
  const bounded =
    body.length > MAX_SELF_CHAT_BODY_CHARS ? body.slice(0, MAX_SELF_CHAT_BODY_CHARS) : body;
  const normalized = bounded.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function isUsableTimestamp(timestamp: number | undefined): timestamp is number {
  return typeof timestamp === "number" && Number.isFinite(timestamp);
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

function resolveCanonicalChatTarget(parts: SelfChatCacheKeyParts): string | null {
  const handleFromGuid = parts.chatGuid ? extractHandleFromChatGuid(parts.chatGuid) : null;
  if (handleFromGuid) {
    return handleFromGuid;
  }

  const normalizedIdentifier = normalizeBlueBubblesHandle(parts.chatIdentifier ?? "");
  if (normalizedIdentifier) {
    return normalizedIdentifier;
  }

  return (
    normalizeOptionalString(parts.chatGuid) ??
    normalizeOptionalString(parts.chatIdentifier) ??
    (typeof parts.chatId === "number" ? String(parts.chatId) : null)
  );
}

function buildScope(parts: SelfChatCacheKeyParts): string {
  const target = resolveCanonicalChatTarget(parts) ?? parts.senderId;
  return `${parts.accountId}:${target}`;
}

function cleanupExpired(now = Date.now()): void {
  if (
    lastCleanupAt !== 0 &&
    now >= lastCleanupAt &&
    now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS
  ) {
    return;
  }
  lastCleanupAt = now;
  for (const [key, seenAt] of cache.entries()) {
    if (now - seenAt > SELF_CHAT_TTL_MS) {
      cache.delete(key);
    }
  }
}

function enforceSizeCap(): void {
  while (cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

function buildKey(lookup: SelfChatLookup): string | null {
  const body = normalizeBody(lookup.body);
  if (!body || !isUsableTimestamp(lookup.timestamp)) {
    return null;
  }
  return `${buildScope(lookup)}:${lookup.timestamp}:${digestText(body)}`;
}

export function rememberBlueBubblesSelfChatCopy(lookup: SelfChatLookup): void {
  cleanupExpired();
  const key = buildKey(lookup);
  if (!key) {
    return;
  }
  cache.set(key, Date.now());
  enforceSizeCap();
}

export function hasBlueBubblesSelfChatCopy(lookup: SelfChatLookup): boolean {
  cleanupExpired();
  const key = buildKey(lookup);
  if (!key) {
    return false;
  }
  const seenAt = cache.get(key);
  return typeof seenAt === "number" && Date.now() - seenAt <= SELF_CHAT_TTL_MS;
}

export function resetBlueBubblesSelfChatCache(): void {
  cache.clear();
  lastCleanupAt = 0;
}
