import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const REPLY_CACHE_MAX = 2000;
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Recency window for the "react to the latest message" fallback. */
const LATEST_FALLBACK_MS = 10 * 60 * 1000;
let persistenceFailureLogged = false;
let parseFailureLogged = false;
function reportPersistenceFailure(scope: string, err: unknown): void {
  if (persistenceFailureLogged) {
    return;
  }
  persistenceFailureLogged = true;
  logVerbose(`imessage reply-cache: ${scope} disabled after first failure: ${String(err)}`);
}

export type IMessageChatContext = {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
};

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

const imessageReplyCacheByMessageId = new Map<string, IMessageReplyCacheEntry>();
const imessageShortIdToUuid = new Map<string, string>();
const imessageUuidToShortId = new Map<string, string>();
let imessageShortIdCounter = 0;

// On-disk persistence: short-id ↔ UUID mappings need to survive gateway
// restarts so an agent that received "[message_id:5]" before a restart can
// still react to that message after the restart. The on-disk store is
// best-effort — corruption or write failure falls back to the in-memory
// cache, so the worst case is the same as before persistence existed.

function resolveReplyCachePath(): string {
  return path.join(resolveStateDir(), "imessage", "reply-cache.jsonl");
}

function readPersistedEntries(): {
  entries: IMessageReplyCacheEntry[];
  maxObservedShortId: number;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveReplyCachePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      reportPersistenceFailure("read", err);
    }
    return { entries: [], maxObservedShortId: 0 };
  }
  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  const out: IMessageReplyCacheEntry[] = [];
  // The counter must advance past every shortId we have ever observed in
  // the file — including lines we skip because they are stale or malformed.
  // Otherwise a future allocation can collide with a still-live mapping
  // that came earlier in the file.
  let maxObservedShortId = 0;
  for (const line of raw.split(/\n+/)) {
    if (!line) {
      continue;
    }
    let parsed: Partial<IMessageReplyCacheEntry> | null = null;
    try {
      parsed = JSON.parse(line) as Partial<IMessageReplyCacheEntry>;
    } catch {
      if (!parseFailureLogged) {
        parseFailureLogged = true;
        logVerbose(
          `imessage reply-cache: dropping unparseable line (further parse errors suppressed)`,
        );
      }
      continue;
    }
    if (parsed && typeof parsed.shortId === "string") {
      const numeric = Number.parseInt(parsed.shortId, 10);
      if (Number.isFinite(numeric) && numeric > maxObservedShortId) {
        maxObservedShortId = numeric;
      }
    }
    if (
      typeof parsed?.accountId !== "string" ||
      typeof parsed.messageId !== "string" ||
      typeof parsed.shortId !== "string" ||
      typeof parsed.timestamp !== "number"
    ) {
      continue;
    }
    if (parsed.timestamp < cutoff) {
      continue;
    }
    out.push({
      accountId: parsed.accountId,
      messageId: parsed.messageId,
      shortId: parsed.shortId,
      timestamp: parsed.timestamp,
      chatGuid: typeof parsed.chatGuid === "string" ? parsed.chatGuid : undefined,
      chatIdentifier: typeof parsed.chatIdentifier === "string" ? parsed.chatIdentifier : undefined,
      chatId: typeof parsed.chatId === "number" ? parsed.chatId : undefined,
      isFromMe: typeof parsed.isFromMe === "boolean" ? parsed.isFromMe : undefined,
    });
  }
  return { entries: out.slice(-REPLY_CACHE_MAX), maxObservedShortId };
}

// reply-cache.jsonl maps gateway-allocated short-ids to message guids. A
// hostile same-UID process could otherwise (a) read the file to learn
// active conversation guids, or (b) inject lines so a future shortId
// resolution returns an attacker-chosen guid (allowing the agent to
// react/edit/unsend a message it never saw). Owner-only mode on both the
// directory and file closes that vector — defaults are 0755/0644 which
// are world-readable on a multi-user Mac.
const REPLY_CACHE_DIR_MODE = 0o700;
const REPLY_CACHE_FILE_MODE = 0o600;

function writePersistedEntries(entries: IMessageReplyCacheEntry[]): void {
  const filePath = resolveReplyCachePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: REPLY_CACHE_DIR_MODE });
    fs.writeFileSync(
      filePath,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""),
      { encoding: "utf8", mode: REPLY_CACHE_FILE_MODE },
    );
    // mkdirSync's mode is masked by umask and only applies on creation. If
    // the dir already existed from an older gateway version, clamp it now.
    try {
      fs.chmodSync(path.dirname(filePath), REPLY_CACHE_DIR_MODE);
      fs.chmodSync(filePath, REPLY_CACHE_FILE_MODE);
    } catch {
      // best-effort — fs may not support chmod on every platform
    }
  } catch (err) {
    reportPersistenceFailure("write", err);
  }
}

