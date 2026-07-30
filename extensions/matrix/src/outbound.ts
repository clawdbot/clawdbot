// Matrix plugin module implements outbound behavior.
import {
  createMessageReceiptFromOutboundResults,
  createReplyToFanout,
} from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence,
} from "openclaw/plugin-sdk/reply-payload";
import {
  MATRIX_PRESENTATION_CAPABILITIES,
  renderMatrixPresentationPayload,
  resolveMatrixExtraContent,
  resolveMatrixPayloadText,
} from "./matrix/presentation-content.js";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import {
  chunkTextForOutbound,
  resolveOutboundSendDep,
  type ChannelOutboundAdapter,
} from "./runtime-api.js";

function resolveMatrixDeliveryProgress(
  onDeliveryResult: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"],
) {
  return onDeliveryResult
    ? async (result: Awaited<ReturnType<typeof sendMessageMatrix>>) => {
        await onDeliveryResult(attachChannelToResult("matrix", result));
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
    const urls = resolvePayloadMediaUrls(payload);
    const payloadText = resolveMatrixPayloadText(payload);
    if (urls.length > 0) {
      const sentResults: Awaited<ReturnType<typeof sendMessageMatrix>>[] = [];
      const lastResult = await sendPayloadMediaSequence({
        text: payloadText,
        mediaUrls: urls,
        send: async ({ text, mediaUrl, isFirst }) =>
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
        return attachChannelToResult("matrix", {
          ...lastResult,
          primaryMessageId: receipt.primaryPlatformMessageId,
          receipt,
          content: sentResults.map((result) => result.content).join("\n"),
        });
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
      extraContent: resolveMatrixExtraContent(payload),
      onDeliveryResult: resolveMatrixDeliveryProgress(onDeliveryResult),
    });
    return attachChannelToResult("matrix", result);
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
    return attachChannelToResult("matrix", result);
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
    return attachChannelToResult("matrix", result);
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
