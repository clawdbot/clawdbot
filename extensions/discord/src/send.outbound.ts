import type { APIChannel, APIGuildForumChannel, APIGuildMediaChannel } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess, PollInput } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveChunkMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createChannelMessage, createThread, type RequestClient } from "./internal/discord.js";
import { prepareDiscordOutboundText } from "./outbound-text.js";
import { parseAndResolveChannelRecipient } from "./recipient-resolution.js";
import {
  createReusableDiscordReplyReference,
  type DiscordReplyReference,
} from "./reply-reference.js";
import {
  createDiscordSendReceiptFromResults,
  createDiscordSendResult,
  type DiscordReceiptResultSource,
} from "./send.receipt.js";
import {
  buildDiscordMessageRequest,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  resolveDiscordMessageFlags,
  resolveDiscordSuppressEmbeds,
  resolveChannelId,
  resolveDiscordChannel,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  type DiscordAllowedMentions,
  type DiscordSendProgress,
  type DiscordSendEmbeds,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
type DiscordSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  filename?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  verbose?: boolean;
  rest?: RequestClient;
  reply?: DiscordReplyReference;
  retry?: RetryConfig;
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  components?: Parameters<typeof resolveDiscordSendComponents>[0]["components"];
  embeds?: DiscordSendEmbeds;
  silent?: boolean;
  threadId?: string | number;
  suppressEmbeds?: boolean;
  allowedMentions?: DiscordAllowedMentions;
  /** Persist each concrete platform send before any later chunk can fail. */
  onDeliveryResult?: (result: DiscordSendResult) => Promise<void> | void;
  /** @internal Refresh durable custody immediately before Discord REST I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** @internal Synchronously fence custody after refresh and immediately before Discord REST I/O. */
  assertPlatformSendAuthorized?: () => void;
};

type DiscordClientRequest = ReturnType<typeof createDiscordClient>["request"];

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;
/** Discord's ChannelFlags.RequireTag is bit 4 on forum/media parent channels. */
const DISCORD_FORUM_REQUIRE_TAG_FLAG = 1 << 4;

function resolveDiscordTextLimit(textLimit: unknown): number | undefined {
  return typeof textLimit === "number" && Number.isFinite(textLimit)
    ? Math.max(1, Math.min(Math.floor(textLimit), 2000))
    : undefined;
}

type DiscordChannelMessageResult = DiscordReceiptResultSource;

async function sendDiscordThreadTextChunks(params: {
  rest: RequestClient;
  threadId: string;
  chunks: readonly string[];
  request: DiscordClientRequest;
  maxLinesPerMessage?: number;
  chunkMode: ReturnType<typeof resolveChunkMode>;
  maxChars?: number;
  silent?: boolean;
  suppressEmbeds?: boolean;
  allowedMentions?: DiscordAllowedMentions;
  onResult?: DiscordSendProgress;
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
}): Promise<void> {
  for (const chunk of params.chunks) {
    await sendDiscordText({
      rest: params.rest,
      channelId: params.threadId,
      text: chunk,
      request: params.request,
      maxLinesPerMessage: params.maxLinesPerMessage,
      chunkMode: params.chunkMode,
      silent: params.silent,
      suppressEmbeds: params.suppressEmbeds,
      allowedMentions: params.allowedMentions,
      maxChars: params.maxChars,
      onResult: params.onResult,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      assertPlatformSendAuthorized: params.assertPlatformSendAuthorized,
    });
  }
}

/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;

/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text: string): string {
  const firstLine =
    normalizeOptionalString(text.split("\n").find((line) => normalizeOptionalString(line))) ?? "";
  return (
    truncateUtf16Safe(firstLine, DISCORD_THREAD_NAME_LIMIT) || new Date().toISOString().slice(0, 16)
  );
}

/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeChannel(
  channel?: APIChannel,
): channel is APIGuildForumChannel | APIGuildMediaChannel {
  return channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
}

