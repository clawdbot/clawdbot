// Imessage plugin module implements monitor reply cache behavior.
import { createHash } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isPositiveIMessageChatMatch,
  resolveIMessageChatMatch,
  type IMessageChatContext,
} from "./chat-context.js";
import { getIMessageRuntime } from "./runtime.js";

export type { IMessageChatContext } from "./chat-context.js";

export const IMESSAGE_REPLY_CACHE_NAMESPACE = "imessage.reply-cache";
export const IMESSAGE_REPLY_CACHE_MAX_ENTRIES = 2000;
export const IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE = "imessage.reply-cache-counter";
export const IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES = 1;
export const IMESSAGE_REPLY_CACHE_COUNTER_KEY = "short-id-counter";
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Recency window for the "react to the latest message" fallback. */
const LATEST_FALLBACK_MS = 10 * 60 * 1000;
let persistenceFailureLogged = false;
function reportPersistenceFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) {
    return;
  }
  persistenceFailureLogged = true;
  logVerbose(`imessage reply-cache: ${scope} disabled after first failure: ${String(err)}`);
}

type IMessageReplyCacheEntry = IMessageChatContext & {
  accountId: string;
  messageId: string;
  shortId: string;
  timestamp: number;
  /**
   * True when the gateway sent this message itself (recorded from the
   * outbound path in send.ts after a successful imsg send), false when the
   * cache entry came from inbound watch (most common path).
   *
   * Edit / unsend actions require this to be true: Messages.app only lets
   * the original sender edit or retract a message, and even if the bridge
   * accepted a non-sender attempt, letting an agent unsend a human user's
   * message in a group chat would be a permission boundary violation.
   *
   * Optional for backwards compatibility with persisted entries from older
   * gateway versions that did not record this field; missing values are
   * treated as `false` (the safe default — pre-existing entries on disk
   * came from the inbound-only writer that existed before this change).
   */
  isFromMe?: boolean;
};

type IMessageReplyCacheStore = PluginStateSyncKeyedStore<IMessageReplyCacheEntry>;
type IMessageReplyCacheCounter = { counter: number };

const imessageReplyCacheByMessageId = new Map<string, IMessageReplyCacheEntry>();
const imessageShortIdToUuid = new Map<string, string>();
const imessageUuidToShortId = new Map<string, string>();
let imessageShortIdCounter = 0;

export function resolveIMessageReplyCacheEntryKey(messageId: string): string {
  return createHash("sha256").update(messageId, "utf8").digest("hex").slice(0, 32);
}

function openReplyCacheStore(): IMessageReplyCacheStore {
  return getIMessageRuntime().state.openSyncKeyedStore<IMessageReplyCacheEntry>({
    namespace: IMESSAGE_REPLY_CACHE_NAMESPACE,
    maxEntries: IMESSAGE_REPLY_CACHE_MAX_ENTRIES,
  });
}

function openReplyCacheCounterStore(): PluginStateSyncKeyedStore<IMessageReplyCacheCounter> {
  return getIMessageRuntime().state.openSyncKeyedStore<IMessageReplyCacheCounter>({
    namespace: IMESSAGE_REPLY_CACHE_COUNTER_NAMESPACE,
    maxEntries: IMESSAGE_REPLY_CACHE_COUNTER_MAX_ENTRIES,
  });
}

function remainingTtlMs(timestamp: number): number | undefined {
  const remaining = REPLY_CACHE_TTL_MS - Math.max(0, Date.now() - timestamp);
  return remaining > 0 ? remaining : undefined;
}

let hydrated = false;
function hydrateFromStoreOnce(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  let entries: IMessageReplyCacheEntry[];
  try {
    const counter = openReplyCacheCounterStore().lookup(IMESSAGE_REPLY_CACHE_COUNTER_KEY);
    if (counter && Number.isSafeInteger(counter.counter) && counter.counter > 0) {
      imessageShortIdCounter = Math.max(imessageShortIdCounter, counter.counter);
    }
    const store = openReplyCacheStore();
    entries = store
      .entries()
      .map(({ value }) => value)
      .filter((entry) => entry.timestamp >= cutoff)
      .toSorted((a, b) => a.timestamp - b.timestamp)
      .slice(-IMESSAGE_REPLY_CACHE_MAX_ENTRIES);
    for (const entry of entries) {
      const numeric = Number.parseInt(entry.shortId, 10);
      if (Number.isFinite(numeric) && numeric > imessageShortIdCounter) {
        imessageShortIdCounter = numeric;
      }
    }
  } catch (err) {
    reportPersistenceFailure("read", err);
    return;
  }
  if (entries.length === 0) {
    return;
  }
  for (const entry of entries) {
    imessageReplyCacheByMessageId.set(entry.messageId, entry);
    imessageShortIdToUuid.set(entry.shortId, entry.messageId);
    imessageUuidToShortId.set(entry.messageId, entry.shortId);
  }
}

