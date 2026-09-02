// Irc plugin module implements message adapter behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  createReplyToFanout,
  defineChannelMessageAdapter,
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

async function sendIrcMessage(...args: Parameters<typeof sendMessageIrc>) {
  return toIrcMessageResult(await sendMessageIrc(...args));
}

export const sendFormattedIrcText: NonNullable<
  ChannelOutboundAdapter["sendFormattedText"]
> = async (ctx) => {
  const { chunkMarkdownTextWithMode, resolveChunkMode, resolveTextChunkLimit } =
    await import("openclaw/plugin-sdk/reply-chunking");
  const accountId = ctx.accountId ?? undefined;
  const textLimit =
    ctx.formatting?.textLimit ??
    resolveTextChunkLimit(ctx.cfg, "irc", accountId, {
      fallbackLimit: ircOutboundBaseAdapter.textChunkLimit,
    });
  const chunkMode = ctx.formatting?.chunkMode ?? resolveChunkMode(ctx.cfg, "irc", accountId);
  const chunkText = (text: string) =>
    ctx.formatting
      ? ircOutboundBaseAdapter.chunker(text, textLimit, { formatting: ctx.formatting })
      : ircOutboundBaseAdapter.chunker(text, textLimit);
  let chunks: string[];
  if (chunkMode === "newline") {
    const blocks = chunkMarkdownTextWithMode(ctx.text, textLimit, chunkMode);
    if (blocks.length === 0 && ctx.text) {
      blocks.push(ctx.text);
    }
    chunks = blocks.flatMap((block) => {
      const blockChunks = chunkText(block);
      return blockChunks.length === 0 && block ? [block] : blockChunks;
    });
  } else {
    chunks = chunkText(ctx.text);
  }

  const nextReplyToId = createReplyToFanout(ctx);
  const results = await sendIrcMessages(
    ctx.to,
    chunks.map((text) => {
      const replyTo = nextReplyToId();
      return replyTo ? { text, replyTo } : { text };
    }),
    {
      cfg: ctx.cfg,
      accountId,
      abortSignal: ctx.abortSignal,
      onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    },
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
    text: async ({ cfg, to, text, accountId, replyToId }) =>
      await sendIrcMessage(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
      await sendIrcMessage(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
  },
});