function appendPersistedEntry(entry: IMessageReplyCacheEntry): void {
  const filePath = resolveReplyCachePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: REPLY_CACHE_DIR_MODE });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: REPLY_CACHE_FILE_MODE,
    });
    // Always clamp — appendFileSync's `mode` only applies on creation, so
    // an existing 0644 file from an older gateway version would otherwise
    // never get tightened. chmod is microseconds; doing it every append
    // keeps the security guarantee monotonic instead of conditional on
    // creation order.
    try {
      fs.chmodSync(path.dirname(filePath), REPLY_CACHE_DIR_MODE);
      fs.chmodSync(filePath, REPLY_CACHE_FILE_MODE);
    } catch {
      // best-effort
    }
  } catch (err) {
    reportPersistenceFailure("append", err);
  }
}

let hydrated = false;
function hydrateFromDiskOnce(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  const { entries, maxObservedShortId } = readPersistedEntries();
  // Bump the counter past every observed shortId, even from dropped lines —
  // see comment in readPersistedEntries.
  if (maxObservedShortId > imessageShortIdCounter) {
    imessageShortIdCounter = maxObservedShortId;
  }
  if (entries.length === 0) {
    return;
  }
  // Entries are appended chronologically, so iterate forward to keep the
  // newest entry as the "live" mapping when the same messageId appears
  // multiple times (e.g. after a write-rewrite cycle).
  for (const entry of entries) {
    imessageReplyCacheByMessageId.set(entry.messageId, entry);
    imessageShortIdToUuid.set(entry.shortId, entry.messageId);
    imessageUuidToShortId.set(entry.messageId, entry.shortId);
  }
}

function generateShortId(): string {
  imessageShortIdCounter += 1;
  return String(imessageShortIdCounter);
}

