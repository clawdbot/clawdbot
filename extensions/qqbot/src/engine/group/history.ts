/**
 * Group history cache — buffer non-@ messages and inject them as context
 * the next time the bot is @-ed in the same group.
 *
 * Lifecycle (per group):
 *   1. `recordPendingHistoryEntry` — called for every non-@ message that
 *      should be remembered (the gate returns `skip_no_mention` /
 *      `drop_other_mention`).
 *   2. `buildPendingHistoryContext` — called when the bot IS @-ed; wraps
 *      the cached entries in context tags and prepends them to the
 *      current user message.
 *   3. `clearPendingHistory` — called after the reply has been attempted
 *      (success, timeout, or error) so the next @ starts fresh.
 *
 * The cache itself is a simple `Map<groupOpenid, HistoryEntry[]>` with an
 * LRU eviction policy both on the number of keys and on the per-key
 * length. No I/O, no external dependencies — the module is pure and
 * portable between the built-in and standalone plugin builds.
 */

import type { RefAttachmentSummary } from "../ref/types.js";
import { formatAttachmentTags } from "../utils/attachment-tags.js";
import { parseFaceTags } from "../utils/text-parsing.js";
import { stripMentionText, type RawMention } from "./mention.js";

// Re-export so existing `from "group/history.js"` imports keep working.
export { formatAttachmentTags } from "../utils/attachment-tags.js";

// ───────────────────────────── Constants ─────────────────────────────

/**
 * Tags wrapping history injected on the bot's current turn.
 *
 * Kept in English so downstream LLMs (which are multilingual but follow
 * instructions more reliably in English) parse the block structure
 * unambiguously, regardless of the user/bot conversation language.
 */
const HISTORY_CTX_START = "[Chat messages since your last reply — CONTEXT ONLY]";
const HISTORY_CTX_END = "[CURRENT MESSAGE — reply to this]";

/** Tags wrapping merged sub-messages from the queue. */
const MERGED_CTX_START = "[Merged earlier messages — CONTEXT ONLY]";
const MERGED_CTX_END = "[CURRENT MESSAGE — reply using the context above]";

/**
 * Upper bound on the number of concurrent group histories the cache will
 * retain. Prevents the Map from growing without bound in long-running
 * multi-group deployments. LRU-evict the least-recently-touched key once
 * this limit is exceeded.
 */
const MAX_HISTORY_KEYS = 1000;

// ───────────────────────────── Types ─────────────────────────────

/**
 * Attachment descriptor used inside history entries.
 *
 * Aligned with `RefAttachmentSummary` so the three places that describe
 * attachments (group history cache, ref-index store, and the dynamic
 * context block on the current message) all share a single shape.
 */
export type AttachmentSummary = RefAttachmentSummary;

/** Raw attachment fields carried in a QQ event (the union we actually read). */
export interface RawAttachment {
  content_type: string;
  filename?: string;
  /** Pre-computed ASR transcription text provided by QQ's gateway. */
  asr_refer_text?: string;
  url?: string;
}

/** One cached history entry. */
export interface HistoryEntry {
  /** Display label for the sender (e.g. "Nick (OPENID)"). */
  sender: string;
  /** Message body already stripped / formatted for the AI. */
  body: string;
  timestamp?: number;
  messageId?: string;
  /** Rich-media attachments to render inline on @-activation. */
  attachments?: AttachmentSummary[];
}

/** Parameters for {@link formatMessageContent}. */
export interface FormatMessageContentParams {
  content: string;
  /** Message channel — `stripMentionText` only fires for `"group"`. */
  chatType?: string;
  mentions?: RawMention[];
  attachments?: RawAttachment[];
}

// ───────────────────────────── Content formatting ─────────────────────────────

/** Map a raw QQ content-type string onto the normalized attachment type. */
export function inferAttachmentType(contentType?: string): AttachmentSummary["type"] {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) {
    return "image";
  }
  if (ct === "voice" || ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr")) {
    return "voice";
  }
  if (ct.startsWith("video/")) {
    return "video";
  }
  if (ct.startsWith("application/") || ct.startsWith("text/")) {
    return "file";
  }
  return "unknown";
}

/**
 * Convert raw QQ-event attachments into `AttachmentSummary` entries.
 *
 * When `localPaths` is provided (from `ProcessedAttachments.attachmentLocalPaths`),
 * each summary is enriched with the local file path so that history context
 * renders the downloaded path instead of the ephemeral QQ CDN URL.
 *
 * Returns `undefined` (rather than `[]`) when no attachments are provided
 * so that callers can omit the field from their result objects.
 */
export function toAttachmentSummaries(
  attachments?: RawAttachment[],
  localPaths?: Array<string | null>,
): AttachmentSummary[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  return attachments.map(
    (att, i): AttachmentSummary => ({
      type: inferAttachmentType(att.content_type),
      filename: att.filename,
      transcript: att.asr_refer_text || undefined,
      localPath: localPaths?.[i] || undefined,
      url: att.url || undefined,
    }),
  );
}

