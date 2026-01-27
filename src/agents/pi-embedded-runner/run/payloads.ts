import type { AssistantMessage } from "@mariozechner/pi-ai";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { formatToolAggregate } from "../../../auto-reply/tool-meta.js";
import type { MoltbotConfig } from "../../../config/config.js";
import {
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
  normalizeTextForComparison,
} from "../../pi-embedded-helpers.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMessage,
} from "../../pi-embedded-utils.js";
import type { ToolResultFormat } from "../../pi-embedded-subscribe.js";

type ToolMetaEntry = { toolName: string; meta?: string };

export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  toolMetas: ToolMetaEntry[];
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: { toolName: string; meta?: string; error?: string };
  config?: MoltbotConfig;
  sessionKey: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  inlineToolResultsAllowed: boolean;
}): Array<{
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
}> {
  const replyItems: Array<{
    text: string;
    media?: string[];
    isError?: boolean;
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }> = [];

  const useMarkdown = params.toolResultFormat === "markdown";
  const lastAssistantErrored = params.lastAssistant?.stopReason === "error";
  const errorText = params.lastAssistant
    ? formatAssistantErrorText(params.lastAssistant, {
        cfg: params.config,
        sessionKey: params.sessionKey,
      })
    : undefined;
  const rawErrorMessage = lastAssistantErrored
    ? params.lastAssistant?.errorMessage?.trim() || undefined
    : undefined;
  const rawErrorFingerprint = rawErrorMessage
    ? getApiErrorPayloadFingerprint(rawErrorMessage)
    : null;
  const formattedRawErrorMessage = rawErrorMessage
    ? formatRawAssistantErrorForUi(rawErrorMessage)
    : null;
  const normalizedFormattedRawErrorMessage = formattedRawErrorMessage
    ? normalizeTextForComparison(formattedRawErrorMessage)
    : null;
  const normalizedRawErrorText = rawErrorMessage
    ? normalizeTextForComparison(rawErrorMessage)
    : null;
  const normalizedErrorText = errorText ? normalizeTextForComparison(errorText) : null;
  const genericErrorText = "The AI service returned an error. Please try again.";
  if (errorText) replyItems.push({ text: errorText, isError: true });

  const inlineToolResults =
    params.inlineToolResultsAllowed && params.verboseLevel !== "off" && params.toolMetas.length > 0;
  if (inlineToolResults) {
    for (const { toolName, meta } of params.toolMetas) {
      const agg = formatToolAggregate(toolName, meta ? [meta] : [], {
        markdown: useMarkdown,
      });
      const {
        text: cleanedText,
        mediaUrls,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      } = parseReplyDirectives(agg);
      if (cleanedText) {
        replyItems.push({
          text: cleanedText,
          media: mediaUrls,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        });
      }
    }
  }

  const reasoningText =
    params.lastAssistant && params.reasoningLevel === "on"
      ? formatReasoningMessage(extractAssistantThinking(params.lastAssistant))
      : "";
  if (reasoningText) replyItems.push({ text: reasoningText });

  const fallbackAnswerText = params.lastAssistant ? extractAssistantText(params.lastAssistant) : "";
  const shouldSuppressRawErrorText = (text: string) => {
    if (!lastAssistantErrored) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (errorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalizedErrorText && normalized === normalizedErrorText) return true;
      if (trimmed === genericErrorText) return true;
    }
    if (rawErrorMessage && trimmed === rawErrorMessage) return true;
    if (formattedRawErrorMessage && trimmed === formattedRawErrorMessage) return true;
    if (normalizedRawErrorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedRawErrorText) return true;
    }
    if (normalizedFormattedRawErrorMessage) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedFormattedRawErrorMessage) return true;
    }
    if (rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === rawErrorFingerprint) return true;
    }
    return isRawApiErrorPayload(trimmed);
  };
  const answerTexts = (
    params.assistantTexts.length
      ? params.assistantTexts
      : fallbackAnswerText
        ? [fallbackAnswerText]
        : []
  ).filter((text) => !shouldSuppressRawErrorText(text));

  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = parseReplyDirectives(text);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      continue;
    }
    replyItems.push({
      text: cleanedText,
      media: mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    });
  }

  if (params.lastToolError) {
    const lastAssistantHasToolCalls =
      Array.isArray(params.lastAssistant?.content) &&
      params.lastAssistant?.content.some((block) =>
        block && typeof block === "object"
          ? (block as { type?: unknown }).type === "toolCall"
          : false,
      );
    const lastAssistantWasToolUse = params.lastAssistant?.stopReason === "toolUse";
    const hasUserFacingReply =
      replyItems.length > 0 && !lastAssistantHasToolCalls && !lastAssistantWasToolUse;
    // Check if this is a recoverable/internal tool error that shouldn't be shown to users
    // when there's already a user-facing reply (the model should have retried).
    const errorLower = (params.lastToolError.error ?? "").toLowerCase();
    const isRecoverableError =
      errorLower.includes("required") ||
      errorLower.includes("missing") ||
      errorLower.includes("invalid") ||
      errorLower.includes("must be") ||
      errorLower.includes("must have") ||
      errorLower.includes("needs") ||
      errorLower.includes("requires");

    // Show tool errors only when:
    // 1. There's no user-facing reply AND the error is not recoverable
    // Recoverable errors (validation, missing params) are already in the model's context
    // and shouldn't be surfaced to users since the model should retry.
    if (!hasUserFacingReply && !isRecoverableError) {
      const toolSummary = formatToolAggregate(
        params.lastToolError.toolName,
        params.lastToolError.meta ? [params.lastToolError.meta] : undefined,
        { markdown: useMarkdown },
      );
      const errorSuffix = params.lastToolError.error ? `: ${params.lastToolError.error}` : "";
      replyItems.push({
        text: `⚠️ ${toolSummary} failed${errorSuffix}`,
        isError: true,
      });
    }
  }

  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => ({
      text: item.text?.trim() ? item.text.trim() : undefined,
      mediaUrls: item.media?.length ? item.media : undefined,
      mediaUrl: item.media?.[0],
      isError: item.isError,
      replyToId: item.replyToId,
      replyToTag: item.replyToTag,
      replyToCurrent: item.replyToCurrent,
      audioAsVoice: item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length),
    }))
    .filter((p) => {
      if (!p.text && !p.mediaUrl && (!p.mediaUrls || p.mediaUrls.length === 0)) return false;
      if (p.text && isSilentReplyText(p.text, SILENT_REPLY_TOKEN)) return false;
      return true;
    });
}
