import {
  resolveOutboundMediaUrls,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  downloadBlueBubblesAttachment,
  fetchBlueBubblesMessageAttachments,
} from "./attachments.js";
import { markBlueBubblesChatRead, sendBlueBubblesTyping } from "./chat.js";
import { createBlueBubblesClientFromParts } from "./client.js";
import { resolveBlueBubblesConversationRoute } from "./conversation-route.js";
import { fetchBlueBubblesHistory } from "./history.js";
import {
  claimBlueBubblesInboundMessage,
  commitBlueBubblesCoalescedMessageIds,
  resolveBlueBubblesInboundDedupeKey,
} from "./inbound-dedupe.js";
import { sendBlueBubblesMedia } from "./media-send.js";
import {
  buildMessagePlaceholder,
  formatGroupAllowlistEntry,
  formatGroupMembers,
  formatReplyTag,
  normalizeParticipantList,
  parseTapbackText,
  resolveGroupFlagFromChatGuid,
  resolveTapbackContext,
  type NormalizedWebhookMessage,
  type NormalizedWebhookReaction,
} from "./monitor-normalize.js";
import {
  DM_GROUP_ACCESS_REASON,
  createChannelPairingController,
  createChannelReplyPipeline,
  evictOldHistoryKeys,
  evaluateSupplementalContextVisibility,
  logAckFailure,
  logInboundDrop,
  logTypingFailure,
  mapAllowFromEntries,
  readStoreAllowFromForDmPolicy,
  recordPendingHistoryEntryIfEnabled,
  resolveAckReaction,
  resolveChannelContextVisibilityMode,
  resolveDmGroupAccessWithLists,
  resolveControlCommandGate,
  stripMarkdown,
  type HistoryEntry,
} from "./monitor-processing-api.js";
import {
  getShortIdForUuid,
  rememberBlueBubblesReplyCache,
  resolveBlueBubblesMessageId,
  resolveReplyContextFromCache,
} from "./monitor-reply-cache.js";
import {
  hasBlueBubblesSelfChatCopy,
  rememberBlueBubblesSelfChatCopy,
} from "./monitor-self-chat-cache.js";
import type {
  BlueBubblesCoreRuntime,
  BlueBubblesRuntimeEnv,
  WebhookTarget,
} from "./monitor-shared.js";
import { enrichBlueBubblesParticipantsWithContactNames } from "./participant-contact-names.js";
import { isBlueBubblesPrivateApiEnabled } from "./probe.js";
import { normalizeBlueBubblesReactionInputStrict, sendBlueBubblesReaction } from "./reactions.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";
import {
  extractHandleFromChatGuid,
  formatBlueBubblesChatTarget,
  isAllowedBlueBubblesSender,
  normalizeBlueBubblesHandle,
} from "./targets.js";

const DEFAULT_TEXT_LIMIT = 4000;
const invalidAckReactions = new Set<string>();
const REPLY_DIRECTIVE_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]/gi;
const PENDING_OUTBOUND_MESSAGE_ID_TTL_MS = 2 * 60 * 1000;

type PendingOutboundMessageId = {
  id: number;
  accountId: string;
  sessionKey: string;
  outboundTarget: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  snippetRaw: string;
  snippetNorm: string;
  isMediaSnippet: boolean;
  createdAt: number;
};

const pendingOutboundMessageIds: PendingOutboundMessageId[] = [];
let pendingOutboundMessageIdCounter = 0;

function normalizeSnippet(value: string): string {
  return normalizeOptionalLowercaseString(stripMarkdown(value).replace(/\s+/g, " ")) ?? "";
}

type BlueBubblesChatRecord = Record<string, unknown>;

