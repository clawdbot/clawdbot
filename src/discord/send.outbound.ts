import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import type { RetryConfig } from "../infra/retry.js";
import type { PollInput } from "../polls.js";
import { resolveDiscordAccount } from "./accounts.js";
import {
  buildDiscordSendError,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  parseAndResolveRecipient,
  resolveChannelId,
  sendDiscordMedia,
  sendDiscordText,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";

type DiscordSendOpts = {
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  embeds?: unknown[];
};

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId: accountInfo.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const textWithTables = convertMarkdownTables(text ?? "", tableMode);
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  let result: { id: string; channel_id: string } | { id: string | null; channel_id: string };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        textWithTables,
        opts.mediaUrl,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.embeds,
        chunkMode,
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        textWithTables,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
        opts.embeds,
        chunkMode,
      );
    }
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      rest,
      token,
      hasMedia: Boolean(opts.mediaUrl),
    });
  }

  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
  return {
    messageId: result.id ? String(result.id) : "unknown",
    channelId: String(result.channel_id ?? channelId),
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  const content = opts.content?.trim();
  const stickers = normalizeStickerIds(stickerIds);
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: content || undefined,
          sticker_ids: stickers,
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "sticker",
  )) as { id: string; channel_id: string };
  return {
    messageId: res.id ? String(res.id) : "unknown",
    channelId: String(res.channel_id ?? channelId),
  };
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string } = {},
): Promise<DiscordSendResult> {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const recipient = await parseAndResolveRecipient(to, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  const content = opts.content?.trim();
  const payload = normalizeDiscordPollInput(poll);
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: content || undefined,
          poll: payload,
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "poll",
  )) as { id: string; channel_id: string };
  return {
    messageId: res.id ? String(res.id) : "unknown",
    channelId: String(res.channel_id ?? channelId),
  };
}
