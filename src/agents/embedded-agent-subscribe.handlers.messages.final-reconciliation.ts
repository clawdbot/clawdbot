import type { ReplyDirectiveParseResult } from "../auto-reply/reply/reply-directives.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import { hasAssistantVisibleReply } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { stripContinuationSignalFromDisplayText } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";

export function resolveFinalReplyReconciliation(params: {
  state: EmbeddedAgentSubscribeState;
  finalAssistantText: string;
  mediaUrls: string[];
  parsedText: ReplyDirectiveParseResult;
}) {
  const deliveredBlockReplyTexts = params.state.deliveredBlockReplyTexts.filter(Boolean);
  const attemptedBlockReplyTexts = (params.state.attemptedBlockReplyTexts ?? []).filter(Boolean);
  const effectiveDeliveredBlockReplyTexts =
    attemptedBlockReplyTexts.length > 0
      ? attemptedBlockReplyTexts
      : deliveredBlockReplyTexts.length > 0
        ? deliveredBlockReplyTexts
        : params.state.deferredBlockReplyTexts;
  const deliveredCanonicalPrefix = (() => {
    if (!params.finalAssistantText || effectiveDeliveredBlockReplyTexts.length === 0) {
      return undefined;
    }
    let cursor = 0;
    for (const deliveredText of effectiveDeliveredBlockReplyTexts) {
      const matchIndex = params.finalAssistantText.indexOf(deliveredText, cursor);
      if (matchIndex < 0 || params.finalAssistantText.slice(cursor, matchIndex).trim().length > 0) {
        return undefined;
      }
      cursor = matchIndex + deliveredText.length;
    }
    return params.finalAssistantText.slice(0, cursor);
  })();
  const deliveredCanonicalSuffix = (() => {
    if (!params.finalAssistantText || effectiveDeliveredBlockReplyTexts.length === 0) {
      return undefined;
    }
    for (let start = 0; start < effectiveDeliveredBlockReplyTexts.length; start += 1) {
      const suffix = effectiveDeliveredBlockReplyTexts.slice(start).join(" ");
      if (params.finalAssistantText.startsWith(suffix)) {
        return suffix;
      }
      if (
        normalizeTextForComparison(suffix) === normalizeTextForComparison(params.finalAssistantText)
      ) {
        return params.finalAssistantText;
      }
    }
    return undefined;
  })();
  const textEndDeliveredText =
    deliveredCanonicalPrefix ??
    deliveredCanonicalSuffix ??
    (effectiveDeliveredBlockReplyTexts.join("\n") || undefined);
  const usedDeliveredCanonicalSuffix =
    deliveredCanonicalPrefix == null && deliveredCanonicalSuffix != null;
  const textEndDeliveredVisibleText =
    textEndDeliveredText == null
      ? undefined
      : stripContinuationSignalFromDisplayText(textEndDeliveredText);
  const normalizeTerminalComparison = (value: string) =>
    normalizeTextForComparison(value).replace(/[.!?]+$/u, "");
  const finalTextMatchesDelivered =
    textEndDeliveredVisibleText != null &&
    (normalizeTextForComparison(params.finalAssistantText) ===
      normalizeTextForComparison(textEndDeliveredVisibleText) ||
      normalizeTerminalComparison(params.finalAssistantText) ===
        normalizeTerminalComparison(textEndDeliveredVisibleText));
  const finalTextCorrection = finalTextMatchesDelivered
    ? ""
    : textEndDeliveredVisibleText &&
        params.finalAssistantText.startsWith(textEndDeliveredVisibleText)
      ? params.finalAssistantText.slice(textEndDeliveredVisibleText.length)
      : params.finalAssistantText !== textEndDeliveredVisibleText
        ? params.finalAssistantText
        : "";
  const deliveredReplyDirectives = params.state.lastDeliveredAssistantReplyDirectives;
  const deferredReplyDirectives = params.state.deferredAssistantReplyDirectives;
  const undeliveredMediaUrls = params.mediaUrls.filter(
    (url) =>
      !deliveredReplyDirectives?.mediaUrls?.includes(url) &&
      !deferredReplyDirectives?.mediaUrls?.includes(url),
  );
  const undeliveredAudioAsVoice = Boolean(
    params.parsedText.audioAsVoice &&
    !deliveredReplyDirectives?.audioAsVoice &&
    !deferredReplyDirectives?.audioAsVoice,
  );
  const hasUndeliveredReplyToId = Boolean(
    params.parsedText.replyToId &&
    params.parsedText.replyToId !== deliveredReplyDirectives?.replyToId &&
    params.parsedText.replyToId !== deferredReplyDirectives?.replyToId,
  );
  const hasUndeliveredReplyToTag =
    params.parsedText.replyToTag &&
    !deliveredReplyDirectives?.replyToTag &&
    !deferredReplyDirectives?.replyToTag;
  const hasUndeliveredReplyToCurrent = Boolean(
    params.parsedText.replyToCurrent &&
    !deliveredReplyDirectives?.replyToCurrent &&
    !deferredReplyDirectives?.replyToCurrent,
  );
  const hasReplyTarget =
    hasUndeliveredReplyToId || hasUndeliveredReplyToTag || hasUndeliveredReplyToCurrent;
  const finalDirectives = {
    result: {
      ...params.parsedText,
      mediaUrls: undeliveredMediaUrls.length ? undeliveredMediaUrls : undefined,
      audioAsVoice: undeliveredAudioAsVoice || undefined,
      replyToId: hasUndeliveredReplyToId ? params.parsedText.replyToId : undefined,
      replyToTag: hasUndeliveredReplyToTag,
      replyToCurrent: hasUndeliveredReplyToCurrent || undefined,
    },
    mediaUrls: undeliveredMediaUrls,
    audioAsVoice: undeliveredAudioAsVoice,
    hasReplyTarget,
    hasMetadata: undeliveredMediaUrls.length > 0 || undeliveredAudioAsVoice || hasReplyTarget,
  };
  return {
    finalDirectives,
    finalTextCorrection,
    hasFinalAssistantReply: hasAssistantVisibleReply({
      text: params.finalAssistantText,
      mediaUrls: params.mediaUrls,
      audioAsVoice: params.parsedText.audioAsVoice,
    }),
    textEndDeliveredText,
    textEndDeliveredVisibleText,
    usedDeliveredCanonicalSuffix,
  };
}
