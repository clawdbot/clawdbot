/**
 * Legacy outbound bridge adapter.
 *
 * Wraps old channel send functions in the newer channel message adapter contract.
 */
import { createMessageReceiptFromOutboundResults, resolveReceiptSourceId } from "./receipt.js";
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
type ChannelMessageOutboundBridgeResult = MessageReceiptSourceResult & {
  receipt?: MessageReceipt;
  messageId?: string;
};

type ChannelMessageOutboundBridgeContext<TContext> = Omit<TContext, "onDeliveryResult"> & {
  onDeliveryResult?: (result: ChannelMessageOutboundBridgeResult) => Promise<void> | void;
};

/** Legacy outbound adapter shape bridged into the channel message adapter contract. */
type ChannelMessageOutboundBridgeAdapter<TConfig = unknown> = {
  deliveryCapabilities?: {
    durableFinal?: DurableFinalDeliveryRequirementMap;
  };
  sendText?: (
    ctx: ChannelMessageOutboundBridgeContext<ChannelMessageSendTextContext<TConfig>>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  sendMedia?: (
    ctx: ChannelMessageOutboundBridgeContext<ChannelMessageSendMediaContext<TConfig>>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  sendPayload?: (
    ctx: ChannelMessageOutboundBridgeContext<ChannelMessageSendPayloadContext<TConfig>>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
  sendPoll?: (
    ctx: ChannelMessageOutboundBridgeContext<ChannelMessageSendPollContext<TConfig>>,
  ) => Promise<ChannelMessageOutboundBridgeResult>;
};

/** Options for building a message adapter from legacy outbound send functions. */
type CreateChannelMessageAdapterFromOutboundParams<TConfig = unknown> = {
  id?: string;
  outbound: ChannelMessageOutboundBridgeAdapter<TConfig>;
  capabilities?: DurableFinalDeliveryRequirementMap;
  live?: ChannelMessageLiveAdapterShape;
  receive?: ChannelMessageReceiveAdapterShape;
};

type MessageSendResultParams = {
  kind: MessageReceiptPartKind;
  normalizeReceiptKind?: boolean;
  threadId?: string | number | null;
  replyToId?: string | null;
};

function toMessageSendResult(
  result: ChannelMessageOutboundBridgeResult,
  params: MessageSendResultParams,
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
  const messageId = resolveReceiptSourceId({ ...result, receipt });
  return {
    // Preserve sanctioned owner facts for delivery hooks without exposing private
    // provider fields or trusting a provider-authored channel identity.
    ...(result.target !== undefined ? { target: result.target } : {}),
    ...(result.chatId !== undefined ? { chatId: result.chatId } : {}),
    ...(result.channelId !== undefined ? { channelId: result.channelId } : {}),
    ...(result.roomId !== undefined ? { roomId: result.roomId } : {}),
    ...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}),
    ...(result.toJid !== undefined ? { toJid: result.toJid } : {}),
    ...(result.pollId !== undefined ? { pollId: result.pollId } : {}),
    ...(result.timestamp !== undefined ? { timestamp: result.timestamp } : {}),
    ...(result.meta !== undefined ? { meta: result.meta } : {}),
    receipt,
    ...(messageId ? { messageId } : {}),
  };
}

function adaptOutboundBridgeContext<
  TContext extends {
    onDeliveryResult?: (result: ChannelMessageSendResult) => Promise<void> | void;
  },
>(
  ctx: TContext,
  resultParams: MessageSendResultParams,
): ChannelMessageOutboundBridgeContext<TContext> {
  const { onDeliveryResult, ...outboundCtx } = ctx;
  return {
    ...outboundCtx,
    ...(onDeliveryResult
      ? {
          onDeliveryResult: async (result: ChannelMessageOutboundBridgeResult) => {
            await onDeliveryResult(toMessageSendResult(result, resultParams));
          },
        }
      : {}),
  };
}

function hasRenderedPresentationBlocks(channelData: Record<string, unknown> | undefined): boolean {
  return Object.values(channelData ?? {}).some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const blocks = (value as Record<string, unknown>).presentationBlocks;
    return Array.isArray(blocks) && blocks.length > 0;
  });
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
  const hasPortablePresentation = Boolean(
    ctx.payload.presentation?.title || ctx.payload.presentation?.blocks?.length,
  );
  if (hasPortablePresentation || hasRenderedPresentationBlocks(ctx.payload.channelData)) {
    return "card";
  }
  if (ctx.payload.interactive) {
    return "card";
  }
  if (ctx.payload.location) {
    return "card";
  }
  if (ctx.payload.text?.trim() || ctx.text.trim()) {
    return "text";
  }
  return "unknown";
}

/** Converts legacy outbound send methods into a typed channel message adapter. */
export function createChannelMessageAdapterFromOutbound<TConfig = unknown>(
  params: CreateChannelMessageAdapterFromOutboundParams<TConfig>,
): ChannelMessageAdapterShape<TConfig> {
  const send: NonNullable<ChannelMessageAdapterShape<TConfig>["send"]> = {};
  if (params.outbound.sendText) {
    send.text = async (ctx) => {
      const resultParams = {
        kind: "text",
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      } satisfies MessageSendResultParams;
      return toMessageSendResult(
        await params.outbound.sendText!(adaptOutboundBridgeContext(ctx, resultParams)),
        resultParams,
      );
    };
  }
  if (params.outbound.sendMedia) {
    send.media = async (ctx) => {
      const resultParams = {
        kind: ctx.audioAsVoice ? "voice" : "media",
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      } satisfies MessageSendResultParams;
      return toMessageSendResult(
        await params.outbound.sendMedia!(adaptOutboundBridgeContext(ctx, resultParams)),
        resultParams,
      );
    };
  }
  if (params.outbound.sendPayload) {
    send.payload = async (ctx) => {
      const resultParams = {
        kind: resolvePayloadReceiptKind(ctx as ChannelMessageSendPayloadContext<unknown>),
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      } satisfies MessageSendResultParams;
      return toMessageSendResult(
        await params.outbound.sendPayload!(adaptOutboundBridgeContext(ctx, resultParams)),
        resultParams,
      );
    };
  }
  if (params.outbound.sendPoll) {
    send.poll = async (ctx) => {
      const resultParams = {
        kind: "poll",
        normalizeReceiptKind: true,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      } satisfies MessageSendResultParams;
      return toMessageSendResult(
        await params.outbound.sendPoll!(adaptOutboundBridgeContext(ctx, resultParams)),
        resultParams,
      );
    };
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
