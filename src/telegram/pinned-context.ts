import type { Bot } from "grammy";
import { logVerbose } from "../globals.js";

type PinnedMessageCache = {
  text: string;
  from?: string;
  date?: number;
  fetchedAt: number;
};

// Cache pinned messages per chat/topic
// Key format: "chatId" or "chatId:topicId"
const pinnedCache = new Map<string, PinnedMessageCache | null>();

// Cache TTL: 5 minutes
const CACHE_TTL_MS = 5 * 60 * 1000;

function buildCacheKey(chatId: string | number, topicId?: number): string {
  const base = String(chatId);
  return topicId != null && topicId !== 1 ? `${base}:${topicId}` : base;
}

export function invalidatePinnedCache(chatId: string | number, topicId?: number): void {
  const key = buildCacheKey(chatId, topicId);
  pinnedCache.delete(key);
  logVerbose(`[pinned-context] Invalidated cache for ${key}`);
}

export async function fetchPinnedMessage(
  bot: Bot,
  chatId: string | number,
  topicId?: number,
): Promise<PinnedMessageCache | null> {
  const key = buildCacheKey(chatId, topicId);

  // Check cache
  const cached = pinnedCache.get(key);
  if (cached !== undefined) {
    const age = Date.now() - (cached?.fetchedAt ?? 0);
    if (age < CACHE_TTL_MS) {
      logVerbose(`[pinned-context] Cache hit for ${key}`);
      return cached;
    }
  }

  try {
    const chat = await bot.api.getChat(chatId);
    const pinned = chat.pinned_message;

    if (!pinned) {
      pinnedCache.set(key, null);
      logVerbose(`[pinned-context] No pinned message for ${key}`);
      return null;
    }

    // Extract text content
    const text = pinned.text ?? pinned.caption ?? "";
    if (!text.trim()) {
      pinnedCache.set(key, null);
      return null;
    }

    const entry: PinnedMessageCache = {
      text: text.trim(),
      from: pinned.from?.first_name ?? pinned.from?.username,
      date: pinned.date,
      fetchedAt: Date.now(),
    };

    pinnedCache.set(key, entry);
    logVerbose(`[pinned-context] Fetched pinned message for ${key}: "${text.slice(0, 50)}..."`);
    return entry;
  } catch (err) {
    logVerbose(`[pinned-context] Failed to fetch pinned for ${key}: ${String(err)}`);
    // Cache the failure briefly to avoid hammering the API
    pinnedCache.set(key, null);
    return null;
  }
}

export function formatPinnedContext(pinned: PinnedMessageCache): string {
  const datePart = pinned.date
    ? ` (pinned ${new Date(pinned.date * 1000).toLocaleDateString()})`
    : "";
  const fromPart = pinned.from ? ` by ${pinned.from}` : "";
  return `[📌 Pinned${fromPart}${datePart}]\n${pinned.text}\n[/Pinned]`;
}

/**
 * Get formatted pinned message context for injection.
 * Returns empty string if no pinned message.
 */
export async function getPinnedContextString(
  bot: Bot,
  chatId: string | number,
  topicId?: number,
): Promise<string> {
  const pinned = await fetchPinnedMessage(bot, chatId, topicId);
  if (!pinned) return "";
  return formatPinnedContext(pinned);
}
