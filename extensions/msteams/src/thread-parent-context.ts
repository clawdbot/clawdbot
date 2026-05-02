// Parent-message context injection for Teams channel thread replies.
//
// When an inbound message arrives as a reply inside a Teams channel thread,
// the triggering message often makes no sense on its own (for example, a
// one-word "yes" or "go ahead"). Per-thread session isolation (PR #62713)
// gives each thread its own session, but the first message in a brand-new
// thread session still has no parent context.
//
// This module fetches the parent message via Graph and prepends a compact
// `Replying to @sender: …` system event to the next agent turn so the agent
// knows what is being responded to. Fetches are cached to avoid repeated
// Graph calls within the same active thread, and per-session dedupe ensures
// the same parent is not re-injected on every subsequent reply in the
// thread.

import { fetchChannelMessage, stripHtmlFromTeamsMessage } from "./graph-thread.js";
import type { GraphThreadMessage } from "./graph-thread.js";

// LRU cache for parent message fetches. Keyed by `teamId:channelId:parentId`.
// 5-minute TTL and 100-entry cap keep active-thread chatter fast without
// holding stale data when a thread goes quiet. Eviction uses Map insertion
// order for LRU semantics (get() re-inserts on hit).
const PARENT_CACHE_TTL_MS = 5 * 60 * 1000;
const PARENT_CACHE_MAX = 100;

type ParentCacheEntry = {
  message: GraphThreadMessage | undefined;
  expiresAt: number;
};

const parentCache = new Map<string, ParentCacheEntry>();

// Per-session dedupe: remembers the most recent parent id we injected for a
// given session key. When the same thread session sees another reply against
// the same parent, we skip re-enqueueing the identical system event. We keep
// a small LRU so idle sessions eventually drop out.
const INJECTED_MAX = 200;
const injectedParents = new Map<string, string>();

type ThreadParentContextFetcher = (
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
) => Promise<GraphThreadMessage | undefined>;

function touchLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= max) {
    // Drop the oldest (first-inserted) entry.
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) {
      map.delete(firstKey);
    }
  }
  map.set(key, value);
}

function buildParentCacheKey(groupId: string, channelId: string, parentId: string): string {
  return `${groupId}\u0000${channelId}\u0000${parentId}`;
}

/**
 * Fetch a channel parent message with an LRU+TTL cache.
 *
 * Uses the injected `fetchParent` (defaults to `fetchChannelMessage`) so
 * tests can swap in a stub without mocking the Graph transport.
 */
export async function fetchParentMessageCached(
  token: string,
  groupId: string,
  channelId: string,
  parentId: string,
  fetchParent: ThreadParentContextFetcher = fetchChannelMessage,
): Promise<GraphThreadMessage | undefined> {
  const key = buildParentCacheKey(groupId, channelId, parentId);
  const now = Date.now();
  const cached = parentCache.get(key);
  if (cached && cached.expiresAt > now) {
    // Refresh LRU ordering on hit.
    parentCache.delete(key);
    parentCache.set(key, cached);
    return cached.message;
  }
  const message = await fetchParent(token, groupId, channelId, parentId);
  touchLru(parentCache, key, { message, expiresAt: now + PARENT_CACHE_TTL_MS }, PARENT_CACHE_MAX);
  return message;
}

type ParentContextSummary = {
  /** Display name of the parent message author, or "unknown". */
  sender: string;
  /** Stripped, single-line parent body text (or empty if unresolved). */
  text: string;
};

const PARENT_TEXT_MAX_CHARS = 400;

/**
 * Extract a compact summary (sender + plain-text body) from a Graph parent
 * message. Returns undefined when the parent cannot be summarized (missing
 * or blank body).
 */
export function summarizeParentMessage(
  message: GraphThreadMessage | undefined,
): ParentContextSummary | undefined {
  if (!message) {
    return undefined;
  }
  const sender =
    message.from?.user?.displayName ?? message.from?.application?.displayName ?? "unknown";
  const contentType = message.body?.contentType ?? "text";
  const raw = message.body?.content ?? "";
  const text =
    contentType === "html" ? stripHtmlFromTeamsMessage(raw) : raw.replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }
  return {
    sender,
    text:
      text.length > PARENT_TEXT_MAX_CHARS ? `${text.slice(0, PARENT_TEXT_MAX_CHARS - 1)}…` : text,
  };
}

/**
 * Build the single-line `Replying to @sender: body` system event text.
 * Callers should pass this text to `enqueueSystemEvent` together with a
 * stable contextKey derived from the parent id.
 */
export function formatParentContextEvent(summary: ParentContextSummary): string {
  return `Replying to @${summary.sender}: ${summary.text}`;
}

/**
 * Decide whether a parent context event should be enqueued for the current
 * session. Returns `false` when we already injected the same parent for this
 * session recently (prevents re-prepending identical context on every reply
 * in the thread).
 */
export function shouldInjectParentContext(sessionKey: string, parentId: string): boolean {
  const key = sessionKey;
  return injectedParents.get(key) !== parentId;
}

/**
 * Record that `parentId` was just injected for `sessionKey` so subsequent
 * replies with the same parent can short-circuit via `shouldInjectParentContext`.
 */
export function markParentContextInjected(sessionKey: string, parentId: string): void {
  touchLru(injectedParents, sessionKey, parentId, INJECTED_MAX);
}

// Exported for test isolation.
export function _resetThreadParentContextCachesForTest(): void {
  parentCache.clear();
  injectedParents.clear();
}
