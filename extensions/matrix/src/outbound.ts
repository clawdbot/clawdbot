import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import {
  chunkTextForOutbound,
  resolveOutboundSendDep,
  type ChannelOutboundAdapter,
} from "./runtime-api.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
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