function persistReplyCacheEntry(entry: IMessageReplyCacheEntry): void {
  const ttlMs = remainingTtlMs(entry.timestamp);
  if (!ttlMs) {
    return;
  }
  try {
    openReplyCacheStore().register(resolveIMessageReplyCacheEntryKey(entry.messageId), entry, {
      ttlMs,
    });
  } catch (err) {
    reportPersistenceFailure("write", err);
  }
}

function deleteReplyCacheEntry(messageId: string): void {
  try {
    openReplyCacheStore().delete(resolveIMessageReplyCacheEntryKey(messageId));
  } catch (err) {
    reportPersistenceFailure("delete", err);
  }
}

function persistReplyCacheCounter(): void {
  try {
    openReplyCacheCounterStore().register(IMESSAGE_REPLY_CACHE_COUNTER_KEY, {
      counter: imessageShortIdCounter,
    });
  } catch (err) {
    reportPersistenceFailure("counter", err);
  }
}

function buildReplyCacheEntry(
  entry: Omit<IMessageReplyCacheEntry, "shortId">,
  messageId: string,
  shortId: string,
): IMessageReplyCacheEntry {
  return {
    accountId: entry.accountId,
    messageId,
    shortId,
    timestamp: entry.timestamp,
    ...(typeof entry.chatGuid === "string" ? { chatGuid: entry.chatGuid } : {}),
    ...(typeof entry.chatIdentifier === "string" ? { chatIdentifier: entry.chatIdentifier } : {}),
    ...(typeof entry.chatId === "number" ? { chatId: entry.chatId } : {}),
    ...(typeof entry.isFromMe === "boolean" ? { isFromMe: entry.isFromMe } : {}),
  };
}

function generateShortId(): string {
  imessageShortIdCounter += 1;
  persistReplyCacheCounter();
  return String(imessageShortIdCounter);
}

export function rememberIMessageReplyCache(
  entry: Omit<IMessageReplyCacheEntry, "shortId">,
): IMessageReplyCacheEntry {
  hydrateFromStoreOnce();
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }

  let shortId = imessageUuidToShortId.get(messageId);
  if (!shortId) {
    shortId = generateShortId();
    imessageShortIdToUuid.set(shortId, messageId);
    imessageUuidToShortId.set(messageId, shortId);
  }

  const fullEntry = buildReplyCacheEntry(entry, messageId, shortId);
  imessageReplyCacheByMessageId.delete(messageId);
  imessageReplyCacheByMessageId.set(messageId, fullEntry);

  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  let evicted = false;
  const deletedMessageIds: string[] = [];
  for (const [key, value] of imessageReplyCacheByMessageId) {
    if (value.timestamp >= cutoff) {
      break;
    }
    imessageReplyCacheByMessageId.delete(key);
    deletedMessageIds.push(key);
    if (value.shortId) {
      imessageShortIdToUuid.delete(value.shortId);
      imessageUuidToShortId.delete(key);
    }
    evicted = true;
  }
  while (imessageReplyCacheByMessageId.size > IMESSAGE_REPLY_CACHE_MAX_ENTRIES) {
    const oldest = imessageReplyCacheByMessageId.keys().next().value;
    if (!oldest) {
      break;
    }
    const oldEntry = imessageReplyCacheByMessageId.get(oldest);
    imessageReplyCacheByMessageId.delete(oldest);
    deletedMessageIds.push(oldest);
    if (oldEntry?.shortId) {
      imessageShortIdToUuid.delete(oldEntry.shortId);
      imessageUuidToShortId.delete(oldest);
    }
    evicted = true;
  }

  if (evicted) {
    for (const messageIdToDelete of deletedMessageIds) {
      deleteReplyCacheEntry(messageIdToDelete);
    }
  }
  persistReplyCacheEntry(fullEntry);

  return fullEntry;
}

function hasChatScope(ctx?: IMessageChatContext): boolean {
  if (!ctx) {
    return false;
  }
  return Boolean(
    normalizeOptionalString(ctx.chatGuid) ||
    normalizeOptionalString(ctx.chatIdentifier) ||
    typeof ctx.chatId === "number",
  );
}

