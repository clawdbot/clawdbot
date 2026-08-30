import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
// Matrix plugin module implements outbound behavior.
import {
  createMessageReceiptFromOutboundResults,
  createReplyToFanout,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type MessagePresentation,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveSendableOutboundReplyParts,
  sendPayloadMediaSequence,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import type { MatrixExtraContentFields } from "./matrix/send/types.js";

const MATRIX_OPENCLAW_PRESENTATION_KEY = "com.openclaw.presentation" as const;
const MATRIX_OPENCLAW_PRESENTATION_TYPE = "message.presentation" as const;
const MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT = "---";

const MATRIX_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  limits: {
    text: {
      markdownDialect: "markdown",
      supportsEdit: true,
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

type MatrixChannelData = {
  extraContent?: MatrixExtraContentFields;
};

function toMatrixOutboundResult<T extends { roomId: string }>(result: T) {
  const { roomId, ...delivery } = result;
  return { ...delivery, target: { kind: "room" as const, id: roomId } };
}

function resolveMatrixChannelData(payload: ReplyPayload): MatrixChannelData {
  const raw = asOptionalRecord(payload.channelData)?.matrix;
  return (asOptionalRecord(raw) as MatrixChannelData | undefined) ?? {};
}

function buildMatrixPresentationContent(presentation: MessagePresentation) {
  return {
    ...presentation,
    version: 1,
    type: MATRIX_OPENCLAW_PRESENTATION_TYPE,
  };
}

function resolveMatrixPresentationContent(
  payload: ReplyPayload,
): Record<string, unknown> | undefined {
  const extraContent = asOptionalRecord(resolveMatrixChannelData(payload).extraContent);
  const presentation = asOptionalRecord(extraContent?.[MATRIX_OPENCLAW_PRESENTATION_KEY]);
  if (
    !presentation ||
    presentation.version !== 1 ||
    presentation.type !== MATRIX_OPENCLAW_PRESENTATION_TYPE
  ) {
    return undefined;
  }
  return presentation;
}

function renderMatrixPresentationPayload(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): ReplyPayload {
  const matrixData = resolveMatrixChannelData(params.payload);
  const fallbackText = renderMessagePresentationFallbackText({
    text: params.payload.text,
    presentation: params.presentation,
    emptyFallback: MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT,
  });
  return {
    ...params.payload,
    text: fallbackText,
    channelData: {
      ...params.payload.channelData,
      matrix: {
        ...matrixData,
        extraContent: {
          [MATRIX_OPENCLAW_PRESENTATION_KEY]: buildMatrixPresentationContent(params.presentation),
        },
      },
    },
  };
}

const countMatrixPresentationDataBlocks = (blocks: readonly MessagePresentationBlock[]): number =>
  blocks.filter((block) => block.type === "table" || block.type === "chart").length;

/**
 * Resolve a reply's portable presentation into Matrix event content.
 *
 * Core runs the presentation renderer inside the outbound send pipeline only, so a
 * reply the monitor delivers itself reaches the room with its presentation still
 * portable — and loses it. Resolving it here puts both Matrix delivery paths on the
 * one rendering `renderPresentation` already owns.
 */
export function prepareMatrixReplyPayload(payload: ReplyPayload): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const { presentation: _presentation, presentationTextMode, ...rest } = payload;
  const adapted = adaptMessagePresentationForChannel({
    presentation,
    capabilities: MATRIX_PRESENTATION_CAPABILITIES,
  });
  const usesFallbackText = presentationTextMode === "fallback";
  // Only a presentation whose structured blocks all degraded to text says nothing
  // its producer's own fallback prose already says; that prose then stays verbatim.
  // Anything Matrix renders natively, context included, still belongs in the event.
  // This is `renderPresentationForDelivery`'s rule, which owns the same decision for
  // the outbound path; the two must not drift.
  const degradedToTextOnly =
    !presentation.blocks.some((block) => block.type === "buttons" || block.type === "select") &&
    countMatrixPresentationDataBlocks(presentation.blocks) > 0 &&
    countMatrixPresentationDataBlocks(adapted.blocks) === 0;
  if (usesFallbackText && rest.text?.trim() && degradedToTextOnly) {
    return rest;
  }
  return renderMatrixPresentationPayload({
    // Native rendering replaces that same prose; keeping both would send it twice.
    payload: usesFallbackText ? { ...rest, text: undefined } : rest,
    presentation: adapted,
  });
}

function resolveMatrixPayloadText(payload: ReplyPayload): string {
  const text = payload.text ?? "";
  if (text.trim() || !resolveMatrixPresentationContent(payload)) {
    return text;
  }
  return MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT;
}

/** Matrix event fields a reply carries beyond its body, currently its presentation. */
export function resolveMatrixExtraContent(
  payload: ReplyPayload,
): MatrixExtraContentFields | undefined {
  const presentation = resolveMatrixPresentationContent(payload);
  return presentation ? { [MATRIX_OPENCLAW_PRESENTATION_KEY]: presentation } : undefined;
}

function resolveMatrixDeliveryProgress(
  onDeliveryResult: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"],
) {
  return onDeliveryResult
    ? async (result: Awaited<ReturnType<typeof sendMessageMatrix>>) => {
        await onDeliveryResult(attachChannelToResult("matrix", toMatrixOutboundResult(result)));
      }
    : undefined;
}

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  presentationCapabilities: MATRIX_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation }) =>
    renderMatrixPresentationPayload({ payload, presentation }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    mediaReadFile,
    mediaAccess,
    deps,
    replyToId,
    replyToIdSource,
    replyToMode,
    threadId,
    accountId,
    audioAsVoice,
    deliveryQueueId,
    onPlatformSendDispatch,
    onDeliveryResult,
  }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const resolveReplyToId = createReplyToFanout({
      ...(replyToId != null ? { replyToId } : {}),
      ...(replyToIdSource !== undefined ? { replyToIdSource } : {}),
      ...(replyToMode !== undefined ? { replyToMode } : {}),
    });
    const urls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    const payloadText = resolveMatrixPayloadText(payload);
    if (urls.length > 0) {
      const sentResults: Awaited<ReturnType<typeof sendMessageMatrix>>[] = [];
      const lastResult = await sendPayloadMediaSequence({
        text: payloadText,
        mediaUrls: urls,
        send: async ({ text, mediaUrl, index, isFirst }) =>
          await send(to, text, {
            cfg,
            mediaUrl,
            mediaAccess,
            mediaLocalRoots,
            mediaReadFile,
            replyToId: resolveReplyToId(),
            threadId: resolvedThreadId,
            accountId: accountId ?? undefined,
            audioAsVoice: payload.audioAsVoice ?? audioAsVoice,
            deliveryQueueId,
            deliveryPartIndex: index,
            deliveryPartCount: urls.length,
            onPlatformSendDispatch,
            extraContent: isFirst ? resolveMatrixExtraContent(payload) : undefined,
            onDeliveryResult: resolveMatrixDeliveryProgress(onDeliveryResult),
          }),
        onResult: (result) => {
          sentResults.push(result);
        },
      });
      if (lastResult !== undefined) {
        // One payload owns one receipt; keep every attachment and its original reply metadata.
        const receipt = createMessageReceiptFromOutboundResults({ results: sentResults });
        receipt.parts = receipt.parts.map((part, index) => ({ ...part, index }));
        return attachChannelToResult(
          "matrix",
          toMatrixOutboundResult({
            ...lastResult,
            primaryMessageId: receipt.primaryPlatformMessageId,
            receipt,
            content: sentResults.map((result) => result.content).join("\n"),
          }),
        );
      }
    }
    const result = await send(to, payloadText, {
      cfg,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      replyToId: resolveReplyToId(),
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice: payload.audioAsVoice ?? audioAsVoice,
      deliveryQueueId,
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      onPlatformSendDispatch,
      extraContent: resolveMatrixExtraContent(payload),
      onDeliveryResult: resolveMatrixDeliveryProgress(onDeliveryResult),
    });
    return attachChannelToResult("matrix", toMatrixOutboundResult(result));
  },
  sendText: async ({
    cfg,
    to,
    text,
    deps,
    replyToId,
    threadId,
    accountId,
    audioAsVoice,
    deliveryQueueId,
    deliveryPartIndex,
    deliveryPartCount,
    onPlatformSendDispatch,
    onDeliveryResult,
  }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      cfg,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice,
      deliveryQueueId,
      deliveryPartIndex,
      ...(deliveryQueueId !== undefined ? { deliveryPartCount } : {}),
      onPlatformSendDispatch,
      onDeliveryResult: resolveMatrixDeliveryProgress(onDeliveryResult),
    });
    return attachChannelToResult("matrix", toMatrixOutboundResult(result));
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    mediaAccess,
    deps,
    replyToId,
    threadId,
    accountId,
    audioAsVoice,
    deliveryQueueId,
    deliveryPartIndex,
    deliveryPartCount,
    onPlatformSendDispatch,
    onDeliveryResult,
  }) => {
    const send =
      resolveOutboundSendDep<typeof sendMessageMatrix>(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      cfg,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      mediaAccess,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice,
      deliveryQueueId,
      deliveryPartIndex,
      ...(deliveryQueueId !== undefined ? { deliveryPartCount } : {}),
      onPlatformSendDispatch,
      onDeliveryResult: resolveMatrixDeliveryProgress(onDeliveryResult),
    });
    return attachChannelToResult("matrix", toMatrixOutboundResult(result));
  },
  sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
    const resolvedThreadId = threadId !== undefined && threadId !== null ? threadId : undefined;
    const result = await sendPollMatrix(to, poll, {
      cfg,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      roomId: result.roomId,
      pollId: result.eventId,
    };
  },
};
