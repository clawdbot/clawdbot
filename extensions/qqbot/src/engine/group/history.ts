/** Group-message content and attachment formatting helpers. */

import type { RefAttachmentSummary } from "../ref/types.js";
import { formatAttachmentTags } from "../utils/attachment-tags.js";
import { parseFaceTags } from "../utils/text-parsing.js";
import { stripMentionText, type RawMention } from "./mention.js";

// Re-export so existing `from "group/history.js"` imports keep working.
export { formatAttachmentTags } from "../utils/attachment-tags.js";

// ───────────────────────────── Constants ─────────────────────────────

/** Tags wrapping merged sub-messages from the queue. */
const MERGED_CTX_START = "[Merged earlier messages — CONTEXT ONLY]";
const MERGED_CTX_END = "[CURRENT MESSAGE — reply using the context above]";

// ───────────────────────────── Types ─────────────────────────────

/**
 * Attachment descriptor used inside history entries.
 *
 * Aligned with `RefAttachmentSummary` so the three places that describe
 * attachments (group history cache, ref-index store, and the dynamic
 * context block on the current message) all share a single shape.
 */
type AttachmentSummary = RefAttachmentSummary;

/** Raw attachment fields carried in a QQ event (the union we actually read). */
interface RawAttachment {
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
interface FormatMessageContentParams {
  content: string;
  /** Message channel — `stripMentionText` only fires for `"group"`. */
  chatType?: string;
  mentions?: RawMention[];
  attachments?: RawAttachment[];
}

// ───────────────────────────── Content formatting ─────────────────────────────

/** Map a raw QQ content-type string onto the normalized attachment type. */
function inferAttachmentType(contentType?: string): AttachmentSummary["type"] {
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

// ───────────────────────────── Public API ─────────────────────────────

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