export function rememberIMessageReplyCache(
  entry: Omit<IMessageReplyCacheEntry, "shortId">,
): IMessageReplyCacheEntry {
  hydrateFromDiskOnce();
  const messageId = entry.messageId.trim();
  if (!messageId) {
    return { ...entry, shortId: "" };
  }

  let shortId = imessageUuidToShortId.get(messageId);
  let allocatedNew = false;
  if (!shortId) {
    shortId = generateShortId();
    imessageShortIdToUuid.set(shortId, messageId);
    imessageUuidToShortId.set(messageId, shortId);
    allocatedNew = true;
  }

  const fullEntry: IMessageReplyCacheEntry = { ...entry, messageId, shortId };
  imessageReplyCacheByMessageId.delete(messageId);
  imessageReplyCacheByMessageId.set(messageId, fullEntry);

  const cutoff = Date.now() - REPLY_CACHE_TTL_MS;
  let evicted = false;
  for (const [key, value] of imessageReplyCacheByMessageId) {
    if (value.timestamp >= cutoff) {
      break;
    }
    imessageReplyCacheByMessageId.delete(key);
    if (value.shortId) {
      imessageShortIdToUuid.delete(value.shortId);
      imessageUuidToShortId.delete(key);
    }
    evicted = true;
  }
  while (imessageReplyCacheByMessageId.size > REPLY_CACHE_MAX) {
    const oldest = imessageReplyCacheByMessageId.keys().next().value;
    if (!oldest) {
      break;
    }
    const oldEntry = imessageReplyCacheByMessageId.get(oldest);
    imessageReplyCacheByMessageId.delete(oldest);
    if (oldEntry?.shortId) {
      imessageShortIdToUuid.delete(oldEntry.shortId);
      imessageUuidToShortId.delete(oldest);
    }
    evicted = true;
  }

  // Append-only is hot-path cheap; periodic rewrite happens when we evict
  // stale entries so the file does not grow unbounded across restarts.
  if (allocatedNew) {
    appendPersistedEntry(fullEntry);
  }
  if (evicted) {
    writePersistedEntries([...imessageReplyCacheByMessageId.values()]);
  }

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

/**
 * Strip the `iMessage;-;` / `SMS;-;` / `any;-;` service prefix that Messages
 * uses for direct chats. Different layers report direct DMs in different
 * forms — imsg's watch emits the bare handle plus an `any;-;…` chat_guid,
 * the action surface synthesizes `iMessage;-;…` from a phone-number target —
 * so comparing the raw strings would falsely flag the same chat as a
 * cross-chat target. Normalize both sides to the bare suffix.
 */
function normalizeDirectChatIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  for (const prefix of ["imessage;-;", "sms;-;", "any;-;"]) {
    if (lowered.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

function isCrossChatMismatch(cached: IMessageReplyCacheEntry, ctx: IMessageChatContext): boolean {
  const cachedChatGuid = normalizeOptionalString(cached.chatGuid);
  const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
  if (cachedChatGuid && ctxChatGuid) {
    if (
      normalizeDirectChatIdentifier(cachedChatGuid) === normalizeDirectChatIdentifier(ctxChatGuid)
    ) {
      return false;
    }
    return cachedChatGuid !== ctxChatGuid;
  }
  const cachedChatIdentifier = normalizeOptionalString(cached.chatIdentifier);
  const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
  if (cachedChatIdentifier && ctxChatIdentifier) {
    if (
      normalizeDirectChatIdentifier(cachedChatIdentifier) ===
      normalizeDirectChatIdentifier(ctxChatIdentifier)
    ) {
      return false;
    }
    return cachedChatIdentifier !== ctxChatIdentifier;
  }
  const cachedChatId = typeof cached.chatId === "number" ? cached.chatId : undefined;
  const ctxChatId = typeof ctx.chatId === "number" ? ctx.chatId : undefined;
  if (cachedChatId !== undefined && ctxChatId !== undefined) {
    return cachedChatId !== ctxChatId;
  }
  // Cross-format pairing: caller supplied chatIdentifier=iMessage;-;<phone>
  // and the cache stored chatGuid=any;-;<phone> (or vice versa). Compare via
  // the direct-DM normalization so we recognize them as the same chat.
  const cachedFingerprint = cachedChatGuid
    ? normalizeDirectChatIdentifier(cachedChatGuid)
    : cachedChatIdentifier
      ? normalizeDirectChatIdentifier(cachedChatIdentifier)
      : undefined;
  const ctxFingerprint = ctxChatGuid
    ? normalizeDirectChatIdentifier(ctxChatGuid)
    : ctxChatIdentifier
      ? normalizeDirectChatIdentifier(ctxChatIdentifier)
      : undefined;
  if (cachedFingerprint && ctxFingerprint) {
    return cachedFingerprint !== ctxFingerprint;
  }
  return false;
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
      ? "Retry with MessageSidFull to avoid cross-chat reactions/replies landing in the wrong conversation."
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
  // Hydrate the on-disk JSONL into the in-memory maps before reading them.
  // Without this, the first post-restart action that arrives with a short
  // MessageSid would miss `imessageShortIdToUuid` and fall through to the
  // "no longer available" path, breaking the persistence contract — the
  // mapping was on disk, we just hadn't read it yet on this read path.
  // `rememberIMessageReplyCache` already hydrates on its own, so this only
  // matters for the resolve-first-after-restart sequence.
  hydrateFromDiskOnce();

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
  hydrateFromDiskOnce();
  const cached = imessageReplyCacheByMessageId.get(trimmed);
  if (!cached || cached.isFromMe !== true || cached.accountId !== ctx.accountId) {
    return false;
  }
  return isPositiveChatMatch(cached, ctx);
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
    if (!isPositiveChatMatch(entry, ctx)) {
      continue;
    }
    if (!best || entry.timestamp > best.timestamp) {
      best = entry;
    }
  }
  return best;
}

/**
 * Return true when the cached entry positively matches the caller's chat
 * context on at least one identifier kind. Unlike `isCrossChatMismatch`,
 * which returns false for "no overlap," this requires concrete agreement.
 */
function isPositiveChatMatch(entry: IMessageReplyCacheEntry, ctx: IMessageChatContext): boolean {
  const cachedChatGuid = normalizeOptionalString(entry.chatGuid);
  const ctxChatGuid = normalizeOptionalString(ctx.chatGuid);
  if (cachedChatGuid && ctxChatGuid && cachedChatGuid === ctxChatGuid) {
    return true;
  }
  const cachedChatIdentifier = normalizeOptionalString(entry.chatIdentifier);
  const ctxChatIdentifier = normalizeOptionalString(ctx.chatIdentifier);
  if (cachedChatIdentifier && ctxChatIdentifier && cachedChatIdentifier === ctxChatIdentifier) {
    return true;
  }
  if (
    typeof entry.chatId === "number" &&
    typeof ctx.chatId === "number" &&
    entry.chatId === ctx.chatId
  ) {
    return true;
  }
  // Cross-format: cached chatGuid vs ctx chatIdentifier, etc. Compare via
  // the direct-DM normalization that strips iMessage;-;/SMS;-;/any;-; .
  const cachedFingerprint = cachedChatGuid
    ? normalizeDirectChatIdentifier(cachedChatGuid)
    : cachedChatIdentifier
      ? normalizeDirectChatIdentifier(cachedChatIdentifier)
      : undefined;
  const ctxFingerprint = ctxChatGuid
    ? normalizeDirectChatIdentifier(ctxChatGuid)
    : ctxChatIdentifier
      ? normalizeDirectChatIdentifier(ctxChatIdentifier)
      : undefined;
  if (cachedFingerprint && ctxFingerprint && cachedFingerprint === ctxFingerprint) {
    return true;
  }
  return false;
}

export function _resetIMessageShortIdState(): void {
  imessageReplyCacheByMessageId.clear();
  imessageShortIdToUuid.clear();
  imessageUuidToShortId.clear();
  imessageShortIdCounter = 0;
  hydrated = false;
  persistenceFailureLogged = false;
  parseFailureLogged = false;
  // Only delete the persisted file when the test harness has explicitly
  // pointed us at an isolated state directory. Otherwise we would nuke
  // whatever live gateway happens to share `~/.openclaw` — and in vitest
  // file-level parallelism, two test files calling this at once could
  // race a peer's appendFileSync mid-write.
  if (!process.env.OPENCLAW_STATE_DIR) {
    return;
  }
  try {
    fs.rmSync(resolveReplyCachePath(), { force: true });
  } catch {
    // best-effort
  }
}
