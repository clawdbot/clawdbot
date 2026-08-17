/**
 * Builds embedded-agent payload objects from attempt inputs and outcomes.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  createHeartbeatToolResponsePayload,
  getHeartbeatToolNotificationText,
  type HeartbeatToolResponse,
} from "../../../auto-reply/heartbeat-tool-response.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPayloadText,
  SILENT_REPLY_TOKEN,
} from "../../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasReplyPayloadContent } from "../../../interactive/payload.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  extractAssistantTextForPhase,
  parseAssistantTextSignature,
} from "../../../shared/chat-message-content.js";
import {
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
} from "../../../shared/text/assistant-visible-text.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  formatUserFacingAssistantErrorText,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
  normalizeTextForComparison,
} from "../../embedded-agent-helpers.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { ToolResultFormat } from "../../embedded-agent-subscribe.shared-types.js";
import {
  extractAssistantThinking,
  extractAssistantVisibleText,
  sanitizeAssistantVisibleStreamText,
} from "../../embedded-agent-utils.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import { buildSourceReplyPayloadState } from "./source-reply-payloads.js";
import { buildFailureWarning } from "./tool-error-warning.js";
import { hasExplicitMutatingToolFailureAcknowledgement } from "./tool-failure-acknowledgement.js";

function isAssistantTextContentBlockType(value: unknown): boolean {
  return value === "text" || value === "input_text" || value === "output_text";
}
function resolveRawAssistantAnswerText(lastAssistant: AssistantMessage | undefined): string {
  if (!lastAssistant) {
    return "";
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, {
    phase: "final_answer",
    sanitizeText: sanitizeAssistantFinalAnswerText,
  });
  if (finalAnswerText) {
    return normalizeOptionalString(finalAnswerText) ?? "";
  }
  if (Array.isArray(lastAssistant.content)) {
    const hasExplicitPhasedTextBlock = lastAssistant.content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const record = block as { type?: unknown; textSignature?: unknown };
      return (
        isAssistantTextContentBlockType(record.type) &&
        Boolean(parseAssistantTextSignature(record)?.phase)
      );
    });
    if (!hasExplicitPhasedTextBlock) {
      const signedUnphasedParts = lastAssistant.content
        .map((block) => {
          if (!block || typeof block !== "object") {
            return null;
          }
          const record = block as { type?: unknown; text?: unknown; textSignature?: unknown };
          const signature = parseAssistantTextSignature(record);
          if (
            !isAssistantTextContentBlockType(record.type) ||
            typeof record.text !== "string" ||
            !signature?.id ||
            signature.phase
          ) {
            return null;
          }
          const text = sanitizeAssistantFinalAnswerText(record.text);
          return text.trim() ? text : null;
        })
        .filter((value): value is string => typeof value === "string");
      if (signedUnphasedParts.length) {
        return normalizeOptionalString(signedUnphasedParts.join("\n")) ?? "";
      }
    }
  }
  return (
    normalizeOptionalString(
      extractAssistantTextForPhase(lastAssistant, {
        sanitizeText: sanitizeAssistantVisibleText,
      }),
    ) ?? ""
  );
}

function normalizeReplyTextForComparison(text: string): string {
  return normalizeTextForComparison(parseReplyDirectives(text).text ?? "");
}

/**
 * Converts a completed embedded attempt into reply payloads for channels. This
 * is the boundary that suppresses duplicate source replies, filters raw API
 * errors, preserves directive metadata, and decides when tool failures must be
 * surfaced to the user.
 */
