/**
 * Legacy outbound bridge adapter.
 *
 * Wraps old channel send functions in the newer channel message adapter contract.
 */
import { createMessageReceiptFromOutboundResults } from "./receipt.js";
import type {
  ChannelMessageAdapterShape,
  ChannelMessageLiveAdapterShape,
  ChannelMessageReceiveAdapterShape,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendPollContext,
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

/** Send result accepted from legacy outbound bridge methods before receipt normalization. */
export type ChannelMessageOutboundBridgeResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
  messageId?: string;
};

/** Legacy outbound adapter shape bridged into the channel message adapter contract. */
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
  sendPoll?: (
    ctx: ChannelMessageSendPollContext<TConfig>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
};

/** Options for building a message adapter from legacy outbound send functions. */
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
    normalizeReceiptKind?: boolean;
    threadId?: string | number | null;
    replyToId?: string | null;
  },
): ChannelMessageSendResult {
  const receipt = result.receipt
    ? params.normalizeReceiptKind
      ? {
          ...result.receipt,
          parts: result.receipt.parts.map((part) => ({ ...part, kind: params.kind })),
        }
      : result.receipt
    : createMessageReceiptFromOutboundResults({
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

/** Converts legacy outbound send methods into a typed channel message adapter. */
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
  if (params.outbound.sendPoll) {
    send.poll = async (ctx) =>
      toMessageSendResult(await params.outbound.sendPoll!(ctx), {
        kind: "poll",
        normalizeReceiptKind: true,
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
