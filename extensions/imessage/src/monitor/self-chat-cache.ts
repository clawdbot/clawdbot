// Imessage plugin module implements self chat cache behavior.
import { createHash } from "node:crypto";
import { formatIMessageChatTarget } from "../targets.js";

type SelfChatCacheKeyParts = {
  accountId: string;
  sender: string;
  isGroup: boolean;
  chatId?: number;
};

type SelfChatLookup = SelfChatCacheKeyParts & {
  text?: string;
  createdAt?: number;
  allowCreatedAtSkew?: boolean;
};

type SelfChatCacheEntry = {
  id: number;
  createdAt: number;
  createdAtSkewToleranceMs: number;
  rememberedAt: number;
};

export type SelfChatCache = {
  remember: (lookup: SelfChatLookup) => void;
  has: (lookup: SelfChatLookup) => boolean;
};

const SELF_CHAT_TTL_MS = 10_000;
const SELF_CHAT_CREATED_AT_TOLERANCE_MS = 1_000;
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
  private cache = new Map<string, Map<number, SelfChatCacheEntry>>();
  private insertionOrder: Array<{ key: string; id: number }> = [];
  private insertionOrderOffset = 0;
  private entryCount = 0;
  private lastCleanupAt = 0;
  private nextEntryId = 1;

  private buildBucketKey(lookup: SelfChatLookup): string | null {
    const text = normalizeText(lookup.text);
    if (!text) {
      return null;
    }
    return `${buildScope(lookup)}:${digestText(text)}`;
  }

  remember(lookup: SelfChatLookup): void {
    const key = this.buildBucketKey(lookup);
    if (!key || !isUsableTimestamp(lookup.createdAt)) {
      return;
    }
    const entries = this.cache.get(key) ?? new Map<number, SelfChatCacheEntry>();
    const entry = {
      id: this.nextEntryId,
      createdAt: lookup.createdAt,
      createdAtSkewToleranceMs: lookup.allowCreatedAtSkew ? SELF_CHAT_CREATED_AT_TOLERANCE_MS : 0,
      rememberedAt: Date.now(),
    };
    this.nextEntryId += 1;
    entries.set(entry.id, entry);
    this.cache.set(key, entries);
    this.insertionOrder.push({ key, id: entry.id });
    this.entryCount += 1;
    this.maybeCleanup();
  }

  has(lookup: SelfChatLookup): boolean {
    this.maybeCleanup();
    const key = this.buildBucketKey(lookup);
    if (!key || !isUsableTimestamp(lookup.createdAt)) {
      return false;
    }
    const entries = this.cache.get(key);
    if (!entries) {
      return false;
    }
    const now = Date.now();
    const createdAt = lookup.createdAt;
    return [...entries.values()].some((entry) => {
      const createdAtDelta = Math.abs(entry.createdAt - createdAt);
      return (
        now - entry.rememberedAt <= SELF_CHAT_TTL_MS &&
        (createdAtDelta === 0 || createdAtDelta < entry.createdAtSkewToleranceMs)
      );
    });
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;
    for (const [key, entries] of this.cache.entries()) {
      for (const [id, entry] of entries.entries()) {
        if (now - entry.rememberedAt > SELF_CHAT_TTL_MS) {
          entries.delete(id);
          this.entryCount -= 1;
        }
      }
      if (entries.size === 0) {
        this.cache.delete(key);
      }
    }
    while (
      this.entryCount > MAX_SELF_CHAT_CACHE_ENTRIES &&
      this.insertionOrderOffset < this.insertionOrder.length
    ) {
      const oldest = this.insertionOrder[this.insertionOrderOffset];
      this.insertionOrderOffset += 1;
      const entries = this.cache.get(oldest.key);
      if (!entries) {
        continue;
      }
      if (!entries.delete(oldest.id)) {
        continue;
      }
      this.entryCount -= 1;
      if (entries.size === 0) {
        this.cache.delete(oldest.key);
      }
    }
    this.compactInsertionOrder();
  }

  private compactInsertionOrder(): void {
    if (
      this.insertionOrderOffset <= 1_024 &&
      this.insertionOrder.length <= this.entryCount + 1_024
    ) {
      return;
    }
    this.insertionOrder = this.insertionOrder
      .slice(this.insertionOrderOffset)
      .filter((entry) => this.cache.get(entry.key)?.has(entry.id));
    this.insertionOrderOffset = 0;
  }
}

export function createSelfChatCache(): SelfChatCache {
  return new DefaultSelfChatCache();
}