function toDiscordSendResult(
  result: DiscordChannelMessageResult,
  fallbackChannelId: string,
  params: {
    kind?: Parameters<typeof createDiscordSendResult>[0]["kind"];
    threadId?: string | number;
    reply?: DiscordReplyReference;
  } = {},
): DiscordSendResult {
  const resultParams: Parameters<typeof createDiscordSendResult>[0] = {
    result,
    fallbackChannelId,
    kind: params.kind ?? "text",
  };
  if (params.threadId != null) {
    resultParams.threadId = params.threadId;
  }
  if (params.reply) {
    resultParams.reply = params.reply;
  }
  return createDiscordSendResult(resultParams);
}

async function resolveDiscordSendTarget(
  to: string,
  opts: DiscordSendOpts,
): Promise<{
  rest: RequestClient;
  request: DiscordClientRequest;
  channelId: string;
  account: ReturnType<typeof createDiscordClient>["account"];
}> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send target resolution");
  const { rest, request, account } = createDiscordClient({ ...opts, cfg });
  const recipient = await parseAndResolveChannelRecipient(to, cfg, account.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  return { rest, request, channelId, account };
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts,
): Promise<DiscordSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send");
  const { token, rest, request, account: accountInfo } = createDiscordClient({ ...opts, cfg });
  const chunkMode = opts.chunkMode ?? resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const maxLinesPerMessage = opts.maxLinesPerMessage ?? accountInfo.config.maxLinesPerMessage;
  const suppressEmbeds = resolveDiscordSuppressEmbeds({
    configured: accountInfo.config.suppressEmbeds,
    override: opts.suppressEmbeds,
  });
  const textLimit = resolveDiscordTextLimit(opts.textLimit);
  const mediaMaxBytes =
    typeof accountInfo.config.mediaMaxMb === "number"
      ? accountInfo.config.mediaMaxMb * 1024 * 1024
      : DEFAULT_DISCORD_MEDIA_MAX_MB * 1024 * 1024;
  const { renderedText, textWithMentions } = prepareDiscordOutboundText(text ?? "", {
    cfg,
    account: accountInfo,
    tableMode: opts.tableMode,
  });
  const recipient = await parseAndResolveChannelRecipient(to, cfg, accountInfo.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  // Forum/Media channels reject POST /messages; auto-create a thread post instead.
  const channel = await resolveDiscordChannel(rest, channelId);
  const deliveredResults: DiscordSendResult[] = [];
  let deliveryThreadId: string | undefined;
  const reportResult: DiscordSendProgress = async (progressResult, kind, replyToId) => {
    const deliveredResult = toDiscordSendResult(progressResult, deliveryThreadId ?? channelId, {
      kind,
      threadId: deliveryThreadId,
      reply: createReusableDiscordReplyReference(replyToId),
    });
    deliveredResults.push(deliveredResult);
    await opts.onDeliveryResult?.(deliveredResult);
  };

  if (isForumLikeChannel(channel)) {
    if (((channel.flags ?? 0) & DISCORD_FORUM_REQUIRE_TAG_FLAG) !== 0) {
      throw new Error(
        `Discord forum channel ${channelId} requires an applied tag; use thread-create with appliedTags, then send to the created thread.`,
      );
    }
    const threadName = deriveForumThreadName(renderedText);
    const chunks = buildDiscordTextChunks(textWithMentions, {
      maxLinesPerMessage,
      chunkMode,
      maxChars: textLimit,
    });
    const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
    const starterComponents = resolveDiscordSendComponents({
      components: opts.components,
      text: starterContent,
      isFirst: true,
    });
    const starterEmbeds = resolveDiscordSendEmbeds({ embeds: opts.embeds, isFirst: true });
    const starterFlags = resolveDiscordMessageFlags({
      silent: opts.silent,
      suppressEmbeds: suppressEmbeds && !starterEmbeds?.length,
    });
    const starterBody = buildDiscordMessageRequest({
      endpoint: "forum-thread",
      text: starterContent,
      components: starterComponents,
      embeds: starterEmbeds,
      flags: starterFlags,
      allowedMentions: opts.allowedMentions,
    });
    let threadRes: { id: string; message?: { id: string; channel_id: string } };
    try {
      threadRes = (await request(
        async () => {
          await opts.onPlatformSendDispatch?.();
          opts.assertPlatformSendAuthorized?.();
          return createThread<{ id: string; message?: { id: string; channel_id: string } }>(
            rest,
            channelId,
            {
              body: {
                name: threadName,
                // Discord clients preselect the parent default; the REST endpoint otherwise
                // falls back to 4320 minutes, so carry the fetched parent value explicitly.
                ...(channel.default_auto_archive_duration === undefined
                  ? {}
                  : { auto_archive_duration: channel.default_auto_archive_duration }),
                message: starterBody,
              },
            },
          );
        },
        "forum-thread",
        { safety: "non-idempotent-create" },
      )) as { id: string; message?: { id: string; channel_id: string } };
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId,
        cfg,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl),
      });
    }

    const threadId = threadRes.id;
    deliveryThreadId = threadId;
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);
    const starterResult = toDiscordSendResult(
      {
        id: messageId,
        channel_id: resultChannelId,
      },
      channelId,
      { kind: "text", threadId },
    );
    deliveredResults.push(starterResult);
    await opts.onDeliveryResult?.(starterResult);

    try {
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia({
          rest,
          channelId: threadId,
          text: mediaCaption ?? "",
          mediaUrl: opts.mediaUrl,
          filename: opts.filename,
          mediaAccess: opts.mediaAccess,
          mediaLocalRoots: opts.mediaLocalRoots,
          mediaReadFile: opts.mediaReadFile,
          maxBytes: mediaMaxBytes,
          request,
          maxLinesPerMessage,
          chunkMode,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          maxChars: textLimit,
          onResult: reportResult,
          onPlatformSendDispatch: opts.onPlatformSendDispatch,
          assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
        });
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: afterMediaChunks,
          request,
          maxLinesPerMessage,
          chunkMode,
          maxChars: textLimit,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          onResult: reportResult,
          onPlatformSendDispatch: opts.onPlatformSendDispatch,
          assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
        });
      } else {
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: remainingChunks,
          request,
          maxLinesPerMessage,
          chunkMode,
          maxChars: textLimit,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          onResult: reportResult,
          onPlatformSendDispatch: opts.onPlatformSendDispatch,
          assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
        });
      }
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId: threadId,
        cfg,
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
      ...starterResult,
      receipt: createDiscordSendReceiptFromResults({ results: deliveredResults, threadId }),
    };
  }

  let result: DiscordChannelMessageResult;
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia({
        rest,
        channelId,
        text: textWithMentions,
        mediaUrl: opts.mediaUrl,
        filename: opts.filename,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        maxBytes: mediaMaxBytes,
        reply: opts.reply,
        request,
        maxLinesPerMessage,
        components: opts.components,
        embeds: opts.embeds,
        chunkMode,
        silent: opts.silent,
        suppressEmbeds,
        allowedMentions: opts.allowedMentions,
        maxChars: textLimit,
        onResult: reportResult,
        onPlatformSendDispatch: opts.onPlatformSendDispatch,
        assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
      });
    } else {
      result = await sendDiscordText({
        rest,
        channelId,
        text: textWithMentions,
        reply: opts.reply,
        request,
        maxLinesPerMessage,
        components: opts.components,
        embeds: opts.embeds,
        chunkMode,
        silent: opts.silent,
        suppressEmbeds,
        allowedMentions: opts.allowedMentions,
        maxChars: textLimit,
        onResult: reportResult,
        onPlatformSendDispatch: opts.onPlatformSendDispatch,
        assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
      });
    }
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      cfg,
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
    ...toDiscordSendResult(result, channelId),
    receipt: createDiscordSendReceiptFromResults({ results: deliveredResults }),
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  const context = await resolveDiscordStructuredSendContext(to, opts);
  const stickers = normalizeStickerIds(stickerIds);
  const body = {
    sticker_ids: stickers,
  };
  return context.send("sticker", body);
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  const context = await resolveDiscordStructuredSendContext(to, opts);
  if (poll.durationSeconds !== undefined) {
    throw new Error("Discord polls do not support durationSeconds; use durationHours");
  }
  const payload = normalizeDiscordPollInput(poll);
  const body = {
    poll: payload,
  };
  return context.send("poll", body);
}

