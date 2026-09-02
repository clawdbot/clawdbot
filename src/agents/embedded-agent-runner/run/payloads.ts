/**
 * Builds embedded-agent payload objects from attempt inputs and outcomes.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildCodexLoginRecovery } from "../../../auto-reply/codex-login-recovery.js";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../../../auto-reply/heartbeat-tool-response.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
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
import { classifyOAuthRefreshFailure } from "../../auth-profiles/oauth-refresh-failure.js";
import {
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  normalizeTextForComparison,
} from "../../embedded-agent-helpers.js";
import { SYNTHESIZED_TIMEOUT_ERROR_TEXT } from "../../embedded-agent-helpers/error-text.js";
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
import { isTimeoutErrorMessage } from "../../failover/classify.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import { buildSourceReplyPayloadState } from "./source-reply-payloads.js";
import { buildFailureWarning } from "./tool-error-warning.js";

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
  suppressToolErrorWarnings?: boolean;
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  agentId?: string;
  runId?: string;
  runAborted?: boolean;
  runStopReason?: string;
  deferAssistantTimeoutError?: boolean;
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
  // reparse text; one in-flight reply can lose delivery or speech intent across this boundary.
  const storedDelivery = assistantForPayload?.openclawDelivery;
  const lastAssistantStopReason = assistantForPayload?.stopReason;
  const lastAssistantErrored = lastAssistantStopReason === "error";
  const lastAssistantAborted = lastAssistantStopReason === "aborted";
  const runAborted = params.runAborted === true || lastAssistantAborted;
  const lastAssistantNeedsErrorSurface = lastAssistantErrored || lastAssistantAborted;
  const rawErrorMessage = lastAssistantNeedsErrorSurface
    ? normalizeOptionalString(assistantForPayload?.errorMessage)
    : undefined;
  const oauthRefreshFailure = rawErrorMessage ? classifyOAuthRefreshFailure(rawErrorMessage) : null;
  const codexLoginRecovery = buildCodexLoginRecovery({
    provider: oauthRefreshFailure?.provider ?? params.provider,
    oauthReason: oauthRefreshFailure?.reason,
  });
  const errorText =
    assistantForPayload && lastAssistantNeedsErrorSurface
      ? suppressFailureArtifacts
        ? undefined
        : lastAssistantErrored || rawErrorMessage
          ? (codexLoginRecovery?.hint ??
            formatUserFacingAssistantErrorText(assistantForPayload, {
              cfg: params.config,
              sessionKey: params.sessionKey,
              agentId: params.agentId,
              provider: params.provider,
              providerOwner: params.providerOwner,
              model: params.model,
              authMode: params.authMode,
            }))
          : formatAssistantErrorText(assistantForPayload, {
              cfg: params.config,
              sessionKey: params.sessionKey,
              agentId: params.agentId,
              provider: params.provider,
              providerOwner: params.providerOwner,
              model: params.model,
              authMode: params.authMode,
            })
      : undefined;
  const deferAssistantTimeoutError =
    params.deferAssistantTimeoutError === true &&
    rawErrorMessage !== undefined &&
    isTimeoutErrorMessage(rawErrorMessage) &&
    errorText === SYNTHESIZED_TIMEOUT_ERROR_TEXT;
  if (errorText && !deferAssistantTimeoutError) {
    replyItems.push({
      text: errorText,
      isError: true,
      ...(codexLoginRecovery ? { presentation: codexLoginRecovery.presentation } : {}),
    });
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
  const rawAnswerDirectiveState = fallbackRawAnswerText
    ? parseReplyDirectives(fallbackRawAnswerText)
    : null;
  const rawAnswerHasMedia =
    (rawAnswerDirectiveState?.mediaUrls?.length ?? 0) > 0 || rawAnswerDirectiveState?.audioAsVoice;
  const normalizedAssistantTexts =
    rawAnswerHasMedia &&
    nonEmptyAssistantTexts.length > 0 &&
    !params.assistantTexts.some((text) => {
      const parsed = parseReplyDirectives(text);
      return (parsed.mediaUrls?.length ?? 0) > 0 || parsed.audioAsVoice;
    })
      ? normalizeTextForComparison(nonEmptyAssistantTexts.join("\n\n"))
      : "";
  const shouldPreferRawAnswerText =
    rawAnswerHasMedia &&
    (!nonEmptyAssistantTexts.length ||
      (normalizedAssistantTexts.length > 0 &&
        normalizedAssistantTexts ===
          normalizeTextForComparison(rawAnswerDirectiveState?.text ?? "")));
  // When streamed text lost media directives but the canonical assistant answer
  // still contains them, keep the raw answer so attachments are not dropped.
  const fallbackAnswerSourceText =
    shouldPreferRawAnswerText && fallbackRawAnswerText ? fallbackRawAnswerText : fallbackAnswerText;
  const fallbackAnswerDirectiveState =
    fallbackAnswerSourceText === fallbackRawAnswerText
      ? rawAnswerDirectiveState
      : fallbackAnswerSourceText
        ? parseReplyDirectives(fallbackAnswerSourceText)
        : null;
  const normalizedFallbackAnswerSourceText = fallbackAnswerDirectiveState
    ? normalizeTextForComparison(fallbackAnswerDirectiveState.text)
    : "";
  const shouldUseCanonicalFinalAnswer =
    !lastAssistantNeedsErrorSurface &&
    fallbackAnswerSourceText.length > 0 &&
    normalizedFallbackAnswerSourceText.length > 0;
  const hasAssistantTextPayload = nonEmptyAssistantTexts.length > 0;
  const answerTexts =
    suppressAssistantArtifacts || runAborted || lastAssistantNeedsErrorSurface
      ? []
      : shouldUseCanonicalFinalAnswer
        ? [fallbackAnswerSourceText]
        : shouldPreferRawAnswerText && fallbackRawAnswerText
          ? [fallbackRawAnswerText]
          : hasAssistantTextPayload
            ? nonEmptyAssistantTexts
            : fallbackAnswerText
              ? [fallbackAnswerText]
              : [];
  const preparedAnswerDirectives =
    shouldUseCanonicalFinalAnswer || shouldPreferRawAnswerText || !hasAssistantTextPayload
      ? fallbackAnswerDirectiveState
      : null;
  let hasUserFacingReply =
    Boolean(errorText) ||
    completedSourceReplyViaMessageTool ||
    params.heartbeatToolResponse?.notify === true;
  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = preparedAnswerDirectives ?? parseReplyDirectives(text);
    const ttsFacts = shouldUseCanonicalFinalAnswer ? storedDelivery?.tts : undefined;
    const delivery = shouldUseCanonicalFinalAnswer
      ? {
          audioAsVoice: storedDelivery?.audioAsVoice,
          replyToCurrent: storedDelivery?.replyToCurrent,
          replyToId: storedDelivery?.replyToId,
          replyToTag: Boolean(storedDelivery?.replyToCurrent || storedDelivery?.replyToId),
        }
      : { audioAsVoice, replyToId, replyToTag, replyToCurrent };
    if (
      !cleanedText &&
      (!mediaUrls || mediaUrls.length === 0) &&
      !delivery.audioAsVoice &&
      !ttsFacts
    ) {
      continue;
    }
    const replyPayload = {
      text: cleanedText,
      media: mediaUrls,
      ...delivery,
    };
    replyItems.push(
      ttsFacts ? setReplyPayloadMetadata(replyPayload, { tts: ttsFacts }) : replyPayload,
    );
    hasUserFacingReply = true;
  }
  if (params.lastToolError) {
    // A restart intentionally aborts the active tool while the Gateway takes over.
    // Keep that lifecycle status independent from tool-error suppression.
    const isRestartStatus = params.runStopReason === "restart";
    const warningText = isRestartStatus
      ? "Gateway restarting…"
      : buildFailureWarning({
          lastToolError: params.lastToolError,
          hasUserFacingReply,
          suppressToolErrors: Boolean(params.config?.messages?.suppressToolErrors),
          suppressToolErrorWarnings: params.suppressToolErrorWarnings,
          verboseLevel: params.verboseLevel,
          useMarkdown,
        });
    if (warningText) {
      const normalizedWarning = normalizeTextForComparison(warningText);
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
        const warning = {
          text: warningText,
          ...(!isRestartStatus ? { isError: true } : {}),
        };
        if (!isRestartStatus) {
          setReplyPayloadMetadata(warning, {
            toolErrorWarning: { toolName: params.lastToolError.toolName },
          });
        }
        replyItems.push(warning);
      }
    }
  }
  if (heartbeatTerminalToolFailure && !replyItems.some((item) => item.isReasoning !== true)) {
    replyItems.push({ text: HEARTBEAT_TOKEN });
  }
  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => {
      const payload: ReplyPayload = copyReplyPayloadMetadata(item, {
        text: normalizeOptionalString(item.text),
      });
      const mediaUrl = item.mediaUrl ?? item.media?.[0];
      if (mediaUrl) {
        payload.mediaUrl = mediaUrl;
      }
      if (item.media?.length) {
        payload.mediaUrls = item.media;
      }
      if (item.attachments?.length) {
        payload.attachments = item.attachments;
      }
      if (item.trustedLocalMedia !== undefined) {
        payload.trustedLocalMedia = item.trustedLocalMedia;
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
          if (item.sourceReplyMirror.transcriptOwner) {
            sourceReplyTranscriptMirror.transcriptOwner = true;
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
      if (!hasReplyPayloadContent(p) && !getReplyPayloadMetadata(p)?.tts) {
        return false;
      }
      if (p.text && isSilentReplyPayloadText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
