// Discord plugin module implements outbound payload behavior.
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  resolveDiscordComponentSpec,
  sendDiscordComponentMessageLazy,
} from "./outbound-components.js";
import { createDiscordPayloadSendContext } from "./outbound-send-context.js";
import { createDiscordSendReceipt } from "./send.receipt.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "./send.shared.js";

type DiscordOutboundPayloadContext = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0];
type DiscordPayloadSendContext = Awaited<ReturnType<typeof createDiscordPayloadSendContext>>;

function createDiscordUnknownPayloadResult(target: string) {
  return {
    messageId: "",
    channelId: target,
    receipt: createDiscordSendReceipt({
      platformMessageIds: [],
      channelId: target,
      kind: "unknown",
    }),
  };
}

function resolveDiscordDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
) {
  return {
    replyTo: sendContext.resolveReplyTo(),
    accountId: ctx.accountId ?? undefined,
    silent: ctx.silent ?? undefined,
    cfg: ctx.cfg,
  };
}

function resolveDiscordFormattedDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
) {
  return {
    ...resolveDiscordDeliveryOptions(ctx, sendContext),
    ...sendContext.formatting,
  };
}

function resolveDiscordMediaDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  mediaUrl: string,
) {
  return {
    mediaUrl,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
  };
}

export async function sendDiscordOutboundPayload(params: {
  ctx: DiscordOutboundPayloadContext;
  fallbackAdapter: ChannelOutboundAdapter;
}): Promise<Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>> {
  const ctx = params.ctx;
  const payload = normalizeDiscordApprovalPayload({
    ...ctx.payload,
    text: ctx.payload.text ?? "",
  });
  const mediaUrls = resolvePayloadMediaUrls(payload);
  const sendContext = await createDiscordPayloadSendContext(ctx);

  if (payload.audioAsVoice && mediaUrls.length > 0) {
    let lastResult = await sendContext.withRetry(
      async () =>
        await sendContext.sendVoice(
          sendContext.target,
          mediaUrls[0],
          resolveDiscordDeliveryOptions(ctx, sendContext),
        ),
    );
    if (payload.text?.trim()) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, payload.text, {
            verbose: false,
            ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
          }),
      );
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, "", {
            verbose: false,
            ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
          }),
      );
    }
    return attachChannelToResult("discord", lastResult);
  }

  const componentSpec = await resolveDiscordComponentSpec(payload);
  if (!componentSpec) {
    const discordData =
      payload.channelData?.discord &&
      typeof payload.channelData.discord === "object" &&
      !Array.isArray(payload.channelData.discord)
        ? (payload.channelData.discord as Record<string, unknown>)
        : {};
    const nativeComponents = Array.isArray(discordData.components)
      ? (discordData.components as DiscordSendComponents)
      : undefined;
    const embeds = Array.isArray(discordData.embeds)
      ? (discordData.embeds as DiscordSendEmbeds)
      : undefined;
    const filename = normalizeOptionalString(discordData.filename);
    if (nativeComponents || embeds?.length || filename) {
      const result = await sendPayloadMediaSequenceOrFallback({
        text: payload.text ?? "",
        mediaUrls,
        fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
        sendNoMedia: async () =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, payload.text ?? "", {
                verbose: false,
                components: nativeComponents,
                embeds,
                filename,
                ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
              }),
          ),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, text, {
                verbose: false,
                ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
                components: isFirst ? nativeComponents : undefined,
                embeds: isFirst ? embeds : undefined,
                filename: isFirst ? filename : undefined,
              }),
          ),
      });
      return attachChannelToResult("discord", result);
    }
    return await sendTextMediaPayload({
      channel: "discord",
      ctx: {
        ...ctx,
        payload,
      },
      adapter: params.fallbackAdapter,
    });
  }

  const result = await sendPayloadMediaSequenceOrFallback({
    text: payload.text ?? "",
    mediaUrls,
    fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
    sendNoMedia: async () =>
      await sendContext.withRetry(
        async () =>
          await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
            ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
          }),
      ),
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendContext.withRetry(
          async () =>
            await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
              ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
            }),
        );
      }
      return await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
          }),
      );
    },
  });
  return attachChannelToResult("discord", result);
}
