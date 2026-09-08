import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  hasOutboundReplyContent,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { shouldAttemptTtsPayload } from "../../tts/tts-config.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  type ReplyPayload,
} from "../reply-payload.js";
import { prepareReplyPayloadForDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";
import { beginReplyOperationFinalizationWork } from "./reply-run-finalization-lease.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));

const NO_VISIBLE_REPLY_FALLBACK_TEXT =
  "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. If this keeps happening, ask the operator to check the gateway logs.";

export function buildNoVisibleReplyFallbackText(runId?: string): string {
  const reference = normalizeOptionalString(runId);
  // Caller-supplied IDs must not inject markup, mentions, or unbounded text into a channel.
  return reference && /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(reference)
    ? `${NO_VISIBLE_REPLY_FALLBACK_TEXT} Reference: ${reference}.`
    : NO_VISIBLE_REPLY_FALLBACK_TEXT;
}

export const QUEUE_CAP_REJECTION_TEXT =
  "This message was not queued because the session queue is full. Please try again after the current response finishes.";

type SourceReplySuppressionState = {
  ctx: { InboundEventKind?: InboundEventKind };
  explicitCommandTurnCtx: boolean;
  suppressAutomaticSourceDelivery: boolean;
  sendPolicyDenied: boolean;
};

export function shouldDeliverDespiteSourceReplySuppression(
  payload: ReplyPayload,
  state: SourceReplySuppressionState,
): boolean {
  return (
    state.suppressAutomaticSourceDelivery &&
    !state.sendPolicyDenied &&
    getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true &&
    (state.ctx.InboundEventKind !== "room_event" || state.explicitCommandTurnCtx)
  );
}

export function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  return isRecord(payload.channelData?.execApproval);
}

export function hasExecApprovalUnavailablePayload(payload: ReplyPayload): boolean {
  return isRecord(payload.channelData?.execApprovalUnavailable);
}

export function hasAskUserPayload(payload: ReplyPayload): boolean {
  return isRecord(payload.channelData?.askUser);
}

export function requiresDurableToolResultDelivery(payload: ReplyPayload): boolean {
  return (
    resolveSendableOutboundReplyParts(payload).hasMedia ||
    hasExecApprovalPayload(payload) ||
    hasExecApprovalUnavailablePayload(payload) ||
    hasAskUserPayload(payload)
  );
}

export function createFinalDispatchPayloadDedupeKey(payload: ReplyPayload): string {
  const metadata = getReplyPayloadMetadata(payload);
  return JSON.stringify({
    payload: {
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      trustedLocalMedia: payload.trustedLocalMedia,
      sensitiveMedia: payload.sensitiveMedia,
      presentation: payload.presentation,
      presentationTextMode: payload.presentationTextMode,
      delivery: payload.delivery,
      interactive: payload.interactive,
      btw: payload.btw,
      replyToId: payload.replyToId,
      replyToTag: payload.replyToTag,
      replyToCurrent: payload.replyToCurrent,
      audioAsVoice: payload.audioAsVoice,
      videoAsNote: payload.videoAsNote === true,
      location: payload.location,
      spokenText: payload.spokenText,
      ttsSupplement: payload.ttsSupplement,
      isError: payload.isError,
      isReasoning: payload.isReasoning,
      isCommentary: payload.isCommentary,
      isReasoningSnapshot: payload.isReasoningSnapshot,
      isCompactionNotice: payload.isCompactionNotice,
      isFallbackNotice: payload.isFallbackNotice,
      isStatusNotice: payload.isStatusNotice,
      channelData: payload.channelData,
    },
    identity: {
      assistantMessageIndex: metadata?.assistantMessageIndex,
      assistantTranscriptOwned: metadata?.assistantTranscriptOwned,
      replyToIdExplicit: metadata?.replyToIdExplicit,
      replyDelivery: metadata?.replyDelivery,
      replyDeliverySource: metadata?.replyDeliverySource,
      sourceReplyTranscriptMirror: metadata?.sourceReplyTranscriptMirror,
    },
  });
}

