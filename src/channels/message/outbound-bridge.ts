import { createMessageReceiptFromOutboundResults } from "./receipt.js";
import type {
  ChannelMessageAdapterShape,
  ChannelMessageLiveAdapterShape,
  ChannelMessageReceiveAdapterShape,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
  DurableFinalDeliveryRequirementMap,
  MessageReceipt,
  MessageReceiptPartKind,
  MessageReceiptSourceResult,
} from "./types.js";

const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

export type ChannelMessageOutboundBridgeResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
  messageId?: string;
};

export type ChannelMessageOutboundBridgeAdapter<TConfig = unknown> = {
  deliveryCapabilities?: {
    durableFinal?: DurableFinalDeliveryRequirementMap;
  };
  sendText?: (
    ctx: ChannelMessageSendTextContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  sendMedia?: (
    ctx: ChannelMessageSendMediaContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  sendPayload?: (
    ctx: ChannelMessageSendPayloadContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
};

export type CreateChannelMessageAdapterFromOutboundParams<TConfig = unknown> = {
  id?: string;
  outbound: ChannelMessageOutboundBridgeAdapter<TConfig>;
  capabilities?: DurableFinalDeliveryRequirementMap;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};

function resolveResultMessageId(result: ChannelMessageOutboundBridgeResult): string | undefined {
  return (
    result.messageId ??
    result.receipt?.primaryPlatformMessageId ??
    result.receipt?.platformMessageIds[0] ??
    result.chatId ??
    result.channelId ??
    result.roomId ??
    result.conversationId ??
    result.toJid ??
    result.pollId
  );
}

function toMessageSendResult(
  result: ChannelMessageOutboundBridgeResult,
  params: {
    kind: MessageReceiptPartKind;
    threadId?: string | number | null;
    replyToId?: string | null;
  },
): ChannelMessageSendResult {
  const receipt =
    result.receipt ??
    createMessageReceiptFromOutboundResults({
      results: [result],
      kind: params.kind,
      threadId: params.threadId == null ? undefined : String(params.threadId),
      replyToId: params.replyToId ?? undefined,
    });
  return {
    receipt,
    ...(resolveResultMessageId({ ...result, receipt })
      ? {
          messageId: resolveResultMessageId({ ...result, receipt }),
        }
      : {}),
  };
}

function resolvePayloadReceiptKind(
  ctx: ChannelMessageSendPayloadContext<unknown>,
): MessageReceiptPartKind {
  if (
    ctx.payload.audioAsVoice &&
    (ctx.mediaUrl || ctx.payload.mediaUrl || ctx.payload.mediaUrls?.length)
  ) {
    return "voice";
  }
  if (ctx.mediaUrl || ctx.payload.mediaUrl || ctx.payload.mediaUrls?.length) {
    return "media";
  }
  if (ctx.payload.text?.trim() || ctx.text.trim()) {
    return "text";
  }
  if (ctx.payload.presentation?.blocks?.length || ctx.payload.interactive) {
    return "card";
  }
  return "unknown";
}

export function createChannelMessageAdapterFromOutbound<TConfig = unknown>(
  params: CreateChannelMessageAdapterFromOutboundParams<TConfig>,
): ChannelMessageAdapterShape<TConfig> {
  const send: NonNullable<ChannelMessageAdapterShape<TConfig>["send"]> = {};
  if (params.outbound.sendText) {
    send.text = async (ctx) =>
      toMessageSendResult(await params.outbound.sendText!(ctx), {
        kind: "text",
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }
  if (params.outbound.sendMedia) {
    send.media = async (ctx) =>
      toMessageSendResult(await params.outbound.sendMedia!(ctx), {
        kind: ctx.audioAsVoice ? "voice" : "media",
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }
  if (params.outbound.sendPayload) {
    send.payload = async (ctx) =>
      toMessageSendResult(await params.outbound.sendPayload!(ctx), {
        kind: resolvePayloadReceiptKind(ctx as ChannelMessageSendPayloadContext<unknown>),
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
  }

  return {
    ...(params.id ? { id: params.id } : {}),
    durableFinal: {
      capabilities: params.capabilities ?? params.outbound.deliveryCapabilities?.durableFinal,
    },
    send,
    ...(params.live ? { live: params.live } : {}),
    receive: params.receive ?? defaultManualReceiveAdapter,
  };
}
