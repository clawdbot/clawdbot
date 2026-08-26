import type { APIEmbed } from "discord-api-types/v10";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
// Discord plugin module implements native command reply behavior.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { chunkDiscordTextWithMode } from "../chunk.js";
import {
  hasDiscordV2Components,
  type ButtonInteraction,
  type CommandInteraction,
  type MessagePayloadFile,
  type StringSelectMenuInteraction,
  type TopLevelComponents,
} from "../internal/discord.js";

export const DISCORD_EMPTY_VISIBLE_REPLY_WARNING = "⚠️ Command produced no visible reply.";

function isDiscordUnknownInteraction(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    discordCode?: number;
    status?: number;
    message?: string;
    rawBody?: { code?: number; message?: string };
  };
  if (err.discordCode === 10062 || err.rawBody?.code === 10062) {
    return true;
  }
  if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) {
    return true;
  }
  if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) {
    return true;
  }
  return false;
}

function resolveDiscordInteractionMessageParts(payload: ReplyPayload) {
  const discordData = payload.channelData?.discord as
    | { components?: TopLevelComponents[]; embeds?: APIEmbed[] }
    | undefined;
  const { components, embeds } = discordData ?? {};
  return {
    components: Array.isArray(components) && components.length > 0 ? components : undefined,
    embeds: Array.isArray(embeds) && embeds.length > 0 ? embeds : undefined,
  };
}

export function hasRenderableReplyPayload(payload: ReplyPayload): boolean {
  const { components, embeds } = resolveDiscordInteractionMessageParts(payload);
  return resolveSendableOutboundReplyParts(payload).hasContent || Boolean(components || embeds);
}

export async function safeDiscordInteractionCall<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isDiscordUnknownInteraction(error)) {
      logVerbose(`discord: ${label} skipped (interaction expired)`);
      return null;
    }
    throw error;
  }
}

export async function settleDiscordInteractionWithoutVisibleReply(
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  // Only slash-command defers create Discord's visible loading response. Component
  // defers own an existing message, so deleting their original response would erase UI.
  if (interaction.responseState !== "deferred") {
    return;
  }
  await safeDiscordInteractionCall("interaction delete deferred reply", () =>
    interaction.deleteReply(),
  );
}

export async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  chunkMode: "length" | "newline";
}): Promise<boolean> {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const reply = resolveSendableOutboundReplyParts(payload);
  let { components: firstMessageComponents, embeds: firstMessageEmbeds } =
    resolveDiscordInteractionMessageParts(payload);

  // Interaction acknowledgement/defer state is not delivery for this payload. Only a
  // successful native send in this invocation can make a later expiry partial.
  let payloadDelivered = false;
  const sendMessage = async (
    content: string,
    files?: MessagePayloadFile[],
    components?: TopLevelComponents[],
    embeds?: APIEmbed[],
  ) => {
    const hasV2 = hasDiscordV2Components(components);
    const payloadLocal = {
      ...(content && !hasV2 ? { content } : {}),
      ...(components ? { components } : {}),
      ...(embeds && !hasV2 ? { embeds } : {}),
      ...(params.responseEphemeral !== undefined ? { ephemeral: params.responseEphemeral } : {}),
      ...(files?.length ? { files } : {}),
    };
    let result: void | null;
    try {
      result = await safeDiscordInteractionCall("interaction send", async () => {
        if (!preferFollowUp && !payloadDelivered) {
          await interaction.reply(payloadLocal);
        } else {
          await interaction.followUp(payloadLocal);
        }
        payloadDelivered = true;
        firstMessageComponents = undefined;
        firstMessageEmbeds = undefined;
      });
    } catch (error) {
      if (!payloadDelivered) {
        throw error;
      }
      throw createChannelPartialDeliveryError(error, { visibleReplySent: true });
    }
    if (result !== null) {
      return;
    }
    const expiry = new PlatformMessageNotDispatchedError(
      "Discord interaction expired before message dispatch",
      { cause: new Error("Unknown interaction") },
    );
    if (!payloadDelivered) {
      throw expiry;
    }
    throw createChannelPartialDeliveryError(expiry, { visibleReplySent: true });
  };

  if (reply.hasMedia) {
    const media = await Promise.all(
      reply.mediaUrls.map(async (url) => {
        const loaded = await loadWebMedia(url, {
          localRoots: params.mediaLocalRoots,
        });
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
          contentType: loaded.contentType,
        };
      }),
    );
    const chunks = resolveTextChunksWithFallback(
      reply.text,
      chunkDiscordTextWithMode(reply.text, {
        maxChars: textLimit,
        maxLines: maxLinesPerMessage,
        chunkMode,
      }),
    );
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media, firstMessageComponents, firstMessageEmbeds);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
      await sendMessage(chunk);
    }
    return payloadDelivered;
  }

  if (!reply.hasText && !firstMessageComponents && !firstMessageEmbeds) {
    return false;
  }
  const chunks = resolveTextChunksWithFallback(
    reply.text,
    chunkDiscordTextWithMode(reply.text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
      chunkMode,
    }),
  );
  if (chunks.length === 0) {
    chunks.push("");
  }
  for (const chunk of chunks) {
    if (!chunk.trim() && !firstMessageComponents && !firstMessageEmbeds) {
      continue;
    }
    await sendMessage(chunk, undefined, firstMessageComponents, firstMessageEmbeds);
  }
  return payloadDelivered;
}
