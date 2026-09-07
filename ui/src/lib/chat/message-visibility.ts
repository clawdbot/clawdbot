import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import type { MessageGroup, NormalizedMessage } from "./chat-types.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";
import { extractText, extractTextCached, isEmptyUserTextOnlyMessage } from "./message-extract.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";

// Media and unknown blocks are visible outcomes; tool and thinking blocks are
// activity. Classifying prepared content keeps replies out of work rollups.
export function resolveMessageVisibleContent(
  message: unknown,
  normalized: NormalizedMessage,
): MessageGroup["visibleContent"] {
  let hasText = false;
  for (const block of normalized.content) {
    if (block.type === "text") {
      hasText ||= Boolean(block.text?.trim());
    } else if (
      block.type !== "thinking" &&
      !isToolCallContentType(block.type) &&
      !isToolResultContentType(block.type)
    ) {
      return "non-text";
    }
  }
  return hasText || extractTextCached(message)?.trim() ? "text" : "none";
}

export function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}

/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  const entry = asNullableRecord(message);
  if (!entry) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  const entry = asNullableRecord(message);
  if (!entry) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "toolresult") {
    return false;
  }
  const text = extractText(message);
  return typeof text === "string" && text.trim() === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

function isHeartbeatAckStream(text: string): boolean {
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}

export function isHiddenAssistantStreamText(text: string): boolean {
  return isSilentReplyStream(text) || isHeartbeatAckStream(text);
}

export function shouldHideAssistantChatMessage(message: unknown): boolean {
  return isAssistantSilentReply(message) || isAssistantHeartbeatAckForDisplay(message);
}

export function isVisibleChatHistoryMessage(message: unknown): boolean {
  return !(
    shouldHideAssistantChatMessage(message) ||
    isSyntheticTranscriptRepairToolResult(message) ||
    isEmptyUserTextOnlyMessage(message)
  );
}

export function visibleChatHistoryMessages(messages: unknown): unknown[] {
  return Array.isArray(messages) ? messages.filter(isVisibleChatHistoryMessage) : [];
}
