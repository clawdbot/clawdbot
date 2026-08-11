/** Detects and logs long private finals when message-tool-only delivery was expected. */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { estimateStringChars } from "../../utils/cjk-chars.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { isSilentReplyText } from "../tokens.js";

const privateFinalReplyLogger = createSubsystemLogger("source-reply/private-final");

const LONG_PRIVATE_FINAL_MIN_CHARS = 280;
const MULTI_SENTENCE_PRIVATE_FINAL_MIN_CHARS = 120;
const MULTI_SENTENCE_TERMINATOR_MIN_COUNT = 2;
// CJK sentence marks do not require following whitespace; keep ASCII's boundary rule.
const SENTENCE_TERMINATOR_REGEX = /[.!?]+(?:\s|$)|[。！？．｡]+/gu;

type PrivateMessageToolFinalContext = {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
};

/** Returns whether a private final can represent an expected source reply that was not delivered. */
export function shouldClassifyPrivateMessageToolFinal(
  params: PrivateMessageToolFinalContext,
): boolean {
  return !(
    params.isHeartbeat ||
    params.isRoomEvent ||
    params.sourceReplyDeliveryMode !== "message_tool_only" ||
    params.sendPolicyDenied ||
    params.successfulSourceReplyDelivery
  );
}

/** Classifies private final text after message-tool-only source delivery settles. */
export function classifyPrivateMessageToolFinal(
  params: PrivateMessageToolFinalContext & {
    finalText: string;
  },
): "none" | "short" | "substantive" {
  if (!shouldClassifyPrivateMessageToolFinal(params)) {
    return "none";
  }
  const trimmed = params.finalText.trim();
  if (!trimmed || isSilentReplyText(trimmed)) {
    return "none";
  }
  // Both thresholds are substance proxies, so they must use the shared CJK-aware estimate.
  const estimatedChars = estimateStringChars(trimmed);
  const substantive =
    estimatedChars >= LONG_PRIVATE_FINAL_MIN_CHARS ||
    (estimatedChars >= MULTI_SENTENCE_PRIVATE_FINAL_MIN_CHARS &&
      countSentenceLikeTerminators(trimmed) >= MULTI_SENTENCE_TERMINATOR_MIN_COUNT);
  return substantive ? "substantive" : "short";
}

/**
 * Emit metadata-only operator signal. The body is intentionally omitted:
 * `message_tool_only` keeps normal final text private by design.
 */
export function warnPrivateMessageToolFinal(params: {
  sessionKey: string | undefined;
  channel: string | undefined;
  finalTextLength: number;
}): void {
  privateFinalReplyLogger.warn(
    "agent produced a long private final reply without calling the configured delivery tool (message_tool_only); response kept private and not delivered to the source channel",
    {
      sessionKey: params.sessionKey,
      channel: params.channel,
      chars: params.finalTextLength,
    },
  );
}

function countSentenceLikeTerminators(text: string): number {
  return Array.from(text.matchAll(SENTENCE_TERMINATOR_REGEX)).length;
}