export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  assistantMessageIndex?: number;
  assistantTranscriptOwned?: boolean;
  assistantTranscriptIdempotencyKey?: string;
  lastAssistant: AssistantMessage | undefined;
  currentAssistant?: AssistantMessage | null;
  lastToolError?: ToolErrorSummary;
  config?: OpenClawConfig;
  isCronTrigger?: boolean;
  isHeartbeatTrigger?: boolean;
  sessionKey: string;
  provider?: string;
  providerOwner?: PreparedProviderFailoverOwner;
  model?: string;
  /** Credential auth mode for billing copy (#80877). */
  authMode?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  thinkingLevel?: ThinkLevel;
  toolResultFormat?: ToolResultFormat;
  suppressToolErrorWarnings?: boolean | (() => boolean | undefined);
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  agentId?: string;
  runId?: string;
  runAborted?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  heartbeatToolResponse?: HeartbeatToolResponse;
}): ReplyPayload[] {
  const heartbeatTerminalToolFailure =
    params.isHeartbeatTrigger === true &&
    params.lastToolError &&
    params.lastToolError.mutatingAction === true
      ? { toolName: params.lastToolError.toolName }
      : undefined;
  if (params.heartbeatToolResponse && !heartbeatTerminalToolFailure) {
    return [createHeartbeatToolResponsePayload(params.heartbeatToolResponse)];
  }
  // Internal source replies always need transcript/UI mirrors. Only a
  // message_tool_only run suppresses the separate automatic final answer.
  const {
    replyItems,
    hasSourceReplyPayload,
    deliveredSourceReplyViaMessageTool,
    explicitFinalSourceReply,
    completedSourceReplyViaMessageTool,
  } = buildSourceReplyPayloadState({
    payloads: params.messagingToolSourceReplyPayloads,
    sentTargets: params.messagingToolSentTargets,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    didDeliverSourceReplyViaMessageTool: params.didDeliverSourceReplyViaMessageTool,
    runId: params.runId,
  });
  if (params.heartbeatToolResponse) {
    const heartbeatPayload = createHeartbeatToolResponsePayload(params.heartbeatToolResponse);
    replyItems.push({
      text: heartbeatPayload.text ?? "",
      ...(heartbeatPayload.channelData ? { channelData: heartbeatPayload.channelData } : {}),
    });
  }
  const useMarkdown = params.toolResultFormat === "markdown";
  const suppressAssistantArtifacts =
    params.heartbeatToolResponse !== undefined ||
    params.didSendDeterministicApprovalPrompt === true ||
    (params.sourceReplyDeliveryMode === "message_tool_only" && hasSourceReplyPayload) ||
    deliveredSourceReplyViaMessageTool;
  const suppressFailureArtifacts =
    params.didSendDeterministicApprovalPrompt === true ||
    (params.sourceReplyDeliveryMode === "message_tool_only" && completedSourceReplyViaMessageTool);
  const nonEmptyAssistantTexts = params.assistantTexts
    .map((text) => sanitizeAssistantVisibleStreamText(text))
    .filter((text) => text.trim().length > 0);
  const currentAssistant = params.currentAssistant ?? undefined;
  const assistantForPayload =
    currentAssistant ?? (nonEmptyAssistantTexts.length === 1 ? undefined : params.lastAssistant);
  // Pre-upgrade recovered messages have no stored facts, and recovery intentionally does not
  // reparse text; one in-flight reply can lose its target across this upgrade boundary.
  const storedDelivery = assistantForPayload?.openclawDelivery;
  const lastAssistantStopReason = assistantForPayload?.stopReason;
  const lastAssistantErrored = lastAssistantStopReason === "error";
  const lastAssistantAborted = lastAssistantStopReason === "aborted";
  const runAborted = params.runAborted === true || lastAssistantAborted;
  const lastAssistantNeedsErrorSurface = lastAssistantErrored || lastAssistantAborted;
  const rawErrorMessage = lastAssistantNeedsErrorSurface
    ? normalizeOptionalString(assistantForPayload?.errorMessage)
    : undefined;
  const errorText =
    assistantForPayload && lastAssistantNeedsErrorSurface
      ? suppressFailureArtifacts
        ? undefined
        : lastAssistantErrored || rawErrorMessage
          ? formatUserFacingAssistantErrorText(assistantForPayload, {
              cfg: params.config,
              sessionKey: params.sessionKey,
              provider: params.provider,
              providerOwner: params.providerOwner,
              model: params.model,
              authMode: params.authMode,
            })
          : formatAssistantErrorText(assistantForPayload, {
              cfg: params.config,
              sessionKey: params.sessionKey,
              provider: params.provider,
              providerOwner: params.providerOwner,
              model: params.model,
              authMode: params.authMode,
            })
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
  const normalizedGenericBillingErrorText = normalizeTextForComparison(BILLING_ERROR_USER_MESSAGE);
  const genericErrorText = "The AI service returned an error. Please try again.";
  if (errorText) {
    replyItems.push({ text: errorText, isError: true });
  }
  const reasoningText =
    suppressAssistantArtifacts || runAborted || lastAssistantNeedsErrorSurface
      ? ""
      : assistantForPayload && params.reasoningLevel === "on" && params.thinkingLevel !== "off"
        ? extractAssistantThinking(assistantForPayload)
        : "";
  if (reasoningText) {
    replyItems.push({ text: reasoningText, isReasoning: true });
  }
  const fallbackAnswerText = assistantForPayload
    ? extractAssistantVisibleText(assistantForPayload)
    : "";
  const fallbackRawAnswerText = resolveRawAssistantAnswerText(assistantForPayload);
  const shouldSuppressRawErrorText = (text: string) => {
    if (!lastAssistantNeedsErrorSurface) {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (errorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalizedErrorText && normalized === normalizedErrorText) {
        return true;
      }
      if (trimmed === genericErrorText) {
        return true;
      }
      if (
        normalized &&
        normalizedGenericBillingErrorText &&
        normalized === normalizedGenericBillingErrorText
      ) {
        return true;
      }
    }
    if (rawErrorMessage && trimmed === rawErrorMessage) {
      return true;
    }
    if (formattedRawErrorMessage && trimmed === formattedRawErrorMessage) {
      return true;
    }
    if (normalizedRawErrorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedRawErrorText) {
        return true;
      }
    }
    if (normalizedFormattedRawErrorMessage) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedFormattedRawErrorMessage) {
        return true;
      }
    }
    if (rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === rawErrorFingerprint) {
        return true;
      }
    }
    return isRawApiErrorPayload(trimmed);
  };
  const rawAnswerDirectiveState = fallbackRawAnswerText
    ? parseReplyDirectives(fallbackRawAnswerText)
    : null;
  const rawAnswerHasMedia =
    (rawAnswerDirectiveState?.mediaUrls?.length ?? 0) > 0 || rawAnswerDirectiveState?.audioAsVoice;
  const assistantTextsHaveMedia = params.assistantTexts.some((text) => {
    const parsed = parseReplyDirectives(text);
    return (parsed.mediaUrls?.length ?? 0) > 0 || parsed.audioAsVoice;
  });
  const normalizedAssistantTexts = normalizeTextForComparison(nonEmptyAssistantTexts.join("\n\n"));
  const normalizedRawAnswerText = normalizeTextForComparison(rawAnswerDirectiveState?.text ?? "");
  const shouldPreferRawAnswerText =
    rawAnswerHasMedia &&
    (!nonEmptyAssistantTexts.length ||
      (!assistantTextsHaveMedia &&
        normalizedAssistantTexts.length > 0 &&
        normalizedAssistantTexts === normalizedRawAnswerText));
  // When streamed text lost media directives but the canonical assistant answer
  // still contains them, keep the raw answer so attachments are not dropped.
  const fallbackAnswerSourceText =
    shouldPreferRawAnswerText && fallbackRawAnswerText ? fallbackRawAnswerText : fallbackAnswerText;
  const normalizedFallbackAnswerSourceText = fallbackAnswerSourceText
    ? normalizeReplyTextForComparison(fallbackAnswerSourceText)
    : "";
  const shouldUseCanonicalFinalAnswer =
    !lastAssistantNeedsErrorSurface &&
    fallbackAnswerSourceText.length > 0 &&
    normalizedFallbackAnswerSourceText.length > 0;
  const hasAssistantTextPayload = nonEmptyAssistantTexts.length > 0;
  const answerTexts =
    suppressAssistantArtifacts || runAborted || lastAssistantNeedsErrorSurface
      ? []
      : (shouldUseCanonicalFinalAnswer
          ? [fallbackAnswerSourceText]
          : shouldPreferRawAnswerText && fallbackRawAnswerText
            ? [fallbackRawAnswerText]
            : hasAssistantTextPayload
              ? nonEmptyAssistantTexts
              : fallbackAnswerText
                ? [fallbackAnswerText]
                : []
        ).filter((text) => !shouldSuppressRawErrorText(text));
  let hasUserFacingAssistantReply =
    completedSourceReplyViaMessageTool || params.heartbeatToolResponse?.notify === true;
  const hasUserFacingErrorReply = replyItems.some((item) => item.isError === true);
  let hasUserFacingFailureAcknowledgement =
    params.heartbeatToolResponse?.notify === true &&
    (params.heartbeatToolResponse.outcome === "blocked" ||
      hasExplicitMutatingToolFailureAcknowledgement(
        getHeartbeatToolNotificationText(params.heartbeatToolResponse),
      ));
  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = parseReplyDirectives(text);
    const delivery = shouldUseCanonicalFinalAnswer
      ? {
          ...storedDelivery,
          replyToTag: Boolean(storedDelivery?.replyToCurrent || storedDelivery?.replyToId),
        }
      : { audioAsVoice, replyToId, replyToTag, replyToCurrent };
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !delivery.audioAsVoice) {
      continue;
    }
    replyItems.push({
      text: cleanedText,
      media: mediaUrls,
      ...delivery,
    });
    hasUserFacingAssistantReply = true;
    if (cleanedText && hasExplicitMutatingToolFailureAcknowledgement(cleanedText)) {
      hasUserFacingFailureAcknowledgement = true;
    }
  }
  if (params.lastToolError) {
    // Surface mutating failures unless the assistant explicitly acknowledged the failed action.
    // Otherwise, keep the previous behavior and only surface non-recoverable failures when no reply exists.
    const failureWarning = buildFailureWarning({
      lastToolError: params.lastToolError,
      hasUserFacingReply: hasUserFacingAssistantReply,
      hasUserFacingErrorReply,
      hasUserFacingFailureAcknowledgement,
      suppressToolErrors: Boolean(params.config?.messages?.suppressToolErrors),
      suppressToolErrorWarnings: params.suppressToolErrorWarnings,
      verboseLevel: params.verboseLevel,
      useMarkdown,
    });
    if (failureWarning) {
      const normalizedWarning = normalizeTextForComparison(failureWarning.text);
      const duplicateWarning = normalizedWarning
        ? replyItems.some((item) => {
            if (!item.text) {
              return false;
            }
            const normalizedExisting = normalizeTextForComparison(item.text);
            return normalizedExisting.length > 0 && normalizedExisting === normalizedWarning;
          })
        : false;
      if (!duplicateWarning) {
        replyItems.push({
          text: failureWarning.text,
          isError: true,
          nonTerminalToolErrorWarning:
            hasUserFacingAssistantReply && failureWarning.nonTerminalToolErrorWarning,
        });
      }
    }
  }
  if (heartbeatTerminalToolFailure && !replyItems.some((item) => item.isReasoning !== true)) {
    replyItems.push({ text: HEARTBEAT_TOKEN });
  }
  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => {
      const payload: ReplyPayload = {
        text: normalizeOptionalString(item.text),
      };
      const mediaUrl = item.mediaUrl ?? item.media?.[0];
      if (mediaUrl) {
        payload.mediaUrl = mediaUrl;
      }
      if (item.media?.length) {
        payload.mediaUrls = item.media;
      }
      if (item.isError !== undefined) {
        payload.isError = item.isError;
      }
      if (item.isReasoning === true) {
        payload.isReasoning = true;
      }
      if (
        item.isError === true &&
        params.sourceReplyDeliveryMode === "message_tool_only" &&
        explicitFinalSourceReply === false
      ) {
        markReplyPayloadForSourceSuppressionDelivery(payload);
      }
      if (item.nonTerminalToolErrorWarning) {
        setReplyPayloadMetadata(payload, {
          nonTerminalToolErrorWarning: true,
        });
      }
      if (heartbeatTerminalToolFailure) {
        setReplyPayloadMetadata(payload, {
          heartbeatTerminalToolFailure,
        });
      }
      if (
        !item.isError &&
        !item.isReasoning &&
        (params.assistantMessageIndex !== undefined || params.assistantTranscriptOwned === true)
      ) {
        setReplyPayloadMetadata(payload, {
          ...(params.assistantMessageIndex !== undefined
            ? { assistantMessageIndex: params.assistantMessageIndex }
            : {}),
          ...(item.media?.length ? { assistantTranscriptMediaUrls: [...item.media] } : {}),
          ...(params.assistantTranscriptOwned === true ? { assistantTranscriptOwned: true } : {}),
          ...(params.assistantTranscriptIdempotencyKey
            ? {
                assistantTranscriptIdempotencyKey: params.assistantTranscriptIdempotencyKey,
              }
            : {}),
        });
      }
      if (item.replyToId) {
        payload.replyToId = item.replyToId;
      }
      if (item.replyToTag !== undefined) {
        payload.replyToTag = item.replyToTag;
      }
      if (item.replyToCurrent !== undefined) {
        payload.replyToCurrent = item.replyToCurrent;
      }
      if (item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length)) {
        payload.audioAsVoice = true;
      }
      if (item.presentation) {
        payload.presentation = item.presentation;
      }
      if (item.interactive) {
        payload.interactive = item.interactive;
      }
      if (item.channelData) {
        payload.channelData = item.channelData;
      }
      if (item.sourceReplyMirror) {
        // Source-reply mirrors are transcript artifacts, not channel sends.
        markReplyPayloadForSourceSuppressionDelivery(payload);
        if (params.sessionKey) {
          const sourceReplyTranscriptMirror: NonNullable<
            ReplyPayloadMetadata["sourceReplyTranscriptMirror"]
          > = {
            sessionKey: params.sessionKey,
          };
          if (params.agentId) {
            sourceReplyTranscriptMirror.agentId = params.agentId;
          }
          if (payload.text) {
            sourceReplyTranscriptMirror.text = payload.text;
          }
          if (payload.mediaUrls?.length) {
            sourceReplyTranscriptMirror.mediaUrls = payload.mediaUrls;
          }
          if (item.sourceReplyMirror.idempotencyKey) {
            sourceReplyTranscriptMirror.idempotencyKey = item.sourceReplyMirror.idempotencyKey;
          }
          setReplyPayloadMetadata(payload, {
            sourceReplyTranscriptMirror,
          });
        }
      }
      if (payload.text && isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN)) {
        const silentText = payload.text;
        payload.text = undefined;
        if (hasReplyPayloadContent(payload)) {
          return payload;
        }
        payload.text = silentText;
      }
      return payload;
    })
    .filter((p) => {
      if (!hasReplyPayloadContent(p)) {
        return false;
      }
      if (p.text && isSilentReplyPayloadText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
