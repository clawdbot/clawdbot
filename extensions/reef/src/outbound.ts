import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  ChannelOutboundAdapter,
  OutboundDeliveryResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { normalizeReefTarget } from "./config-schema.js";
import { getActiveReef } from "./runtime.js";

async function send(
  to: string,
  text: string,
  threadId?: string | number | null,
  replyToId?: string | null,
): Promise<OutboundDeliveryResult> {
  const peer = normalizeReefTarget(to);
  if (!peer) {
    throw new Error("Reef target must be a handle");
  }
  const id = await getActiveReef().flow.send(peer, text, {
    ...(threadId != null ? { thread: String(threadId) } : {}),
    ...(replyToId ? { replyTo: replyToId } : {}),
  });
  return { channel: "reef", messageId: id, chatId: peer, toJid: `reef:${peer}` };
}

export const reefOutboundAdapter: ChannelOutboundAdapter = {
  // The encrypted flow belongs to the Gateway account lifecycle; other processes must delegate.
  deliveryMode: "gateway",
  textChunkLimit: 32 * 1024,
  deliveryCapabilities: { durableFinal: { text: true, replyTo: true, thread: true } },
  resolveTarget: ({ to }) => {
    const peer = normalizeReefTarget(to ?? "");
    return peer
      ? { ok: true, to: peer }
      : { ok: false, error: new Error("Reef target must be a handle") };
  },
  sendText: async ({ to, text, threadId, replyToId }) => await send(to, text, threadId, replyToId),
};

export const reefMessageAdapter = defineChannelMessageAdapter({
  id: "reef",
  durableFinal: { capabilities: { text: true, replyTo: true, thread: true } },
  send: {
    text: async (ctx) => {
      const result = await send(ctx.to, ctx.text, ctx.threadId, ctx.replyToId);
      const receipt = createMessageReceiptFromOutboundResults({
        results: [result],
        kind: "text",
        ...(ctx.threadId != null ? { threadId: String(ctx.threadId) } : {}),
        ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}),
      });
      return { receipt, messageId: result.messageId };
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
