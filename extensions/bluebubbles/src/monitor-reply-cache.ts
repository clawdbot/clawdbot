import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const REPLY_CACHE_MAX = 2000;
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type BlueBubblesReplyCacheEntry = {
  accountId: string;
  messageId: string;
  shortId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  senderLabel?: string;
  body?: string;
  timestamp: number;
};

// Best-effort cache for resolving reply context when BlueBubbles webhooks omit sender/body.
const blueBubblesReplyCacheByMessageId = new Map<string, BlueBubblesReplyCacheEntry>();

// Bidirectional maps for short ID ↔ message GUID resolution (token savings optimization)
const blueBubblesShortIdToUuid = new Map<string, string>();
const blueBubblesUuidToShortId = new Map<string, string>();
let blueBubblesShortIdCounter = 0;

function generateShortId(): string {
  blueBubblesShortIdCounter += 1;
  return String(blueBubblesShortIdCounter);
}

export function rememberBlueBubblesReplyCache(
  entry: Omit<BlueBubblesReplyCacheEntry, "shortId">,
): BlueBubblesReplyCacheEntry {
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }

  // Check if we already have a short ID for this GUID
  let shortId = blueBubblesUuidToShortId.get(messageId);
  if (!shortId) {
    shortId = generateShortId();
    blueBubblesShortIdToUuid.set(shortId, messageId);
    blueBubblesUuidToShortId.set(messageId, shortId);
  }

  const fullEntry: BlueBubblesReplyCacheEntry = { ...entry, messageId, shortId };

  // Refresh insertion order.
  blueBubblesReplyCacheByMessageId.delete(messageId);
  blueBubblesReplyCacheByMessageId.set(messageId, fullEntry);

  // Opportunistic prune.
  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  for (const [key, value] of blueBubblesReplyCacheByMessageId) {
    if (value.timestamp < cutoff) {
      blueBubblesReplyCacheByMessageId.delete(key);
      // Clean up short ID mappings for expired entries
      if (value.shortId) {
        blueBubblesShortIdToUuid.delete(value.shortId);
        blueBubblesUuidToShortId.delete(key);
      }
      continue;
    }
    break;
  }
  while (blueBubblesReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
    const oldest = blueBubblesReplyCacheByMessageId.keys().next().value;
    if (!oldest) {
      break;
    }
    const oldEntry = blueBubblesReplyCacheByMessageId.get(oldest);
    blueBubblesReplyCacheByMessageId.delete(oldest);
    // Clean up short ID mappings for evicted entries
    if (oldEntry?.shortId) {
      blueBubblesShortIdToUuid.delete(oldEntry.shortId);
      blueBubblesUuidToShortId.delete(oldest);
    }
  }

  return fullEntry;
}

export type BlueBubblesChatContext = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
};

/**
 * Cross-chat guard: compare a cached entry's chat fields with a caller-provided
 * context. Returns true when the two clearly reference different chats.
 *
 * Comparison rules mirror resolveReplyContextFromCache so outbound short-ID
 * resolution and inbound reply-context lookup agree on scope:
 *
 *   - If both sides carry a chatGuid and they differ, that is the strongest
 *     signal of a cross-chat reuse.
 *   - Otherwise, if the caller has no chatGuid but both sides carry a
 *     chatIdentifier and they differ, that is also a mismatch. This covers
 *     handle-only callers (tapback into a DM where the caller only resolved
 *     a handle) against cached entries that still carry chatGuid from the
 *     inbound webhook.
 *   - Otherwise, if the caller has neither chatGuid nor chatIdentifier but
 *     both sides carry a chatId and they differ, that is also a mismatch.
 *
 * Absent identifiers on either side are treated as "no information" rather
 * than a mismatch, so ambiguous calls fall through as-is.
 */
function isCrossChatMismatch(
  cached: BlueBubblesReplyCacheEntry,
  ctx: BlueBubblesChatContext,
): boolean {
  // Compare each identifier independently based on availability on both sides.
  // Earlier versions gated chatIdentifier/chatId comparisons on `!ctxChatGuid`,
  // which let any non-empty `ctx.chatGuid` suppress the fallback checks when
  // the cached entry happened to lack chatGuid — letting a short id from
  // chat A be reused while acting in chat B.
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
  if (cachedChatGuid && ctxChatGuid) {
    return cachedChatGuid !== ctxChatGuid;
  }
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
  if (cachedChatIdentifier && ctxChatIdentifier) {
    return cachedChatIdentifier !== ctxChatIdentifier;
  }
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : undefined;
  const ctxChatId = typeof ctx.chatId === "number" ? ctx.chatId : undefined;
  if (cachedChatId !== undefined && ctxChatId !== undefined) {
    return cachedChatId !== ctxChatId;
  }
  return false;
}

function describeChatForError(values: {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
}): string {
  // Surface only the *shape* of the chat target, never the raw identifier,
  // to avoid leaking phone numbers / email addresses / chat GUIDs into
  // error messages that may end up in agent transcripts, tool results,
  // remote channel deliveries, or third-party log aggregators.
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
  // Don't reflect the raw message id back into an error message that may end
  // up in agent transcripts / tool results / log streams. Surface only the
  // shape (numeric short id length range, or a UUID prefix) so callers can
  // still tell which message id they typed (CWE-117 / CWE-200).
  if (inputKind === "short") {
    const len = inputId.length;
    return `<short:${len}-digit>`;
  }
  // For UUID input, expose just an 8-char prefix; consumer can correlate
  // against full GUID via the trace if needed.
  return `<uuid:${inputId.slice(0, 8)}…>`;
}

