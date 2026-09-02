import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
// Discord plugin module implements outbound payload behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  getReplyPayloadTtsSupplement,
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  resolveDiscordComponentSpec,
  sendDiscordComponentMessageLazy,
} from "./outbound-components.js";
import { createDiscordPayloadSendContext } from "./outbound-send-context.js";
import { hasDiscordMessageCreateAmbiguity } from "./retry.js";
import {
  createDiscordSendReceipt,
  createDiscordSendReceiptFromResults,
  toDiscordOutboundDeliveryResult,
} from "./send.receipt.js";
import type { DiscordSendComponents, DiscordSendEmbeds } from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";

type DiscordOutboundPayloadContext = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0];
type DiscordPayloadSendContext = Awaited<ReturnType<typeof createDiscordPayloadSendContext>>;

const log = createSubsystemLogger("discord/outbound");

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
  reply = sendContext.resolveReply(),
) {
  return {
    reply,
    accountId: ctx.accountId ?? undefined,
    silent: ctx.silent ?? undefined,
    cfg: ctx.cfg,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    assertPlatformSendAuthorized: ctx.assertDirectAdapterHandoff,
  };
}

function resolveDiscordFormattedDeliveryOptions(
  ctx: DiscordOutboundPayloadContext,
  sendContext: DiscordPayloadSendContext,
  reply = sendContext.resolveReply(),
) {
  return {
    ...resolveDiscordDeliveryOptions(ctx, sendContext, reply),
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
  const payloadContext = { ...ctx, payload };
  const deliveredResults: DiscordSendResult[] = [];
  let createdThreadId: string | undefined;
  payloadContext.onDeliveryResult = async (result) => {
    await ctx.onDeliveryResult?.(result);
    const threadId = result.receipt?.threadId;
    if (threadId && payloadContext.threadId == null) {
      // A forum starter owns the thread used by every later payload delivery.
      payloadContext.threadId = threadId;
      sendContext.target = `channel:${threadId}`;
      createdThreadId = threadId;
    }
    if (createdThreadId && result.target?.kind === "channel" && result.receipt) {
      deliveredResults.push({
        messageId: result.messageId,
        channelId: result.target.id,
        receipt: result.receipt,
      });
    }
  };
  const completeResult = <T extends { receipt?: DiscordSendResult["receipt"] }>(result: T): T =>
    createdThreadId
      ? {
          ...result,
          receipt: createDiscordSendReceiptFromResults({
            results: deliveredResults,
            threadId: createdThreadId,
          }),
        }
      : result;
  const completeDelivery = (result: DiscordSendResult) =>
    attachChannelToResult("discord", toDiscordOutboundDeliveryResult(completeResult(result)));
  const onDeliveryResult = async (result: DiscordSendResult) =>
    await payloadContext.onDeliveryResult?.(
      attachChannelToResult("discord", toDiscordOutboundDeliveryResult(result)),
    );

  if (payload.audioAsVoice && mediaUrls.length > 0) {
    // Defer voice failure until independent remainder sends finish while preserving progress.
    const voiceReply = sendContext.resolveReply();
    let voiceFailure: { error: unknown } | undefined;
    let lastResult = createDiscordUnknownPayloadResult(sendContext.target);
    try {
      const voiceUrl = expectDefined(mediaUrls.at(0), "non-empty Discord voice media URLs");
      lastResult = await sendContext.sendVoice(sendContext.target, voiceUrl, {
        ...resolveDiscordDeliveryOptions(ctx, sendContext, voiceReply),
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
      });
    } catch (err) {
      // A lost create response can hide a committed voice; a text retry has a different nonce.
      if (hasDiscordMessageCreateAmbiguity(err)) {
        throw err;
      }
      const supplement = getReplyPayloadTtsSupplement(payload);
      const visibleFallbackText = payload.text?.trim() ? payload.text : undefined;
      const hiddenFallbackText = supplement?.visibleTextAlreadyDelivered
        ? undefined
        : supplement?.spokenText;
      const fallbackText = visibleFallbackText ?? hiddenFallbackText;
      if (!fallbackText && !supplement?.visibleTextAlreadyDelivered) {
        throw err;
      }
      log.warn("discord voice send failed; continuing without voice", { error: err });
      if (fallbackText) {
        await sendContext.send(sendContext.target, fallbackText, {
          verbose: false,
          ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext, voiceReply),
          onDeliveryResult,
        });
      }
      voiceFailure = { error: err };
    }
    if (!voiceFailure) {
      await payloadContext.onDeliveryResult?.(
        attachChannelToResult("discord", toDiscordOutboundDeliveryResult(lastResult)),
      );
      if (payload.text?.trim()) {
        lastResult = await sendContext.send(sendContext.target, payload.text, {
          verbose: false,
          ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
          onDeliveryResult,
        });
      }
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      try {
        lastResult = await sendContext.send(sendContext.target, "", {
          verbose: false,
          ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
          onDeliveryResult,
        });
      } catch (err) {
        if (!voiceFailure) {
          throw err;
        }
        // Keep the requested voice failure as the durable outcome while allowing the
        // remaining media loop to finish; later errors must not hide the primary failure.
        log.warn("discord remaining media send failed after voice failure", { error: err });
      }
    }
    if (voiceFailure) {
      throw voiceFailure.error;
    }
    return completeDelivery(lastResult);
  }

  const discordData =
    payload.channelData?.discord &&
    typeof payload.channelData.discord === "object" &&
    !Array.isArray(payload.channelData.discord)
      ? (payload.channelData.discord as Record<string, unknown>)
      : {};
  const filename = normalizeOptionalString(discordData.filename);
  const componentSpec = await resolveDiscordComponentSpec(payload);
  if (!componentSpec) {
    const nativeComponents = Array.isArray(discordData.components)
      ? (discordData.components as DiscordSendComponents)
      : undefined;
    const embeds = Array.isArray(discordData.embeds)
      ? (discordData.embeds as DiscordSendEmbeds)
      : undefined;
    if (nativeComponents || embeds?.length || filename) {
      const result = await sendPayloadMediaSequenceOrFallback({
        text: payload.text ?? "",
        mediaUrls,
        fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
        sendNoMedia: async () =>
          await sendContext.send(sendContext.target, payload.text ?? "", {
            verbose: false,
            components: nativeComponents,
            embeds,
            filename,
            ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
            onDeliveryResult,
          }),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
            components: isFirst ? nativeComponents : undefined,
            embeds: isFirst ? embeds : undefined,
            filename: isFirst ? filename : undefined,
            onDeliveryResult,
          }),
      });
      return completeDelivery(result);
    }
    const result = await sendTextMediaPayload({
      channel: "discord",
      ctx: payloadContext,
      adapter: params.fallbackAdapter,
    });
    return completeResult(result);
  }

  const result = await sendPayloadMediaSequenceOrFallback({
    text: payload.text ?? "",
    mediaUrls,
    fallbackResult: createDiscordUnknownPayloadResult(sendContext.target),
    sendNoMedia: async () => {
      return await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
        ...resolveDiscordFormattedDeliveryOptions(ctx, sendContext),
        filename,
        onDeliveryResult,
      });
    },
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
          ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
          filename,
          onDeliveryResult,
        });
      }
      return await sendContext.send(sendContext.target, text, {
        verbose: false,
        ...resolveDiscordMediaDeliveryOptions(ctx, sendContext, mediaUrl),
        onDeliveryResult,
      });
    },
  });
  return completeDelivery(result);
}