export function formatSuppressedReplyPayloadForLog(reply: ReplyPayload): string {
  const metadata = getReplyPayloadMetadata(reply);
  const text = normalizeOptionalString(reply.text);
  const textPreview = text ? truncateUtf16Safe(text.replace(/\s+/g, " "), 160) : undefined;
  const sendableParts = resolveSendableOutboundReplyParts(reply);
  const richParts = [
    reply.presentation ? "presentation" : undefined,
    reply.interactive ? "interactive" : undefined,
    reply.channelData ? "channelData" : undefined,
  ].filter(Boolean);
  return [
    `textChars=${text?.length ?? 0}`,
    `media=${sendableParts.mediaCount}`,
    `rich=${richParts.length ? richParts.join("|") : "none"}`,
    `error=${reply.isError === true}`,
    `beforeAgentRunBlocked=${metadata?.beforeAgentRunBlocked === true}`,
    `deliverDespiteSuppression=${metadata?.deliverDespiteSourceReplySuppression === true}`,
    textPreview ? `textPreview=${JSON.stringify(textPreview)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

async function maybeApplyTtsToReplyPayload(
  params: Parameters<
    Awaited<ReturnType<typeof ttsRuntimeLoader.load>>["maybeApplyTtsToPayload"]
  >[0],
) {
  if (isReplyPayloadStatusNotice(params.payload)) {
    return params.payload;
  }
  if (
    !shouldAttemptTtsPayload({
      cfg: params.cfg,
      ttsAuto: params.ttsAuto,
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    })
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await ttsRuntimeLoader.load();
  const ttsPayload = await maybeApplyTtsToPayload(params);
  return ttsPayload === params.payload
    ? ttsPayload
    : copyReplyPayloadMetadata(params.payload, ttsPayload);
}

export function createFinalizationAwareTtsPayloadApplier(params: {
  getReplyOperation: () => ReplyOperation | undefined;
  hasInboundAudio: () => boolean;
}) {
  return async (
    ttsParams: Omit<Parameters<typeof maybeApplyTtsToReplyPayload>[0], "inboundAudio">,
  ) => {
    const replyOperation = params.getReplyOperation();
    // Provider fallbacks can outlive the default lease, but remain bounded by
    // the same hard no-progress ceiling used for stale run takeover.
    const finishFinalizationWork = replyOperation
      ? beginReplyOperationFinalizationWork(replyOperation, RUN_STALE_TAKEOVER_MS)
      : undefined;
    try {
      return await maybeApplyTtsToReplyPayload({
        ...ttsParams,
        inboundAudio: params.hasInboundAudio(),
      });
    } finally {
      finishFinalizationWork?.();
      replyOperation?.recordActivity();
    }
  };
}

/** Applies dispatcher normalization before TTS or transcript-visible side effects. */
export function prepareReplyPayloadForSideEffects(
  dispatcher: ReplyDispatcher,
  kind: ReplyDispatchKind,
  payload: ReplyPayload | null | undefined,
  state: { acceptedReplyPayload: boolean; channelTransformSuppressed: boolean },
  onVisibleAccepted?: () => void,
): ReplyPayload | null {
  if (!payload) {
    return null;
  }
  const outcome = prepareReplyPayloadForDispatcher(dispatcher, kind, payload);
  if (outcome.kind === "deliver") {
    state.acceptedReplyPayload = true;
    if (
      outcome.payload.isReasoning !== true &&
      outcome.payload.isCommentary !== true &&
      hasOutboundReplyContent(outcome.payload, { trimText: true })
    ) {
      onVisibleAccepted?.();
    }
    return outcome.payload;
  }
  state.channelTransformSuppressed ||= outcome.reason === "channel_transform";
  return null;
}
