import { createHash } from "node:crypto";
import { formatIMessageChatTarget } from "../targets.js";

type SelfChatCacheKeyParts = {
  accountId: string;
  sender: string;
  isGroup: boolean;
  chatId?: number;
};

export type SelfChatLookup = SelfChatCacheKeyParts & {
  text?: string;
  createdAt?: number;
};

export type SelfChatCache = {
  remember: (lookup: SelfChatLookup) => void;
  has: (lookup: SelfChatLookup) => boolean;
};

const SELF_CHAT_TTL_MS = 10_000;
const MAX_SELF_CHAT_CACHE_ENTRIES = 512;
const CLEANUP_MIN_INTERVAL_MS = 1_000;

function normalizeText(text: string | undefined): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

function isUsableTimestamp(createdAt: number | undefined): createdAt is number {
  return typeof createdAt === "number" && Number.isFinite(createdAt);
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function buildScope(parts: SelfChatCacheKeyParts): string {
  if (!parts.isGroup) {
    return `${parts.accountId}:imessage:${parts.sender}`;
  }
  const chatTarget = formatIMessageChatTarget(parts.chatId) || "chat_id:unknown";
  return `${parts.accountId}:${chatTarget}:imessage:${parts.sender}`;
}

class DefaultSelfChatCache implements SelfChatCache {
  private cache = new Map<string, number>();
  private lastCleanupAt = 0;

  private buildKey(lookup: SelfChatLookup): string | null {
    const text = normalizeText(lookup.text);
    if (!text || !isUsableTimestamp(lookup.createdAt)) {
      return null;
    }
    return `${buildScope(lookup)}:${lookup.createdAt}:${digestText(text)}`;
  }

  remember(lookup: SelfChatLookup): void {
    const key = this.buildKey(lookup);
    if (!key) {
      return;
    }
    this.cache.set(key, Date.now());
    this.maybeCleanup();
  }

  has(lookup: SelfChatLookup): boolean {
    this.maybeCleanup();
    const key = this.buildKey(lookup);
    if (!key) {
      return false;
    }
    const timestamp = this.cache.get(key);
    return typeof timestamp === "number" && Date.now() - timestamp <= SELF_CHAT_TTL_MS;
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > SELF_CHAT_TTL_MS) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > MAX_SELF_CHAT_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }
}

export function createSelfChatCache(): SelfChatCache {
  return new DefaultSelfChatCache();
}