function extractBlueBubblesChatGuid(chat: BlueBubblesChatRecord): string | undefined {
  const candidates = [chat.chatGuid, chat.guid, chat.chat_guid];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function extractBlueBubblesChatId(chat: BlueBubblesChatRecord): number | undefined {
  const candidates = [chat.chatId, chat.id, chat.chat_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractChatIdentifierFromChatGuid(chatGuid: string): string | undefined {
  const parts = chatGuid.split(";");
  if (parts.length < 3) {
    return undefined;
  }
  const identifier = parts[2]?.trim();
  return identifier || undefined;
}

function extractBlueBubblesChatIdentifier(chat: BlueBubblesChatRecord): string | undefined {
  const candidates = [chat.chatIdentifier, chat.chat_identifier, chat.identifier];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  const chatGuid = extractBlueBubblesChatGuid(chat);
  return chatGuid ? extractChatIdentifierFromChatGuid(chatGuid) : undefined;
}

async function queryBlueBubblesChats(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  offset: number;
  limit: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesChatRecord[]> {
  const client = createBlueBubblesClientFromParts({
    baseUrl: params.baseUrl,
    password: params.password,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    timeoutMs: params.timeoutMs,
  });
  const res = await client.request({
    method: "POST",
    path: "/api/v1/chat/query",
    body: {
      limit: params.limit,
      offset: params.offset,
      with: ["participants"],
    },
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    return [];
  }
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const data = payload && payload.data !== undefined ? (payload.data as unknown) : null;
  return Array.isArray(data) ? (data as BlueBubblesChatRecord[]) : [];
}

async function fetchBlueBubblesParticipantsForInboundMessage(params: {
  baseUrl: string;
  password: string;
  chatGuid?: string;
  chatId?: number;
  chatIdentifier?: string;
  allowPrivateNetwork?: boolean;
}): Promise<import("./monitor-normalize.js").BlueBubblesParticipant[] | null> {
  if (!params.chatGuid && params.chatId == null && !params.chatIdentifier) {
    return null;
  }

  const limit = 500;
  for (let offset = 0; offset < 5000; offset += limit) {
    const chats = await queryBlueBubblesChats({
      baseUrl: params.baseUrl,
      password: params.password,
      offset,
      limit,
      allowPrivateNetwork: params.allowPrivateNetwork,
    });
    if (chats.length === 0) {
      return null;
    }

    for (const chat of chats) {
      const chatGuid = extractBlueBubblesChatGuid(chat);
      const chatId = extractBlueBubblesChatId(chat);
      const chatIdentifier = extractBlueBubblesChatIdentifier(chat);
      const matches =
        (params.chatGuid && chatGuid === params.chatGuid) ||
        (params.chatId != null && chatId === params.chatId) ||
        (params.chatIdentifier &&
          (chatIdentifier === params.chatIdentifier || chatGuid === params.chatIdentifier));
      if (matches) {
        return normalizeParticipantList(chat);
      }
    }

    if (chats.length < limit) {
      return null;
    }
  }

  return null;
}

function isBlueBubblesSelfChatMessage(
  message: NormalizedWebhookMessage,
  isGroup: boolean,
): boolean {
  if (isGroup || !message.senderIdExplicit) {
    return false;
  }
  const chatHandle =
    (message.chatGuid ? extractHandleFromChatGuid(message.chatGuid) : null) ??
    normalizeBlueBubblesHandle(message.chatIdentifier ?? "");
  return Boolean(chatHandle) && chatHandle === message.senderId;
}

function prunePendingOutboundMessageIds(now = Date.now()): void {
  const cutoff = now - PENDING_OUTBOUND_MESSAGE_ID_TTL_MS;
  for (let i = pendingOutboundMessageIds.length - 1; i >= 0; i--) {
    if (pendingOutboundMessageIds[i].createdAt < cutoff) {
      pendingOutboundMessageIds.splice(i, 1);
    }
  }
}

function rememberPendingOutboundMessageId(entry: {
  accountId: string;
  sessionKey: string;
  outboundTarget: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  snippet: string;
}): number {
  prunePendingOutboundMessageIds();
  pendingOutboundMessageIdCounter += 1;
  const snippetRaw = entry.snippet.trim();
  const snippetNorm = normalizeSnippet(snippetRaw);
  pendingOutboundMessageIds.push({
    id: pendingOutboundMessageIdCounter,
    accountId: entry.accountId,
    sessionKey: entry.sessionKey,
    outboundTarget: entry.outboundTarget,
    chatGuid: normalizeOptionalString(entry.chatGuid),
    chatIdentifier: normalizeOptionalString(entry.chatIdentifier),
    chatId: typeof entry.chatId === "number" ? entry.chatId : undefined,
    snippetRaw,
    snippetNorm,
    isMediaSnippet: normalizeLowercaseStringOrEmpty(snippetRaw).startsWith("<media:"),
    createdAt: Date.now(),
  });
  return pendingOutboundMessageIdCounter;
}

function forgetPendingOutboundMessageId(id: number): void {
  const index = pendingOutboundMessageIds.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    pendingOutboundMessageIds.splice(index, 1);
  }
}

function chatsMatch(
  left: Pick<PendingOutboundMessageId, "chatGuid" | "chatIdentifier" | "chatId">,
  right: { chatGuid?: string; chatIdentifier?: string; chatId?: number },
): boolean {
  const leftGuid = normalizeOptionalString(left.chatGuid);
  const rightGuid = normalizeOptionalString(right.chatGuid);
  if (leftGuid && rightGuid) {
    return leftGuid === rightGuid;
  }

  const leftIdentifier = normalizeOptionalString(left.chatIdentifier);
  const rightIdentifier = normalizeOptionalString(right.chatIdentifier);
  if (leftIdentifier && rightIdentifier) {
    return leftIdentifier === rightIdentifier;
  }

  const leftChatId = typeof left.chatId === "number" ? left.chatId : undefined;
  const rightChatId = typeof right.chatId === "number" ? right.chatId : undefined;
  if (leftChatId !== undefined && rightChatId !== undefined) {
    return leftChatId === rightChatId;
  }

  return false;
}

function consumePendingOutboundMessageId(params: {
  accountId: string;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  body: string;
}): PendingOutboundMessageId | null {
  prunePendingOutboundMessageIds();
  const bodyNorm = normalizeSnippet(params.body);
  const isMediaBody = normalizeLowercaseStringOrEmpty(params.body).startsWith("<media:");

  for (let i = 0; i < pendingOutboundMessageIds.length; i++) {
    const entry = pendingOutboundMessageIds[i];
    if (entry.accountId !== params.accountId) {
      continue;
    }
    if (!chatsMatch(entry, params)) {
      continue;
    }
    if (entry.snippetNorm && entry.snippetNorm === bodyNorm) {
      pendingOutboundMessageIds.splice(i, 1);
      return entry;
    }
    if (entry.isMediaSnippet && isMediaBody) {
      pendingOutboundMessageIds.splice(i, 1);
      return entry;
    }
  }

  return null;
}

export function logVerbose(
  core: BlueBubblesCoreRuntime,
  runtime: BlueBubblesRuntimeEnv,
  message: string,
): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[bluebubbles] ${message}`);
  }
}

function logGroupAllowlistHint(params: {
  runtime: BlueBubblesRuntimeEnv;
  reason: string;
  entry: string | null;
  chatName?: string;
  accountId?: string;
}): void {
  const log = params.runtime.log ?? console.log;
  const nameHint = params.chatName ? ` (group name: ${params.chatName})` : "";
  const accountHint = params.accountId
    ? ` (or channels.bluebubbles.accounts.${params.accountId}.groupAllowFrom)`
    : "";
  if (params.entry) {
    log(
      `[bluebubbles] group message blocked (${params.reason}). Allow this group by adding ` +
        `"${params.entry}" to channels.bluebubbles.groupAllowFrom${nameHint}.`,
    );
    log(
      `[bluebubbles] add to config: channels.bluebubbles.groupAllowFrom=["${params.entry}"]${accountHint}.`,
    );
    return;
  }
  log(
    `[bluebubbles] group message blocked (${params.reason}). Allow groups by setting ` +
      `channels.bluebubbles.groupPolicy="open" or adding a group id to ` +
      `channels.bluebubbles.groupAllowFrom${accountHint}${nameHint}.`,
  );
}

function resolveBlueBubblesAckReaction(params: {
  cfg: OpenClawConfig;
  agentId: string;
  core: BlueBubblesCoreRuntime;
  runtime: BlueBubblesRuntimeEnv;
}): string | null {
  const raw = resolveAckReaction(params.cfg, params.agentId).trim();
  if (!raw) {
    return null;
  }
  try {
    normalizeBlueBubblesReactionInputStrict(raw);
    return raw;
  } catch {
    const key = normalizeLowercaseStringOrEmpty(raw);
    if (!invalidAckReactions.has(key)) {
      invalidAckReactions.add(key);
      logVerbose(
        params.core,
        params.runtime,
        `ack reaction skipped (unsupported for BlueBubbles): ${raw}`,
      );
    }
    return null;
  }
}

/**
 * In-memory rolling history map keyed by account + chat identifier.
 * Populated from incoming messages during the session.
 * API backfill is attempted until one fetch resolves (or retries are exhausted).
 */
const chatHistories = new Map<string, HistoryEntry[]>();
type HistoryBackfillState = {
  attempts: number;
  firstAttemptAt: number;
  nextAttemptAt: number;
  resolved: boolean;
};

const historyBackfills = new Map<string, HistoryBackfillState>();
const HISTORY_BACKFILL_BASE_DELAY_MS = 5_000;
const HISTORY_BACKFILL_MAX_DELAY_MS = 2 * 60 * 1000;
const HISTORY_BACKFILL_MAX_ATTEMPTS = 6;
const HISTORY_BACKFILL_RETRY_WINDOW_MS = 30 * 60 * 1000;
const MAX_STORED_HISTORY_ENTRY_CHARS = 2_000;
const MAX_INBOUND_HISTORY_ENTRY_CHARS = 1_200;
const MAX_INBOUND_HISTORY_TOTAL_CHARS = 12_000;

function buildAccountScopedHistoryKey(accountId: string, historyIdentifier: string): string {
  return `${accountId}\u0000${historyIdentifier}`;
}

function historyDedupKey(entry: HistoryEntry): string {
  const messageId = entry.messageId?.trim();
  if (messageId) {
    return `id:${messageId}`;
  }
  return `fallback:${entry.sender}\u0000${entry.body}\u0000${entry.timestamp ?? ""}`;
}

function truncateHistoryBody(body: string, maxChars: number): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}...`;
}

function mergeHistoryEntries(params: {
  apiEntries: HistoryEntry[];
  currentEntries: HistoryEntry[];
  limit: number;
}): HistoryEntry[] {
  if (params.limit <= 0) {
    return [];
  }

  const merged: HistoryEntry[] = [];
  const seen = new Set<string>();
  const appendUnique = (entry: HistoryEntry) => {
    const key = historyDedupKey(entry);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(entry);
  };

  for (const entry of params.apiEntries) {
    appendUnique(entry);
  }
  for (const entry of params.currentEntries) {
    appendUnique(entry);
  }

  if (merged.length <= params.limit) {
    return merged;
  }
  return merged.slice(merged.length - params.limit);
}

function pruneHistoryBackfillState(): void {
  for (const key of historyBackfills.keys()) {
    if (!chatHistories.has(key)) {
      historyBackfills.delete(key);
    }
  }
}

function markHistoryBackfillResolved(historyKey: string): void {
  const state = historyBackfills.get(historyKey);
  if (state) {
    state.resolved = true;
    historyBackfills.set(historyKey, state);
    return;
  }
  historyBackfills.set(historyKey, {
    attempts: 0,
    firstAttemptAt: Date.now(),
    nextAttemptAt: Number.POSITIVE_INFINITY,
    resolved: true,
  });
}

function planHistoryBackfillAttempt(historyKey: string, now: number): HistoryBackfillState | null {
  const existing = historyBackfills.get(historyKey);
  if (existing?.resolved) {
    return null;
  }
  if (existing && now - existing.firstAttemptAt > HISTORY_BACKFILL_RETRY_WINDOW_MS) {
    markHistoryBackfillResolved(historyKey);
    return null;
  }
  if (existing && existing.attempts >= HISTORY_BACKFILL_MAX_ATTEMPTS) {
    markHistoryBackfillResolved(historyKey);
    return null;
  }
  if (existing && now < existing.nextAttemptAt) {
    return null;
  }

  const attempts = (existing?.attempts ?? 0) + 1;
  const firstAttemptAt = existing?.firstAttemptAt ?? now;
  const backoffDelay = Math.min(
    HISTORY_BACKFILL_BASE_DELAY_MS * 2 ** (attempts - 1),
    HISTORY_BACKFILL_MAX_DELAY_MS,
  );
  const state: HistoryBackfillState = {
    attempts,
    firstAttemptAt,
    nextAttemptAt: now + backoffDelay,
    resolved: false,
  };
  historyBackfills.set(historyKey, state);
  return state;
}

function buildInboundHistorySnapshot(params: {
  entries: HistoryEntry[];
  limit: number;
}): Array<{ sender: string; body: string; timestamp?: number }> | undefined {
  if (params.limit <= 0 || params.entries.length === 0) {
    return undefined;
  }
  const recent = params.entries.slice(-params.limit);
  const selected: Array<{ sender: string; body: string; timestamp?: number }> = [];
  let remainingChars = MAX_INBOUND_HISTORY_TOTAL_CHARS;

  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i];
    const body = truncateHistoryBody(entry.body, MAX_INBOUND_HISTORY_ENTRY_CHARS);
    if (!body) {
      continue;
    }
    if (selected.length > 0 && body.length > remainingChars) {
      break;
    }
    selected.push({
      sender: entry.sender,
      body,
      timestamp: entry.timestamp,
    });
    remainingChars -= body.length;
    if (remainingChars <= 0) {
      break;
    }
  }

  if (selected.length === 0) {
    return undefined;
  }
  selected.reverse();
  return selected;
}

function sanitizeForLog(value: unknown, maxLen = 200): string {
  const cleaned = String(value).replace(/[\r\n\t\p{C}]/gu, " ");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "..." : cleaned;
}

/**
 * Signal object threaded through `processMessageAfterDedupe` so the outer
 * wrapper can distinguish "reply delivery failed silently" from "returned
 * normally after an intentional drop" (fromMe cache, pairing flow, allowlist
 * block, empty text, etc.).
 *
 * Reply delivery errors in the BlueBubbles path surface through the
 * dispatcher's `onError` callback rather than as thrown exceptions, so a
 * plain try/catch cannot detect them — see review thread `rwF8` on #66230.
 */
type InboundDedupeDeliverySignal = { deliveryFailed: boolean };

/**
 * Claim → process → finalize/release wrapper around the real inbound flow.
 *
 * Claim before doing any work so restart replays and in-flight concurrent
 * redeliveries both drop cleanly. Finalize (persist the GUID) only when
 * processing completed cleanly AND any reply dispatch reported success;
 * release (let a later replay try again) when processing threw OR the reply
 * pipeline reported a delivery failure via its onError callback.
 *
 * The dedupe key follows the same canonicalization rules as the debouncer
 * (`monitor-debounce.ts`): balloon events (URL previews, stickers) share
 * a logical identity with their originating text message via
 * `associatedMessageGuid`, so balloon-first vs text-first event ordering
 * cannot produce two distinct dedupe keys for the same logical message.
 */
export async function processMessage(
  message: NormalizedWebhookMessage,
  target: WebhookTarget,
): Promise<void> {
  const { account, core, runtime } = target;

  const dedupeKey = resolveBlueBubblesInboundDedupeKey(message);

  // Drop BlueBubbles MessagePoller replays after server restart (#19176, #12053).
  const claim = await claimBlueBubblesInboundMessage({
    guid: dedupeKey,
    accountId: account.accountId,
    onDiskError: (error) =>
      logVerbose(core, runtime, `inbound-dedupe disk error: ${sanitizeForLog(error)}`),
  });
  if (claim.kind === "duplicate" || claim.kind === "inflight") {
    logVerbose(
      core,
      runtime,
      `drop: ${claim.kind} inbound key=${sanitizeForLog(dedupeKey ?? "")} sender=${sanitizeForLog(message.senderId)}`,
    );
    return;
  }

  const signal: InboundDedupeDeliverySignal = { deliveryFailed: false };
  try {
    await processMessageAfterDedupe(message, target, signal);
  } catch (error) {
    if (claim.kind === "claimed") {
      claim.release();
    }
    throw error;
  }
  if (claim.kind === "claimed") {
    if (signal.deliveryFailed) {
      logVerbose(
        core,
        runtime,
        `inbound-dedupe: releasing claim for key=${sanitizeForLog(dedupeKey ?? "")} after reply delivery failure (will retry on replay)`,
      );
      claim.release();
    } else {
      try {
        await claim.finalize();
      } catch (finalizeError) {
        // commit() already clears inflight state in its finally block, so
        // no explicit release() needed here — just log the persistence error.
        logVerbose(
          core,
          runtime,
          `inbound-dedupe: finalize failed for key=${sanitizeForLog(dedupeKey ?? "")}: ${sanitizeForLog(finalizeError)}`,
        );
      }
      // When the debouncer coalesced multiple source webhook events into this
      // single processed message, every source messageId must reach dedupe so
      // a later MessagePoller replay of any individual source event is
      // recognized as a duplicate. The primary is already finalized above;
      // commit the rest here (best-effort, per-id).
      const secondaryIds = (message.coalescedMessageIds ?? []).filter((id) => id !== dedupeKey);
      if (secondaryIds.length > 0) {
        try {
          await commitBlueBubblesCoalescedMessageIds({
            messageIds: secondaryIds,
            accountId: account.accountId,
            onDiskError: (error) =>
              logVerbose(
                core,
                runtime,
                `inbound-dedupe: coalesced secondary commit disk error: ${sanitizeForLog(error)}`,
              ),
          });
        } catch (secondaryError) {
          logVerbose(
            core,
            runtime,
            `inbound-dedupe: coalesced secondary commit failed for primary=${sanitizeForLog(dedupeKey ?? "")}: ${sanitizeForLog(secondaryError)}`,
          );
        }
      }
    }
  }
}

async function processMessageAfterDedupe(
  message: NormalizedWebhookMessage,
  target: WebhookTarget,
  dedupeSignal: InboundDedupeDeliverySignal,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;

  const pairing = createChannelPairingController({
    core,
    channel: "bluebubbles",
    accountId: account.accountId,
  });
  const privateApiEnabled = isBlueBubblesPrivateApiEnabled(account.accountId);

  const groupFlag = resolveGroupFlagFromChatGuid(message.chatGuid);
  const isGroup = typeof groupFlag === "boolean" ? groupFlag : message.isGroup;

  const text = message.text.trim();
  let attachments = message.attachments ?? [];
  const baseUrl = normalizeSecretInputString(account.config.serverUrl);
  const password = normalizeSecretInputString(account.config.password);

  // BlueBubbles may fire the webhook before attachment indexing is complete,
  // so the initial `attachments` array can be empty for messages that actually
  // have media. When the message text is empty (image-only) or this is an
  // `updated-message` event, wait briefly and re-fetch from the BB API as a
  // fallback for cases where BB doesn't send a follow-up webhook. (#65430, #67437)
  // This must run before the !rawBody guard below, otherwise image-only messages
  // with empty attachments are dropped before the retry can fire.
  const retryMessageId = message.messageId?.trim();
  const shouldRetryAttachments =
    attachments.length === 0 &&
    retryMessageId &&
    baseUrl &&
    password &&
    (text.length === 0 || message.eventType === "updated-message");
  if (shouldRetryAttachments) {
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      const fetched = await fetchBlueBubblesMessageAttachments(retryMessageId, {
        baseUrl,
        password,
        timeoutMs: 10_000,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      });
      if (fetched.length > 0) {
        logVerbose(
          core,
          runtime,
          `attachment retry found ${fetched.length} attachment(s) for msgId=${message.messageId}`,
        );
        attachments = fetched;
      }
    } catch (err) {
      logVerbose(
        core,
        runtime,
        `attachment retry failed for msgId=${message.messageId}: ${String(err)}`,
      );
    }
  }

  // Recompute placeholder from resolved attachments (may have been updated by retry).
  const placeholder = buildMessagePlaceholder({ ...message, attachments });
  // Check if text is a tapback pattern (e.g., 'Loved "hello"') and transform to emoji format
  // For tapbacks, we'll append [[reply_to:N]] at the end; for regular messages, prepend it
  const tapbackContext = resolveTapbackContext(message);
  const tapbackParsed = parseTapbackText({
    text,
    emojiHint: tapbackContext?.emojiHint,
    actionHint: tapbackContext?.actionHint,
    requireQuoted: !tapbackContext,
  });
  const isTapbackMessage = Boolean(tapbackParsed);
  const rawBody = tapbackParsed
    ? tapbackParsed.action === "removed"
      ? `removed ${tapbackParsed.emoji} reaction`
      : `reacted with ${tapbackParsed.emoji}`
    : text || placeholder;
  const isSelfChatMessage = isBlueBubblesSelfChatMessage(message, isGroup);
  const selfChatLookup = {
    accountId: account.accountId,
    chatGuid: message.chatGuid,
    chatIdentifier: message.chatIdentifier,
    chatId: message.chatId,
    senderId: message.senderId,
    body: rawBody,
    timestamp: message.timestamp,
  };

  const cacheMessageId = message.messageId?.trim();
  const confirmedOutboundCacheEntry = cacheMessageId
    ? resolveReplyContextFromCache({
        accountId: account.accountId,
        replyToId: cacheMessageId,
        chatGuid: message.chatGuid,
        chatIdentifier: message.chatIdentifier,
        chatId: message.chatId,
      })
    : null;
  let messageShortId: string | undefined;
  const cacheInboundMessage = () => {
    if (!cacheMessageId) {
      return;
    }
    const cacheEntry = rememberBlueBubblesReplyCache({
      accountId: account.accountId,
      messageId: cacheMessageId,
      chatGuid: message.chatGuid,
      chatIdentifier: message.chatIdentifier,
      chatId: message.chatId,
      senderLabel: message.fromMe ? "me" : message.senderId,
      body: rawBody,
      timestamp: message.timestamp ?? Date.now(),
    });
    messageShortId = cacheEntry.shortId;
  };

  if (message.fromMe) {
    // Cache from-me messages so reply context can resolve sender/body.
    cacheInboundMessage();
    const confirmedAssistantOutbound =
      confirmedOutboundCacheEntry?.senderLabel === "me" &&
      normalizeSnippet(confirmedOutboundCacheEntry.body ?? "") === normalizeSnippet(rawBody);
    if (isSelfChatMessage && confirmedAssistantOutbound) {
      rememberBlueBubblesSelfChatCopy(selfChatLookup);
    }
    if (cacheMessageId) {
      const pending = consumePendingOutboundMessageId({
        accountId: account.accountId,
        chatGuid: message.chatGuid,
        chatIdentifier: message.chatIdentifier,
        chatId: message.chatId,
        body: rawBody,
      });
      if (pending) {
        const displayId = getShortIdForUuid(cacheMessageId) || cacheMessageId;
        const previewSource = pending.snippetRaw || rawBody;
        const preview = previewSource
          ? ` "${previewSource.slice(0, 12)}${previewSource.length > 12 ? "…" : ""}"`
          : "";
        core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
          sessionKey: pending.sessionKey,
          contextKey: `bluebubbles:outbound:${pending.outboundTarget}:${cacheMessageId}`,
        });
      }
    }
    return;
  }

  if (isSelfChatMessage && hasBlueBubblesSelfChatCopy(selfChatLookup)) {
    logVerbose(core, runtime, `drop: reflected self-chat duplicate sender=${message.senderId}`);
    return;
  }

  if (!rawBody) {
    logVerbose(core, runtime, `drop: empty text sender=${message.senderId}`);
    return;
  }
  logVerbose(
    core,
    runtime,
    `msg sender=${message.senderId} group=${isGroup} textLen=${text.length} attachments=${attachments.length} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
  );

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const configuredAllowFrom = mapAllowFromEntries(account.config.allowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "bluebubbles",
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configuredAllowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowFrom) =>
      isAllowedBlueBubblesSender({
        allowFrom,
        sender: message.senderId,
        chatId: message.chatId ?? undefined,
        chatGuid: message.chatGuid ?? undefined,
        chatIdentifier: message.chatIdentifier ?? undefined,
      }),
  });
  const effectiveAllowFrom = accessDecision.effectiveAllowFrom;
  const effectiveGroupAllowFrom = accessDecision.effectiveGroupAllowFrom;
  const groupAllowEntry = formatGroupAllowlistEntry({
    chatGuid: message.chatGuid,
    chatId: message.chatId ?? undefined,
    chatIdentifier: message.chatIdentifier ?? undefined,
  });
  const groupName = normalizeOptionalString(message.chatName);

  if (accessDecision.decision !== "allow") {
    if (isGroup) {
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        logVerbose(core, runtime, "Blocked BlueBubbles group message (groupPolicy=disabled)");
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=disabled",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId,
        });
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        logVerbose(core, runtime, "Blocked BlueBubbles group message (no allowlist)");
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=allowlist (empty allowlist)",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId,
        });
        return;
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        logVerbose(
          core,
          runtime,
          `Blocked BlueBubbles sender ${message.senderId} (not in groupAllowFrom)`,
        );
        logVerbose(
          core,
          runtime,
          `drop: group sender not allowed sender=${message.senderId} allowFrom=${effectiveGroupAllowFrom.join(",")}`,
        );
        logGroupAllowlistHint({
          runtime,
          reason: "groupPolicy=allowlist (not allowlisted)",
          entry: groupAllowEntry,
          chatName: groupName,
          accountId: account.accountId,
        });
        return;
      }
      return;
    }

    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
      logVerbose(core, runtime, `Blocked BlueBubbles DM from ${message.senderId}`);
      logVerbose(core, runtime, `drop: dmPolicy disabled sender=${message.senderId}`);
      return;
    }

    if (accessDecision.decision === "pairing") {
      await pairing.issueChallenge({
        senderId: message.senderId,
        senderIdLine: `Your BlueBubbles sender id: ${message.senderId}`,
        meta: { name: message.senderName },
        onCreated: () => {
          runtime.log?.(`[bluebubbles] pairing request sender=${message.senderId} created=true`);
          logVerbose(core, runtime, `bluebubbles pairing request sender=${message.senderId}`);
        },
        sendPairingReply: async (text) => {
          await sendMessageBlueBubbles(message.senderId, text, {
            cfg: config,
            accountId: account.accountId,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onReplyError: (err) => {
          logVerbose(
            core,
            runtime,
            `bluebubbles pairing reply failed for ${message.senderId}: ${String(err)}`,
          );
          runtime.error?.(
            `[bluebubbles] pairing reply failed sender=${message.senderId}: ${String(err)}`,
          );
        },
      });
      return;
    }

    logVerbose(
      core,
      runtime,
      `Blocked unauthorized BlueBubbles sender ${message.senderId} (dmPolicy=${dmPolicy})`,
    );
    logVerbose(
      core,
      runtime,
      `drop: dm sender not allowed sender=${message.senderId} allowFrom=${effectiveAllowFrom.join(",")}`,
    );
    return;
  }

  const chatId = message.chatId ?? undefined;
  const chatGuid = message.chatGuid ?? undefined;
  const chatIdentifier = message.chatIdentifier ?? undefined;
  const peerId = isGroup
    ? (chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group"))
    : message.senderId;

  const route = resolveBlueBubblesConversationRoute({
    cfg: config,
    accountId: account.accountId,
    isGroup,
    peerId,
    sender: message.senderId,
    chatId,
    chatGuid,
    chatIdentifier,
  });
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
  });

  // Mention gating for group chats (parity with iMessage/WhatsApp)
  const messageText = text;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const wasMentioned = isGroup
    ? core.channel.mentions.matchesMentionPatterns(messageText, mentionRegexes)
    : true;
  const canDetectMention = mentionRegexes.length > 0;
  const requireMention = core.channel.groups.resolveRequireMention({
    cfg: config,
    channel: "bluebubbles",
    groupId: peerId,
    accountId: account.accountId,
  });

  // Command gating (parity with iMessage/WhatsApp)
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const hasControlCmd = core.channel.text.hasControlCommand(messageText, config);
  const commandDmAllowFrom = isGroup ? configuredAllowFrom : effectiveAllowFrom;
  const ownerAllowedForCommands =
    commandDmAllowFrom.length > 0
      ? isAllowedBlueBubblesSender({
          allowFrom: commandDmAllowFrom,
          sender: message.senderId,
          chatId: message.chatId ?? undefined,
          chatGuid: message.chatGuid ?? undefined,
          chatIdentifier: message.chatIdentifier ?? undefined,
        })
      : false;
  const groupAllowedForCommands =
    effectiveGroupAllowFrom.length > 0
      ? isAllowedBlueBubblesSender({
          allowFrom: effectiveGroupAllowFrom,
          sender: message.senderId,
          chatId: message.chatId ?? undefined,
          chatGuid: message.chatGuid ?? undefined,
          chatIdentifier: message.chatIdentifier ?? undefined,
        })
      : false;
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      { configured: commandDmAllowFrom.length > 0, allowed: ownerAllowedForCommands },
      { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
    ],
    allowTextCommands: true,
    hasControlCommand: hasControlCmd,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  // Block control commands from unauthorized senders in groups
  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (msg) => logVerbose(core, runtime, msg),
      channel: "bluebubbles",
      reason: "control command (unauthorized)",
      target: message.senderId,
    });
    return;
  }

  // Allow control commands to bypass mention gating when authorized (parity with iMessage)
  const shouldBypassMention =
    isGroup && requireMention && !wasMentioned && commandAuthorized && hasControlCmd;
  const effectiveWasMentioned = wasMentioned || shouldBypassMention;

  // Skip group messages that require mention but weren't mentioned
  if (isGroup && requireMention && canDetectMention && !wasMentioned && !shouldBypassMention) {
    logVerbose(core, runtime, `bluebubbles: skipping group message (no mention)`);
    return;
  }

  if (isGroup && !message.participants?.length && baseUrl && password) {
    try {
      const fetchedParticipants = await fetchBlueBubblesParticipantsForInboundMessage({
        baseUrl,
        password,
        chatGuid: message.chatGuid,
        chatId: message.chatId,
        chatIdentifier: message.chatIdentifier,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
      });
      if (fetchedParticipants?.length) {
        message.participants = fetchedParticipants;
      }
    } catch (err) {
      logVerbose(
        core,
        runtime,
        `bluebubbles: participant fallback lookup failed chat=${peerId}: ${String(err)}`,
      );
    }
  }

  if (
    isGroup &&
    account.config.enrichGroupParticipantsFromContacts === true &&
    message.participants?.length
  ) {
    // BlueBubbles only gives us participant handles, so enrich phone numbers from local Contacts
    // after access, command, and mention gating have already allowed the message through.
    message.participants = await enrichBlueBubblesParticipantsWithContactNames(
      message.participants,
    );
  }

  // Cache allowed inbound messages so later replies can resolve sender/body without
  // surfacing dropped content (allowlist/mention/command gating).
  cacheInboundMessage();

  const maxBytes =
    account.config.mediaMaxMb && account.config.mediaMaxMb > 0
      ? account.config.mediaMaxMb * 1024 * 1024
      : 8 * 1024 * 1024;

  let mediaUrls: string[] = [];
  let mediaPaths: string[] = [];
  let mediaTypes: string[] = [];
  if (attachments.length > 0) {
    if (!baseUrl || !password) {
      logVerbose(core, runtime, "attachment download skipped (missing serverUrl/password)");
    } else {
      for (const attachment of attachments) {
        if (!attachment.guid) {
          continue;
        }
        if (attachment.totalBytes && attachment.totalBytes > maxBytes) {
          logVerbose(
            core,
            runtime,
            `attachment too large guid=${attachment.guid} bytes=${attachment.totalBytes}`,
          );
          continue;
        }
        try {
          const downloaded = await downloadBlueBubblesAttachment(attachment, {
            cfg: config,
            accountId: account.accountId,
            maxBytes,
          });
          const saved = await core.channel.media.saveMediaBuffer(
            Buffer.from(downloaded.buffer),
            downloaded.contentType,
            "inbound",
            maxBytes,
          );
          mediaPaths.push(saved.path);
          mediaUrls.push(saved.path);
          if (saved.contentType) {
            mediaTypes.push(saved.contentType);
          }
        } catch (err) {
          logVerbose(
            core,
            runtime,
            `attachment download failed guid=${attachment.guid} err=${String(err)}`,
          );
        }
      }
    }
  }
  let replyToId = message.replyToId;
  let replyToBody = message.replyToBody;
  let replyToSender = message.replyToSender;
  let replyToShortId: string | undefined;

  if (isTapbackMessage && tapbackContext?.replyToId) {
    replyToId = tapbackContext.replyToId;
  }

  if (replyToId) {
    const cached = resolveReplyContextFromCache({
      accountId: account.accountId,
      replyToId,
      chatGuid: message.chatGuid,
      chatIdentifier: message.chatIdentifier,
      chatId: message.chatId,
    });
    if (cached) {
      if (!replyToBody && cached.body) {
        replyToBody = cached.body;
      }
      if (!replyToSender && cached.senderLabel) {
        replyToSender = cached.senderLabel;
      }
      replyToShortId = cached.shortId;
      if (core.logging.shouldLogVerbose()) {
        const preview = (cached.body ?? "").replace(/\s+/g, " ").slice(0, 120);
        logVerbose(
          core,
          runtime,
          `reply-context cache hit replyToId=${replyToId} sender=${replyToSender ?? ""} body="${preview}"`,
        );
      }
    }
  }

  // If no cached short ID, try to get one from the UUID directly
  if (replyToId && !replyToShortId) {
    replyToShortId = getShortIdForUuid(replyToId);
  }
  const hasReplyContext = Boolean(replyToId || replyToBody || replyToSender);
  const replySenderAllowed =
    !isGroup || effectiveGroupAllowFrom.length === 0
      ? true
      : replyToSender
        ? isAllowedBlueBubblesSender({
            allowFrom: effectiveGroupAllowFrom,
            sender: replyToSender,
            chatId: message.chatId ?? undefined,
            chatGuid: message.chatGuid ?? undefined,
            chatIdentifier: message.chatIdentifier ?? undefined,
          })
        : false;
  const includeReplyContext =
    !hasReplyContext ||
    evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: "quote",
      senderAllowed: replySenderAllowed,
    }).include;
  if (hasReplyContext && !includeReplyContext && isGroup) {
    logVerbose(
      core,
      runtime,
      `bluebubbles: drop reply context (mode=${contextVisibilityMode}, sender_allowed=${replySenderAllowed ? "yes" : "no"})`,
    );
  }
  const visibleReplyToId = includeReplyContext ? replyToId : undefined;
  const visibleReplyToShortId = includeReplyContext ? replyToShortId : undefined;
  const visibleReplyToBody = includeReplyContext ? replyToBody : undefined;
  const visibleReplyToSender = includeReplyContext ? replyToSender : undefined;

  // Use inline [[reply_to:N]] tag format
  // For tapbacks/reactions: append at end (e.g., "reacted with ❤️ [[reply_to:4]]")
  // For regular replies: prepend at start (e.g., "[[reply_to:4]] Awesome")
  const replyTag = formatReplyTag({
    replyToId: visibleReplyToId,
    replyToShortId: visibleReplyToShortId,
  });
  const baseBody = replyTag
    ? isTapbackMessage
      ? `${rawBody} ${replyTag}`
      : `${replyTag} ${rawBody}`
    : rawBody;
  // Build fromLabel the same way as iMessage/Signal (formatInboundFromLabel):
  // group label + id for groups, sender for DMs.
  // The sender identity is included in the envelope body via formatInboundEnvelope.
  const senderLabel = message.senderName || `user:${message.senderId}`;
  const fromLabel = isGroup
    ? `${normalizeOptionalString(message.chatName) || "Group"} id:${peerId}`
    : senderLabel !== message.senderId
      ? `${senderLabel} id:${message.senderId}`
      : senderLabel;
  const groupSubject = isGroup ? normalizeOptionalString(message.chatName) : undefined;
  const groupMembers = isGroup
    ? formatGroupMembers({
        participants: message.participants,
        fallback: message.senderId ? { id: message.senderId, name: message.senderName } : undefined,
      })
    : undefined;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatInboundEnvelope({
    channel: "BlueBubbles",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: baseBody,
    chatType: isGroup ? "group" : "direct",
    sender: { name: message.senderName || undefined, id: message.senderId },
  });
  let chatGuidForActions = chatGuid;
  if (!chatGuidForActions && baseUrl && password) {
    const resolveTarget =
      isGroup && (chatId || chatIdentifier)
        ? chatId
          ? ({ kind: "chat_id", chatId } as const)
          : ({ kind: "chat_identifier", chatIdentifier: chatIdentifier ?? "" } as const)
        : ({ kind: "handle", address: message.senderId } as const);
    if (resolveTarget.kind !== "chat_identifier" || resolveTarget.chatIdentifier) {
      chatGuidForActions =
        (await resolveChatGuidForTarget({
          baseUrl,
          password,
          target: resolveTarget,
          allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
        })) ?? undefined;
    }
  }

  const ackReactionScope = config.messages?.ackReactionScope ?? "group-mentions";
  const removeAckAfterReply = config.messages?.removeAckAfterReply ?? false;
  const ackReactionValue = resolveBlueBubblesAckReaction({
    cfg: config,
    agentId: route.agentId,
    core,
    runtime,
  });
  const shouldAckReaction = () =>
    Boolean(
      ackReactionValue &&
      core.channel.reactions.shouldAckReaction({
        scope: ackReactionScope,
        isDirect: !isGroup,
        isGroup,
        isMentionableGroup: isGroup,
        requireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const ackMessageId = message.messageId?.trim() || "";
  const ackReactionPromise =
    shouldAckReaction() && ackMessageId && chatGuidForActions && ackReactionValue
      ? sendBlueBubblesReaction({
          chatGuid: chatGuidForActions,
          messageGuid: ackMessageId,
          emoji: ackReactionValue,
          opts: { cfg: config, accountId: account.accountId },
        }).then(
          () => true,
          (err) => {
            logVerbose(
              core,
              runtime,
              `ack reaction failed chatGuid=${chatGuidForActions} msg=${ackMessageId}: ${String(err)}`,
            );
            return false;
          },
        )
      : null;

  // Respect sendReadReceipts config (parity with WhatsApp)
  const sendReadReceipts = account.config.sendReadReceipts !== false;
  if (chatGuidForActions && baseUrl && password && sendReadReceipts) {
    try {
      await markBlueBubblesChatRead(chatGuidForActions, {
        cfg: config,
        accountId: account.accountId,
      });
      logVerbose(core, runtime, `marked read chatGuid=${chatGuidForActions}`);
    } catch (err) {
      runtime.error?.(`[bluebubbles] mark read failed: ${String(err)}`);
    }
  } else if (!sendReadReceipts) {
    logVerbose(core, runtime, "mark read skipped (sendReadReceipts=false)");
  } else {
    logVerbose(core, runtime, "mark read skipped (missing chatGuid or credentials)");
  }

  const outboundTarget = isGroup
    ? formatBlueBubblesChatTarget({
        chatId,
        chatGuid: chatGuidForActions ?? chatGuid,
        chatIdentifier,
      }) || peerId
    : chatGuidForActions
      ? formatBlueBubblesChatTarget({ chatGuid: chatGuidForActions })
      : message.senderId;

  const maybeEnqueueOutboundMessageId = (messageId?: string, snippet?: string): boolean => {
    const trimmed = messageId?.trim();
    if (!trimmed || trimmed === "ok" || trimmed === "unknown") {
      return false;
    }
    // Cache outbound message to get short ID
    const cacheEntry = rememberBlueBubblesReplyCache({
      accountId: account.accountId,
      messageId: trimmed,
      chatGuid: chatGuidForActions ?? chatGuid,
      chatIdentifier,
      chatId,
      senderLabel: "me",
      body: snippet ?? "",
      timestamp: Date.now(),
    });
    const displayId = cacheEntry.shortId || trimmed;
    const preview = snippet ? ` "${snippet.slice(0, 12)}${snippet.length > 12 ? "…" : ""}"` : "";
    core.system.enqueueSystemEvent(`Assistant sent${preview} [message_id:${displayId}]`, {
      sessionKey: route.sessionKey,
      contextKey: `bluebubbles:outbound:${outboundTarget}:${trimmed}`,
    });
    return true;
  };
  const sanitizeReplyDirectiveText = (value: string): string => {
    if (privateApiEnabled) {
      return value;
    }
    return value
      .replace(REPLY_DIRECTIVE_TAG_RE, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  };

  // History: in-memory rolling map with bounded API backfill retries
  const historyLimit = isGroup
    ? (account.config.historyLimit ?? 0)
    : (account.config.dmHistoryLimit ?? 0);

  const historyIdentifier =
    chatGuid ||
    chatIdentifier ||
    (chatId ? String(chatId) : null) ||
    (isGroup ? null : message.senderId) ||
    "";
  const historyKey = historyIdentifier
    ? buildAccountScopedHistoryKey(account.accountId, historyIdentifier)
    : "";

  // Record the current message into rolling history
  if (historyKey && historyLimit > 0) {
    const nowMs = Date.now();
    const senderLabel = message.fromMe ? "me" : message.senderName || message.senderId;
    const normalizedHistoryBody = truncateHistoryBody(text, MAX_STORED_HISTORY_ENTRY_CHARS);
    const currentEntries = recordPendingHistoryEntryIfEnabled({
      historyMap: chatHistories,
      limit: historyLimit,
      historyKey,
      entry: normalizedHistoryBody
        ? {
            sender: senderLabel,
            body: normalizedHistoryBody,
            timestamp: message.timestamp ?? nowMs,
            messageId: message.messageId ?? undefined,
          }
        : null,
    });
    pruneHistoryBackfillState();

    const backfillAttempt = planHistoryBackfillAttempt(historyKey, nowMs);
    if (backfillAttempt) {
      try {
        const backfillResult = await fetchBlueBubblesHistory(historyIdentifier, historyLimit, {
          cfg: config,
          accountId: account.accountId,
        });
        if (backfillResult.resolved) {
          markHistoryBackfillResolved(historyKey);
        }
        if (backfillResult.entries.length > 0) {
          const apiEntries: HistoryEntry[] = [];
          for (const entry of backfillResult.entries) {
            const body = truncateHistoryBody(entry.body, MAX_STORED_HISTORY_ENTRY_CHARS);
            if (!body) {
              continue;
            }
            apiEntries.push({
              sender: entry.sender,
              body,
              timestamp: entry.timestamp,
              messageId: entry.messageId,
            });
          }
          const merged = mergeHistoryEntries({
            apiEntries,
            currentEntries:
              currentEntries.length > 0 ? currentEntries : (chatHistories.get(historyKey) ?? []),
            limit: historyLimit,
          });
          if (chatHistories.has(historyKey)) {
            chatHistories.delete(historyKey);
          }
          chatHistories.set(historyKey, merged);
          evictOldHistoryKeys(chatHistories);
          logVerbose(
            core,
            runtime,
            `backfilled ${backfillResult.entries.length} history messages for ${isGroup ? "group" : "DM"}: ${historyIdentifier}`,
          );
        } else if (!backfillResult.resolved) {
          const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
          const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
          logVerbose(
            core,
            runtime,
            `history backfill unresolved for ${historyIdentifier}; retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs}`,
          );
        }
      } catch (err) {
        const remainingAttempts = HISTORY_BACKFILL_MAX_ATTEMPTS - backfillAttempt.attempts;
        const nextBackoffMs = Math.max(backfillAttempt.nextAttemptAt - nowMs, 0);
        logVerbose(
          core,
          runtime,
          `history backfill failed for ${historyIdentifier}: ${String(err)} (retries left=${Math.max(remainingAttempts, 0)} next_in_ms=${nextBackoffMs})`,
        );
      }
    }
  }

  // Build inbound history from the in-memory map
  let inboundHistory: Array<{ sender: string; body: string; timestamp?: number }> | undefined;
  if (historyKey && historyLimit > 0) {
    const entries = chatHistories.get(historyKey);
    if (entries && entries.length > 0) {
      inboundHistory = buildInboundHistorySnapshot({
        entries,
        limit: historyLimit,
      });
    }
  }
  const commandBody = messageText.trim();

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    MediaUrl: mediaUrls[0],
    MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaType: mediaTypes[0],
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    From: isGroup ? `group:${peerId}` : `bluebubbles:${message.senderId}`,
    To: `bluebubbles:${outboundTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    // Use short ID for token savings (agent can use this to reference the message)
    ReplyToId: visibleReplyToShortId || visibleReplyToId,
    ReplyToIdFull: visibleReplyToId,
    ReplyToBody: visibleReplyToBody,
    ReplyToSender: visibleReplyToSender,
    GroupSubject: groupSubject,
    GroupMembers: groupMembers,
    SenderName: message.senderName || undefined,
    SenderId: message.senderId,
    Provider: "bluebubbles",
    Surface: "bluebubbles",
    // Use short ID for token savings (agent can use this to reference the message)
    MessageSid: messageShortId || message.messageId,
    MessageSidFull: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: "bluebubbles",
    OriginatingTo: `bluebubbles:${outboundTarget}`,
    WasMentioned: effectiveWasMentioned,
    CommandAuthorized: commandAuthorized,
    // Exact group match wins over the "*" wildcard fallback, matching the
    // pattern used by resolveChannelGroupRequireMention/toolsPolicy.
    GroupSystemPrompt: isGroup
      ? normalizeOptionalString(
          account.config.groups?.[peerId]?.systemPrompt ??
            account.config.groups?.["*"]?.systemPrompt,
        )
      : undefined,
  });

  let sentMessage = false;
  let streamingActive = false;
  let typingRestartTimer: NodeJS.Timeout | undefined;
  const typingRestartDelayMs = 150;
  const clearTypingRestartTimer = () => {
    if (typingRestartTimer) {
      clearTimeout(typingRestartTimer);
      typingRestartTimer = undefined;
    }
  };
  const restartTypingSoon = () => {
    if (!streamingActive || !chatGuidForActions || !baseUrl || !password) {
      return;
    }
    clearTypingRestartTimer();
    typingRestartTimer = setTimeout(() => {
      typingRestartTimer = undefined;
      if (!streamingActive) {
        return;
      }
      sendBlueBubblesTyping(chatGuidForActions, true, {
        cfg: config,
        accountId: account.accountId,
      }).catch((err) => {
        runtime.error?.(`[bluebubbles] typing restart failed: ${String(err)}`);
      });
    }, typingRestartDelayMs);
  };
  try {
    const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
      cfg: config,
      agentId: route.agentId,
      channel: "bluebubbles",
      accountId: account.accountId,
      typingCallbacks: {
        onReplyStart: async () => {
          if (!chatGuidForActions) {
            return;
          }
          if (!baseUrl || !password) {
            return;
          }
          streamingActive = true;
          clearTypingRestartTimer();
          try {
            await sendBlueBubblesTyping(chatGuidForActions, true, {
              cfg: config,
              accountId: account.accountId,
            });
          } catch (err) {
            runtime.error?.(`[bluebubbles] typing start failed: ${String(err)}`);
          }
        },
        onIdle: () => {
          if (!chatGuidForActions) {
            return;
          }
          if (!baseUrl || !password) {
            return;
          }
          // Intentionally no-op for block streaming. We stop typing in finally
          // after the run completes to avoid flicker between paragraph blocks.
        },
      },
    });
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        ...replyPipeline,
        deliver: async (payload, info) => {
          const rawReplyToId =
            privateApiEnabled && typeof payload.replyToId === "string"
              ? payload.replyToId.trim()
              : "";
          // Resolve short ID (e.g., "5") to full UUID
          const replyToMessageGuid = rawReplyToId
            ? resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true })
            : "";
          const mediaList = resolveOutboundMediaUrls(payload);
          if (mediaList.length > 0) {
            const tableMode = core.channel.text.resolveMarkdownTableMode({
              cfg: config,
              channel: "bluebubbles",
              accountId: account.accountId,
            });
            const text = sanitizeReplyDirectiveText(
              core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
            );
            await sendMediaWithLeadingCaption({
              mediaUrls: mediaList,
              caption: text,
              send: async ({ mediaUrl, caption }) => {
                const cachedBody = (caption ?? "").trim() || "<media:attachment>";
                const pendingId = rememberPendingOutboundMessageId({
                  accountId: account.accountId,
                  sessionKey: route.sessionKey,
                  outboundTarget,
                  chatGuid: chatGuidForActions ?? chatGuid,
                  chatIdentifier,
                  chatId,
                  snippet: cachedBody,
                });
                let result: Awaited<ReturnType<typeof sendBlueBubblesMedia>>;
                try {
                  result = await sendBlueBubblesMedia({
                    cfg: config,
                    to: outboundTarget,
                    mediaUrl,
                    caption: caption ?? undefined,
                    replyToId: replyToMessageGuid || null,
                    accountId: account.accountId,
                  });
                } catch (err) {
                  forgetPendingOutboundMessageId(pendingId);
                  throw err;
                }
                if (maybeEnqueueOutboundMessageId(result.messageId, cachedBody)) {
                  forgetPendingOutboundMessageId(pendingId);
                }
                sentMessage = true;
                statusSink?.({ lastOutboundAt: Date.now() });
                if (info.kind === "block") {
                  restartTypingSoon();
                }
              },
            });
            return;
          }

          const textLimit =
            account.config.textChunkLimit && account.config.textChunkLimit > 0
              ? account.config.textChunkLimit
              : DEFAULT_TEXT_LIMIT;
          const chunkMode = account.config.chunkMode ?? "length";
          const tableMode = core.channel.text.resolveMarkdownTableMode({
            cfg: config,
            channel: "bluebubbles",
            accountId: account.accountId,
          });
          const text = sanitizeReplyDirectiveText(
            core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
          );
          const chunks =
            chunkMode === "newline"
              ? resolveTextChunksWithFallback(
                  text,
                  core.channel.text.chunkTextWithMode(text, textLimit, chunkMode),
                )
              : resolveTextChunksWithFallback(
                  text,
                  core.channel.text.chunkMarkdownText(text, textLimit),
                );
          if (!chunks.length) {
            return;
          }
          for (const chunk of chunks) {
            const pendingId = rememberPendingOutboundMessageId({
              accountId: account.accountId,
              sessionKey: route.sessionKey,
              outboundTarget,
              chatGuid: chatGuidForActions ?? chatGuid,
              chatIdentifier,
              chatId,
              snippet: chunk,
            });
            let result: Awaited<ReturnType<typeof sendMessageBlueBubbles>>;
            try {
              result = await sendMessageBlueBubbles(outboundTarget, chunk, {
                cfg: config,
                accountId: account.accountId,
                replyToMessageGuid: replyToMessageGuid || undefined,
              });
            } catch (err) {
              forgetPendingOutboundMessageId(pendingId);
              throw err;
            }
            if (maybeEnqueueOutboundMessageId(result.messageId, chunk)) {
              forgetPendingOutboundMessageId(pendingId);
            }
            sentMessage = true;
            statusSink?.({ lastOutboundAt: Date.now() });
            if (info.kind === "block") {
              restartTypingSoon();
            }
          }
        },
        onReplyStart: typingCallbacks?.onReplyStart,
        onIdle: typingCallbacks?.onIdle,
        onError: (err, info) => {
          // Flag the outer dedupe wrapper so it releases the claim instead
          // of committing. Without this, a transient BlueBubbles send failure
          // would permanently block replay-retry for 7 days and the user
          // would never receive a reply to that message.
          //
          // Only the terminal `final` delivery represents the user-visible
          // answer. The dispatcher continues past `tool` / `block` failures
          // and may still deliver `final` successfully — releasing the
          // dedupe claim for those would invite a replay that re-runs tool
          // side effects and resends partially-delivered content.
          if (info.kind === "final") {
            dedupeSignal.deliveryFailed = true;
          }
          runtime.error?.(`BlueBubbles ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyOptions: {
        onModelSelected,
        disableBlockStreaming:
          typeof account.config.blockStreaming === "boolean"
            ? !account.config.blockStreaming
            : undefined,
      },
    });
  } finally {
    const shouldStopTyping =
      Boolean(chatGuidForActions && baseUrl && password) && (streamingActive || !sentMessage);
    streamingActive = false;
    clearTypingRestartTimer();
    if (sentMessage && chatGuidForActions && ackMessageId) {
      core.channel.reactions.removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReactionValue ?? null,
        remove: () =>
          sendBlueBubblesReaction({
            chatGuid: chatGuidForActions,
            messageGuid: ackMessageId,
            emoji: ackReactionValue ?? "",
            remove: true,
            opts: { cfg: config, accountId: account.accountId },
          }),
        onError: (err) => {
          logAckFailure({
            log: (msg) => logVerbose(core, runtime, msg),
            channel: "bluebubbles",
            target: `${chatGuidForActions}/${ackMessageId}`,
            error: err,
          });
        },
      });
    }
    if (shouldStopTyping && chatGuidForActions) {
      // Stop typing after streaming completes to avoid a stuck indicator.
      sendBlueBubblesTyping(chatGuidForActions, false, {
        cfg: config,
        accountId: account.accountId,
      }).catch((err) => {
        logTypingFailure({
          log: (msg) => logVerbose(core, runtime, msg),
          channel: "bluebubbles",
          action: "stop",
          target: chatGuidForActions,
          error: err,
        });
      });
    }
  }
}

export async function processReaction(
  reaction: NormalizedWebhookReaction,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core } = target;
  const pairing = createChannelPairingController({
    core,
    channel: "bluebubbles",
    accountId: account.accountId,
  });
  if (reaction.fromMe) {
    return;
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "bluebubbles",
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup: reaction.isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowFrom) =>
      isAllowedBlueBubblesSender({
        allowFrom,
        sender: reaction.senderId,
        chatId: reaction.chatId ?? undefined,
        chatGuid: reaction.chatGuid ?? undefined,
        chatIdentifier: reaction.chatIdentifier ?? undefined,
      }),
  });
  if (accessDecision.decision !== "allow") {
    return;
  }

  const chatId = reaction.chatId ?? undefined;
  const chatGuid = reaction.chatGuid ?? undefined;
  const chatIdentifier = reaction.chatIdentifier ?? undefined;
  const peerId = reaction.isGroup
    ? (chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group"))
    : reaction.senderId;
  const requireMention =
    reaction.isGroup &&
    core.channel.groups.resolveRequireMention({
      cfg: config,
      channel: "bluebubbles",
      groupId: peerId,
      accountId: account.accountId,
    });

  if (requireMention) {
    logVerbose(core, runtime, "bluebubbles: skipping group reaction (requireMention=true)");
    return;
  }

  const route = resolveBlueBubblesConversationRoute({
    cfg: config,
    accountId: account.accountId,
    isGroup: reaction.isGroup,
    peerId,
    sender: reaction.senderId,
    chatId,
    chatGuid,
    chatIdentifier,
  });

  const senderLabel = reaction.senderName || reaction.senderId;
  const chatLabel = reaction.isGroup ? ` in group:${peerId}` : "";
  // Use short ID for token savings
  const messageDisplayId = getShortIdForUuid(reaction.messageId) || reaction.messageId;
  // Format: "Tyler reacted with ❤️ [[reply_to:5]]" or "Tyler removed ❤️ reaction [[reply_to:5]]"
  const text =
    reaction.action === "removed"
      ? `${senderLabel} removed ${reaction.emoji} reaction [[reply_to:${messageDisplayId}]]${chatLabel}`
      : `${senderLabel} reacted with ${reaction.emoji} [[reply_to:${messageDisplayId}]]${chatLabel}`;
  core.system.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `bluebubbles:reaction:${reaction.action}:${peerId}:${reaction.messageId}:${reaction.senderId}:${reaction.emoji}`,
  });
  logVerbose(core, runtime, `reaction event enqueued: ${text}`);
}