function isCrossChatMismatch(cached: IMessageReplyCacheEntry, ctx: IMessageChatContext): boolean {
  return resolveIMessageChatMatch(cached, ctx) === "mismatch";
}

function describeChatForError(values: IMessageChatContext): string {
  const parts: string[] = [];
  if (normalizeOptionalString(values.chatGuid)) {
    parts.push("chatGuid=<redacted>");
  }
  if (normalizeOptionalString(values.chatIdentifier)) {
    parts.push("chatIdentifier=<redacted>");
  }
  if (typeof values.chatId === "number") {
    parts.push("chatId=<redacted>");
  }
  return parts.length === 0 ? "<unknown chat>" : parts.join(", ");
}

function describeMessageIdForError(inputId: string, inputKind: "short" | "uuid"): string {
  if (inputKind === "short") {
    return `<short:${inputId.length}-digit>`;
  }
  return `<uuid:${inputId.slice(0, 8)}...>`;
}

function buildCrossChatError(
  inputId: string,
  inputKind: "short" | "uuid",
  cached: IMessageReplyCacheEntry,
  ctx: IMessageChatContext,
): Error {
  const remediation =
    inputKind === "short"
      ? "Use a message ID from the current chat target; MessageSidFull from another chat is rejected."
      : "Retry with the correct chat target.";
  return new Error(
    `iMessage message id ${describeMessageIdForError(inputId, inputKind)} belongs to a different chat ` +
      `(${describeChatForError(cached)}) than the current call target (${describeChatForError(ctx)}). ${remediation}`,
  );
}

export function resolveIMessageMessageId(
  shortOrUuid: string,
  opts?: {
    requireKnownShortId?: boolean;
    chatContext?: IMessageChatContext;
    /**
     * When true, only resolve message ids that the gateway recorded as sent
     * by itself (`isFromMe: true`). Used by `edit` / `unsend` so an agent
     * cannot retract or edit messages other participants sent — Messages.app
     * enforces this at the OS level too, but failing earlier in the plugin
     * gives a clean error and avoids dispatching a guaranteed-to-fail bridge
     * call.
     *
     * Cache entries with no `isFromMe` field (older persisted entries from
     * before this option existed, or any uncached UUID the agent passes
     * through) are treated as not-from-me and rejected.
     */
    requireFromMe?: boolean;
  },
): string {
  const trimmed = shortOrUuid.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Hydrate SQLite-backed mappings before reading them. Without this, the
  // first post-restart action with a short MessageSid would miss
  // `imessageShortIdToUuid` and fall through to "no longer available".
  // `rememberIMessageReplyCache` already hydrates on its own, so this only
  // matters for the resolve-first-after-restart sequence.
  hydrateFromStoreOnce();

  if (/^\d+$/.test(trimmed)) {
    // Cache hit: the cached entry carries the chat info this short id was
    // issued for, so we can resolve the UUID even without a caller-supplied
    // chat scope. Cross-chat detection still fires when the caller did
    // provide a scope and it disagrees with the cache.
    const uuid = imessageShortIdToUuid.get(trimmed);
    if (uuid) {
      const cached = imessageReplyCacheByMessageId.get(uuid);
      if (opts?.chatContext && hasChatScope(opts.chatContext)) {
        if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
          throw buildCrossChatError(trimmed, "short", cached, opts.chatContext);
        }
      }
      if (opts?.requireFromMe && cached?.isFromMe !== true) {
        throw buildFromMeError(trimmed, "short");
      }
      return uuid;
    }
    // Cache miss: now the chat-scope requirement matters — without scope
    // we have no way to verify the caller is reacting in the right chat,
    // and without a cached UUID the bridge cannot resolve the short id.
    if (opts?.requireKnownShortId && !hasChatScope(opts.chatContext)) {
      throw new Error(
        `iMessage short message id ${describeMessageIdForError(trimmed, "short")} requires a chat scope (chatGuid / chatIdentifier / chatId or a target).`,
      );
    }
    if (opts?.requireKnownShortId) {
      throw new Error(
        `iMessage short message id ${describeMessageIdForError(trimmed, "short")} is no longer available. Use MessageSidFull.`,
      );
    }
    return trimmed;
  }

  const cached = imessageReplyCacheByMessageId.get(trimmed);
  if (opts?.chatContext) {
    if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
      throw buildCrossChatError(trimmed, "uuid", cached, opts.chatContext);
    }
  }
  if (opts?.requireFromMe && cached?.isFromMe !== true) {
    throw buildFromMeError(trimmed, "uuid");
  }
  return trimmed;
}

