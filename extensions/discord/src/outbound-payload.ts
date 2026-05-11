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

export async function sendDiscordOutboundPayload(params: {
  ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
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
        await sendContext.sendVoice(sendContext.target, mediaUrls[0], {
          cfg: ctx.cfg,
          replyTo: sendContext.resolveReplyTo(),
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
        }),
    );
    if (payload.text?.trim()) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, payload.text, {
            verbose: false,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, "", {
            verbose: false,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
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
        fallbackResult: {
          messageId: "",
          channelId: sendContext.target,
          receipt: createDiscordSendReceipt({
            platformMessageIds: [],
            channelId: sendContext.target,
            kind: "unknown",
          }),
        },
        sendNoMedia: async () =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, payload.text ?? "", {
                verbose: false,
                components: nativeComponents,
                embeds,
                filename,
                replyTo: sendContext.resolveReplyTo(),
                accountId: ctx.accountId ?? undefined,
                silent: ctx.silent ?? undefined,
                cfg: ctx.cfg,
                ...sendContext.formatting,
              }),
          ),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, text, {
                verbose: false,
                mediaUrl,
                mediaAccess: ctx.mediaAccess,
                mediaLocalRoots: ctx.mediaLocalRoots,
                mediaReadFile: ctx.mediaReadFile,
                components: isFirst ? nativeComponents : undefined,
                embeds: isFirst ? embeds : undefined,
                filename: isFirst ? filename : undefined,
                replyTo: sendContext.resolveReplyTo(),
                accountId: ctx.accountId ?? undefined,
                silent: ctx.silent ?? undefined,
                cfg: ctx.cfg,
                ...sendContext.formatting,
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
    fallbackResult: {
      messageId: "",
      channelId: sendContext.target,
      receipt: createDiscordSendReceipt({
        platformMessageIds: [],
        channelId: sendContext.target,
        kind: "unknown",
      }),
    },
    sendNoMedia: async () =>
      await sendContext.withRetry(
        async () =>
          await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      ),
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendContext.withRetry(
          async () =>
            await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
              mediaUrl,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
              replyTo: sendContext.resolveReplyTo(),
              accountId: ctx.accountId ?? undefined,
              silent: ctx.silent ?? undefined,
              cfg: ctx.cfg,
              ...sendContext.formatting,
            }),
        );
      }
      return await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    },
  });
  return attachChannelToResult("discord", result);
}
