// Irc plugin module implements message adapter behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  createReplyToFanout,
  defineChannelMessageAdapter,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { sendIrcMessages, sendMessageIrc, type SendIrcResult } from "./send.js";
import type { CoreConfig } from "./types.js";

function toIrcMessageResult({ target, ...result }: SendIrcResult) {
  return {
    ...result,
    target: { kind: "conversation" as const, id: target },
  };
}

async function sendIrcMessage(ctx: ChannelMessageSendTextContext, text = ctx.text) {
  return toIrcMessageResult(
    await sendMessageIrc(ctx.to, text, {
      cfg: ctx.cfg as CoreConfig,
      accountId: ctx.accountId ?? undefined,
      replyTo: ctx.replyToId ?? undefined,
      abortSignal: ctx.signal,
      onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    }),
  );
}

export const sendFormattedIrcText: NonNullable<
  ChannelOutboundAdapter["sendFormattedText"]
> = async (ctx) => {
  const { chunkTextWithMode, resolveChunkMode, resolveTextChunkLimit } =
    await import("openclaw/plugin-sdk/reply-chunking");
  const accountId = ctx.accountId ?? undefined;
  const textLimit =
    ctx.formatting?.textLimit ??
    resolveTextChunkLimit(ctx.cfg, "irc", accountId, {
      fallbackLimit: ircOutboundBaseAdapter.textChunkLimit,
    });
  const chunkMode = ctx.formatting?.chunkMode ?? resolveChunkMode(ctx.cfg, "irc", accountId);
  const nextReplyToId = createReplyToFanout(ctx);
  const results = await sendIrcMessages(
    ctx.to,
    ctx.text,
    {
      cfg: ctx.cfg,
      accountId,
      abortSignal: ctx.abortSignal,
      onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    },
    (preparedText) =>
      chunkTextWithMode(preparedText, textLimit, chunkMode).map((text) => ({
        text,
        replyTo: nextReplyToId(),
      })),
    async (result) => {
      await ctx.onDeliveryResult?.(attachChannelToResult("irc", toIrcMessageResult(result)));
    },
  );
  return results.map((result) => attachChannelToResult("irc", toIrcMessageResult(result)));
};

export const ircMessageAdapter = defineChannelMessageAdapter({
  id: "irc",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
    },
  },
  send: {
    text: sendIrcMessage,
    media: (ctx) =>
      sendIrcMessage(ctx, ctx.mediaUrl ? `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}` : ctx.text),
  },
});