function buildCrossChatError(
  inputId: string,
  inputKind: "short" | "uuid",
  cached: BlueBubblesReplyCacheEntry,
  ctx: BlueBubblesChatContext,
): Error {
  const remediation =
    inputKind === "short"
      ? `Retry with the full message GUID to avoid cross-chat reactions/replies landing in the wrong conversation.`
      : `Retry with the correct chat target — even the full GUID cannot be reused across chats.`;
  return new Error(
    `BlueBubbles message id ${describeMessageIdForError(inputId, inputKind)} belongs to a different chat ` +
      `(${describeChatForError(cached)}) than the current call target ` +
      `(${describeChatForError(ctx)}). ${remediation}`,
  );
}

function hasChatScope(ctx?: BlueBubblesChatContext): boolean {
  if (!ctx) {
    return false;
  }
  return Boolean(
    normalizeOptionalString(ctx.chatGuid) ||
    normalizeOptionalString(ctx.chatIdentifier) ||
    typeof ctx.chatId === "number",
  );
}

/**
 * Resolves a short message ID (e.g., "1", "2") to a full BlueBubbles GUID.
 * Returns the input unchanged if it's already a GUID or not found in the mapping.
 *
 * When `chatContext` is provided, the resolved UUID's cached chat must match
 * the caller's chat or the call throws. This prevents a message id that points
 * at a message in chat A from being silently reused in chat B — the common
 * symptom being tapbacks and quoted replies landing in the wrong conversation
 * (e.g. a group reaction showing up in a DM) because short IDs are allocated
 * from a single global counter across every account and chat.
 *
 * The guard runs on both numeric short ids AND full GUIDs: an agent can paste
 * a GUID it harvested from history, a previous tool result, or another chat's
 * transcript, and that path used to bypass the cross-chat check entirely.
 */
export function resolveBlueBubblesMessageId(
  shortOrUuid: string,
  opts?: { requireKnownShortId?: boolean; chatContext?: BlueBubblesChatContext },
): string {
  const trimmed = shortOrUuid.trim();
  if (!trimmed) {
    return trimmed;
  }

  // If it looks like a short ID (numeric), try to resolve it
  if (/^\d+$/.test(trimmed)) {
    // Privileged callers (requireKnownShortId=true) MUST scope the resolution
    // to a chat. Without a chat scope the cross-chat guard cannot detect when
    // the short id belongs to a different chat than the action target — short
    // ids are allocated from a single global counter across every account and
    // chat, so an empty `chatContext={}` would otherwise let an action operate
    // on a message in the wrong conversation (CWE-285).
    if (opts?.requireKnownShortId && !hasChatScope(opts.chatContext)) {
      throw new Error(
        `BlueBubbles short message id "${describeMessageIdForError(trimmed, "short")}" requires a chat scope (chatGuid / chatIdentifier / chatId or a --to target).`,
      );
    }
    const uuid = blueBubblesShortIdToUuid.get(trimmed);
    if (uuid) {
      if (opts?.chatContext) {
        const cached = blueBubblesReplyCacheByMessageId.get(uuid);
        if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
          throw buildCrossChatError(trimmed, "short", cached, opts.chatContext);
        }
      }
      return uuid;
    }
    if (opts?.requireKnownShortId) {
      throw new Error(
        `BlueBubbles short message id ${describeMessageIdForError(trimmed, "short")} is no longer available. Use MessageSidFull.`,
      );
    }
    return trimmed;
  }

  // Full GUID input — guard still applies. Cache miss falls through to
  // returning the input unchanged so callers that supply a fresh-from-the-wire
  // GUID (not yet seen by reply cache) keep working.
  if (opts?.chatContext) {
    const cached = blueBubblesReplyCacheByMessageId.get(trimmed);
    if (cached && isCrossChatMismatch(cached, opts.chatContext)) {
      throw buildCrossChatError(trimmed, "uuid", cached, opts.chatContext);
    }
  }
  return trimmed;
}

/**
 * Resets the short ID state. Only use in tests.
 * @internal
 */
export function _resetBlueBubblesShortIdState(): void {
  blueBubblesShortIdToUuid.clear();
  blueBubblesUuidToShortId.clear();
  blueBubblesReplyCacheByMessageId.clear();
  blueBubblesShortIdCounter = 0;
}

/**
 * Gets the short ID for a message GUID, if one exists.
 */
export function getShortIdForUuid(uuid: string): string | undefined {
  return blueBubblesUuidToShortId.get(uuid.trim());
}

export function resolveReplyContextFromCache(params: {
  accountId: string;
  replyToId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
}): BlueBubblesReplyCacheEntry | null {
  const replyToId = params.replyToId.trim();
  if (!replyToId) {
    return null;
  }

  const cached = blueBubblesReplyCacheByMessageId.get(replyToId);
  if (!cached) {
    return null;
  }
  if (cached.accountId !== params.accountId) {
    return null;
  }

  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  if (cached.timestamp < cutoff) {
    blueBubblesReplyCacheByMessageId.delete(replyToId);
    return null;
  }

  const chatGuid = normalizeOptionalString(params.chatGuid);
  const chatIdentifier = normalizeOptionalString(params.chatIdentifier);
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const chatId = typeof params.chatId === "number" ? params.chatId : undefined;
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : undefined;

  // Avoid cross-chat collisions if we have identifiers.
  if (chatGuid && cachedChatGuid && chatGuid !== cachedChatGuid) {
    return null;
  }
  if (
    !chatGuid &&
    chatIdentifier &&
    cachedChatIdentifier &&
    chatIdentifier !== cachedChatIdentifier
  ) {
    return null;
  }
  if (!chatGuid && !chatIdentifier && chatId && cachedChatId && chatId !== cachedChatId) {
    return null;
  }

  return cached;
}
