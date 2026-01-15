import { chunkMarkdownText } from "../../../src/auto-reply/chunk.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkMarkdownText,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error("Delivering to Matrix requires --to <room|alias|user>"),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text, deps, replyToId, threadId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendMedia: async ({ to, text, mediaUrl, deps, replyToId, threadId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      mediaUrl,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendPoll: async ({ to, poll, threadId }) => {
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await sendPollMatrix(to, poll, {
      threadId: resolvedThreadId,
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      roomId: result.roomId,
      pollId: result.eventId,
    };
  },
};