async function resolveDiscordStructuredSendContext(
  to: string,
  opts: DiscordSendOpts & { content?: string },
): Promise<{
  send: (kind: "poll" | "sticker", body: Record<string, unknown>) => Promise<DiscordSendResult>;
}> {
  requireRuntimeConfig(opts.cfg, "Discord structured send");
  const {
    rest,
    request,
    channelId,
    account: accountInfo,
  } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content;
  const preparedContent = content?.trim()
    ? prepareDiscordOutboundText(content, {
        cfg: opts.cfg,
        account: accountInfo,
        tableMode: opts.tableMode,
      }).textWithMentions
    : undefined;
  const suppressEmbeds = resolveDiscordSuppressEmbeds({
    configured: accountInfo.config.suppressEmbeds,
    override: opts.suppressEmbeds,
  });
  const chunkMode = opts.chunkMode ?? resolveChunkMode(opts.cfg, "discord", accountInfo.accountId);
  const maxLinesPerMessage = opts.maxLinesPerMessage ?? accountInfo.config.maxLinesPerMessage;
  const textLimit = resolveDiscordTextLimit(opts.textLimit);
  const contentChunks = preparedContent
    ? buildDiscordTextChunks(preparedContent, {
        maxLinesPerMessage,
        chunkMode,
        maxChars: textLimit,
      })
    : [];
  return {
    send: async (kind, body) => {
      const [structuredContent, ...remainingChunks] = contentChunks;
      // The structured payload belongs to the first caption chunk only. Sending it with tail
      // chunks would create duplicate polls or sticker messages instead of continuing the text.
      // Build once so ambiguous REST retries reuse the same nonce and cannot duplicate it either.
      const structuredRequestBody = {
        ...buildDiscordMessageRequest({
          endpoint: "create-message",
          text: structuredContent ?? "",
          allowedMentions: opts.allowedMentions,
          flags: resolveDiscordMessageFlags({ silent: opts.silent, suppressEmbeds }),
        }),
        ...body,
      };
      const result = (await request(
        async () => {
          await opts.onPlatformSendDispatch?.();
          opts.assertPlatformSendAuthorized?.();
          return createChannelMessage<{ id: string; channel_id: string }>(rest, channelId, {
            body: structuredRequestBody,
          });
        },
        kind,
        { safety: "nonce-protected-create" },
      )) as { id: string; channel_id: string };
      const deliveredResults: DiscordSendResult[] = [];
      const structuredResult = toDiscordSendResult(result, channelId, {
        kind: kind === "poll" ? "poll" : "card",
        threadId: kind === "poll" ? opts.threadId : undefined,
      });
      recordChannelActivity({
        channel: "discord",
        accountId: accountInfo.accountId,
        direction: "outbound",
      });
      deliveredResults.push(structuredResult);
      await opts.onDeliveryResult?.(structuredResult);
      const reportResult: DiscordSendProgress = async (progressResult, progressKind, replyToId) => {
        const deliveredResult = toDiscordSendResult(progressResult, channelId, {
          kind: progressKind,
          reply: createReusableDiscordReplyReference(replyToId),
        });
        deliveredResults.push(deliveredResult);
        await opts.onDeliveryResult?.(deliveredResult);
      };
      for (const chunk of remainingChunks) {
        await sendDiscordText({
          rest,
          channelId,
          text: chunk,
          request,
          maxLinesPerMessage,
          chunkMode,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          maxChars: textLimit,
          onResult: reportResult,
          onPlatformSendDispatch: opts.onPlatformSendDispatch,
          assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
        });
      }
      return {
        ...structuredResult,
        receipt: createDiscordSendReceiptFromResults({ results: deliveredResults }),
      };
    },
  };
}
