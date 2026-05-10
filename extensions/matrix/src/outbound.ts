import {
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createReplyToFanout } from "openclaw/plugin-sdk/outbound-runtime";
import { resolvePayloadMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import type { MatrixExtraContentFields } from "./matrix/send/types.js";
import {
  chunkTextForOutbound,
  resolveOutboundSendDep,
  type ChannelOutboundAdapter,
} from "./runtime-api.js";

const MATRIX_OPENCLAW_PRESENTATION_KEY = "com.openclaw.presentation" as const;
const MATRIX_OPENCLAW_PRESENTATION_TYPE = "message.presentation" as const;
const MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT = "---";

type MatrixChannelData = {
  extraContent?: MatrixExtraContentFields;
};

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveMatrixChannelData(payload: ReplyPayload): MatrixChannelData {
  const raw = toRecord(payload.channelData)?.matrix;
  return (toRecord(raw) as MatrixChannelData | undefined) ?? {};
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
  const extraContent = toRecord(resolveMatrixChannelData(payload).extraContent);
  const presentation = toRecord(extraContent?.[MATRIX_OPENCLAW_PRESENTATION_KEY]);
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

function resolveMatrixPayloadText(payload: ReplyPayload): string {
  const text = payload.text ?? "";
  if (text.trim() || !resolveMatrixPresentationContent(payload)) {
    return text;
  }
  return MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT;
}

function resolveMatrixExtraContent(payload: ReplyPayload): MatrixExtraContentFields | undefined {
  const presentation = resolveMatrixPresentationContent(payload);
  return presentation ? { [MATRIX_OPENCLAW_PRESENTATION_KEY]: presentation } : undefined;
}

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
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
      let lastResult: Awaited<ReturnType<typeof send>> | undefined;
      for (let i = 0; i < urls.length; i++) {
        const isFirst = i === 0;
        lastResult = await send(to, isFirst ? payloadText : "", {
          cfg,
          mediaUrl: urls[i],
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          replyToId: resolveReplyToId(),
          threadId: resolvedThreadId,
          accountId: accountId ?? undefined,
          audioAsVoice: payload.audioAsVoice ?? audioAsVoice,
          extraContent: isFirst ? resolveMatrixExtraContent(payload) : undefined,
        });
      }
      return {
        channel: "matrix",
        messageId: lastResult!.messageId,
        roomId: lastResult!.roomId,
      };
    }
    const result = await send(to, payloadText, {
      cfg,
      mediaUrl: payload.mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      replyToId: resolveReplyToId(),
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice: payload.audioAsVoice ?? audioAsVoice,
      extraContent: resolveMatrixExtraContent(payload),
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId, audioAsVoice }) => {
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
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    deps,
    replyToId,
    threadId,
    accountId,
    audioAsVoice,
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
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
      audioAsVoice,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
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