/**
 * Format one sub-message: emoji parsing → mention cleanup → attachment tags.
 *
 * Used for the merged-message path where several queued messages are
 * rendered together. `parseFaceTags` and `stripMentionText` are imported
 * directly — both are pure utilities inside the same engine and do not
 * warrant DI overhead.
 */
export function formatMessageContent(params: FormatMessageContentParams): string {
  let msgContent = parseFaceTags(params.content);

  if (params.chatType === "group" && params.mentions?.length) {
    msgContent = stripMentionText(msgContent, params.mentions);
  }

  if (params.attachments?.length) {
    const attachmentDesc = formatAttachmentTags(toAttachmentSummaries(params.attachments));
    if (attachmentDesc) {
      msgContent = `${msgContent} ${attachmentDesc}`;
    }
  }

  return msgContent;
}

// ───────────────────────────── Attachment tags ─────────────────────────────
//
// `formatAttachmentTags` lives in `utils/attachment-tags.ts` (the single
// source of truth shared with the ref-index renderer). It is re-exported
// from the top of this file so existing `from "group/history.js"` imports
// continue to work.

// ───────────────────────────── Internal LRU helpers ─────────────────────────────

/**
 * LRU-evict the least-recently-inserted keys so the map never exceeds
 * `maxKeys`. Since `Map` iteration order is insertion order, removing
 * from the front gives us an LRU by insertion point.
 */
function evictOldHistoryKeys<T>(
  historyMap: Map<string, T[]>,
  maxKeys: number = MAX_HISTORY_KEYS,
): void {
  if (historyMap.size <= maxKeys) {
    return;
  }
  const keysToDelete = historyMap.size - maxKeys;
  const iterator = historyMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key !== undefined) {
      historyMap.delete(key);
    }
  }
}

/**
 * Append one entry to a group's history. When the group's buffer exceeds
 * `limit`, the oldest entry is shifted off the front. The group's key is
 * re-inserted into the map so its LRU position is refreshed.
 */
function appendHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  entry: HistoryEntry;
  limit: number;
}): HistoryEntry[] {
  const { historyMap, historyKey, entry, limit } = params;
  if (limit <= 0) {
    return [];
  }

  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  while (history.length > limit) {
    history.shift();
  }
  // Refresh insertion order so this key becomes the most recent.
  if (historyMap.has(historyKey)) {
    historyMap.delete(historyKey);
  }
  historyMap.set(historyKey, history);
  evictOldHistoryKeys(historyMap);
  return history;
}

// ───────────────────────────── Public API ─────────────────────────────

/**
 * Record a non-@ message so it can be replayed on the next @-activation.
 *
 * No-op when `limit <= 0` (history disabled) or when `entry` is missing.
 * Returns the updated history list for the group.
 */
export function recordPendingHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  entry?: HistoryEntry | null;
  limit: number;
}): HistoryEntry[] {
  if (!params.entry || params.limit <= 0) {
    return [];
  }
  return appendHistoryEntry({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    entry: params.entry,
    limit: params.limit,
  });
}

/**
 * Build the full user-message string when the bot is @-ed, prefixing the
 * buffered non-@ chatter for context.
 *
 * Returns `currentMessage` unchanged when no history exists, when the
 * limit is zero, or when the buffer is empty.
 */
export function buildPendingHistoryContext(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string {
  if (params.limit <= 0) {
    return params.currentMessage;
  }

  const entries = params.historyMap.get(params.historyKey) ?? [];
  if (entries.length === 0) {
    return params.currentMessage;
  }

  const lineBreak = params.lineBreak ?? "\n";
  const historyText = entries.map(params.formatEntry).join(lineBreak);

  return [HISTORY_CTX_START, historyText, "", HISTORY_CTX_END, params.currentMessage].join(
    lineBreak,
  );
}

/**
 * Wrap a batch of merged messages with begin/end tags and append the
 * current user turn at the bottom.
 *
 * When `precedingParts` is empty, `currentMessage` is returned unchanged.
 */
export function buildMergedMessageContext(params: {
  precedingParts: string[];
  currentMessage: string;
  lineBreak?: string;
}): string {
  const { precedingParts, currentMessage } = params;
  if (precedingParts.length === 0) {
    return currentMessage;
  }

  const lineBreak = params.lineBreak ?? "\n";
  return [MERGED_CTX_START, precedingParts.join(lineBreak), MERGED_CTX_END, currentMessage].join(
    lineBreak,
  );
}

/**
 * Clear a group's pending history after a reply has been attempted.
 *
 * No-op when the feature is disabled (`limit <= 0`).
 */
export function clearPendingHistory(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void {
  if (params.limit <= 0) {
    return;
  }
  params.historyMap.set(params.historyKey, []);
}