export function isKnownFromMeIMessageMessageId(
  messageId: string | undefined,
  ctx: IMessageChatContext & { accountId?: string },
): boolean {
  const trimmed = normalizeOptionalString(messageId);
  if (!trimmed || !ctx.accountId || !hasChatScope(ctx)) {
    return false;
  }
  hydrateFromStoreOnce();
  const cached = imessageReplyCacheByMessageId.get(trimmed);
  if (!cached || cached.isFromMe !== true || cached.accountId !== ctx.accountId) {
    return false;
  }
  return isPositiveIMessageChatMatch(cached, ctx);
}

function buildFromMeError(inputId: string, inputKind: "short" | "uuid"): Error {
  return new Error(
    `iMessage message id ${describeMessageIdForError(inputId, inputKind)} is not one this agent sent. ` +
      `edit and unsend can only target messages the gateway delivered itself; ` +
      `messages received from other participants cannot be modified.`,
  );
}

/**
 * Return the most recent cached entry whose chat scope matches the supplied
 * context. Used as a fallback when an agent calls a per-message action (e.g.
 * `react`) without specifying a `messageId` — the natural intent is "react
 * to the message I just received in this chat."
 *
 * Strict semantics for safety:
 *  - Caller must supply a chat scope. We refuse to "guess" the active chat.
 *  - Cached entry must positively match on at least one identifier kind
 *    (chatGuid, chatIdentifier, chatId, or normalized direct-DM fingerprint).
 *    We do NOT fall through on "no overlapping identifier" — that's how a
 *    cached entry from a foreign chat could be returned when the caller's
 *    context didn't share any identifier kind with the cache.
 *  - Caller must supply an accountId; we never cross account boundaries.
 *  - We only consider entries newer than `LATEST_FALLBACK_MS`. The intent
 *    of "react to the latest" is "the message I just received," not
 *    "anything in this chat from any time."
 */
export function findLatestIMessageEntryForChat(
  ctx: IMessageChatContext & { accountId?: string },
): IMessageReplyCacheEntry | undefined {
  if (!hasChatScope(ctx)) {
    return undefined;
  }
  if (!ctx.accountId) {
    return undefined;
  }
  const cutoff = Date.now() - LATEST_FALLBACK_MS;
  let best: IMessageReplyCacheEntry | undefined;
  for (const entry of imessageReplyCacheByMessageId.values()) {
    if (entry.accountId !== ctx.accountId) {
      continue;
    }
    if (entry.timestamp < cutoff) {
      continue;
    }
    if (!isPositiveIMessageChatMatch(entry, ctx)) {
      continue;
    }
    if (!best || entry.timestamp > best.timestamp) {
      best = entry;
    }
  }
  return best;
}

export function resolveIMessageCachedResourceBinding(
  messageId: string,
  ctx: IMessageChatContext & { accountId: string },
): "match" | "mismatch" | "unknown" {
  hydrateFromStoreOnce();
  const entry = imessageReplyCacheByMessageId.get(messageId.trim());
  if (!entry) {
    return "unknown";
  }
  if (Date.now() - entry.timestamp > REPLY_CACHE_TTL_MS) {
    return "unknown";
  }
  if (entry.accountId !== ctx.accountId) {
    return "mismatch";
  }
  const chatMatch = resolveIMessageChatMatch(entry, ctx);
  if (chatMatch !== "match") {
    return chatMatch;
  }
  return "match";
}

export function isIMessageCurrentMessageInChat(params: {
  accountId: string;
  currentMessageId: string | number;
  chatContext: IMessageChatContext;
}): boolean {
  if (!params.accountId || !hasChatScope(params.chatContext)) {
    return false;
  }
  const currentMessageId = normalizeOptionalString(String(params.currentMessageId));
  if (!currentMessageId) {
    return false;
  }
  hydrateFromStoreOnce();
  const fullMessageId = /^\d+$/.test(currentMessageId)
    ? imessageShortIdToUuid.get(currentMessageId)
    : currentMessageId;
  if (!fullMessageId) {
    return false;
  }
  return (
    resolveIMessageCachedResourceBinding(fullMessageId, {
      ...params.chatContext,
      accountId: params.accountId,
    }) === "match"
  );
}
