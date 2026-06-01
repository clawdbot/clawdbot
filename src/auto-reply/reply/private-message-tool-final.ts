import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { isSilentReplyText } from "../tokens.js";

const privateFinalReplyLogger = createSubsystemLogger("source-reply/private-final");

const LONG_PRIVATE_FINAL_MIN_CHARS = 280;
const MULTI_SENTENCE_PRIVATE_FINAL_MIN_CHARS = 120;
const MULTI_SENTENCE_TERMINATOR_MIN_COUNT = 2;
const SENTENCE_TERMINATOR_REGEX = /[.!?]+(?:\s|$)/g;

/**
 * `message_tool_only` allows the model to stay silent by simply not calling the
 * message tool, so short private final text is not evidence of message loss.
 * Warn only for unusually substantive private finals, which usually means the
 * model wrote a user-facing answer but missed the configured delivery tool.
 */
export function shouldWarnAboutPrivateMessageToolFinal(params: {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  finalText: string;
}): boolean {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return false;
  }
  // A send-policy denial is an intentional block, and a successful source-reply
  // delivery means the contract was honored. Other side effects do not count.
  if (params.sendPolicyDenied || params.successfulSourceReplyDelivery) {
    return false;
  }
  const trimmed = params.finalText.trim();
  if (!trimmed || isSilentReplyText(trimmed)) {
    return false;
  }
  if (trimmed.length >= LONG_PRIVATE_FINAL_MIN_CHARS) {
    return true;
  }
  const sentenceTerminatorCount = countSentenceLikeTerminators(trimmed);
  return (
    trimmed.length >= MULTI_SENTENCE_PRIVATE_FINAL_MIN_CHARS &&
    sentenceTerminatorCount >= MULTI_SENTENCE_TERMINATOR_MIN_COUNT
  );
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
