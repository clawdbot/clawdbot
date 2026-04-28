import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { serializePayload, type MessagePayloadObject, type RequestClient } from "@buape/carbon";
import { ChannelType, Routes } from "discord-api-types/v10";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { maxBytesForKind } from "openclaw/plugin-sdk/media-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-runtime";
import { unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveChunkMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { convertMarkdownTables, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { resolveDiscordAccount } from "./accounts.js";
import { resolveDiscordClientAccountContext } from "./client.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import { parseAndResolveRecipient } from "./recipient-resolution.js";
import {
  buildDiscordMessagePayload,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  resolveChannelId,
  resolveDiscordChannelType,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  stripUndefinedFields,
  SUPPRESS_NOTIFICATIONS_FLAG,
  type DiscordSendComponents,
  type DiscordSendEmbeds,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage,
} from "./voice-message.js";

type DiscordSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  filename?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  components?: DiscordSendComponents;
  embeds?: DiscordSendEmbeds;
  silent?: boolean;
};

type DiscordClientRequest = ReturnType<typeof createDiscordClient>["request"];

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;

type DiscordChannelMessageResult = {
  id?: string | null;
  channel_id?: string | null;
};

async function sendDiscordThreadTextChunks(params: {
  rest: RequestClient;
  threadId: string;
  chunks: readonly string[];
  request: DiscordClientRequest;
  maxLinesPerMessage?: number;
  chunkMode: ReturnType<typeof resolveChunkMode>;
  maxChars?: number;
  silent?: boolean;
}): Promise<void> {
  for (const chunk of params.chunks) {
    await sendDiscordText(
      params.rest,
      params.threadId,
      chunk,
      undefined,
      params.request,
      params.maxLinesPerMessage,
      undefined,
      undefined,
      params.chunkMode,
      params.silent,
      params.maxChars,
    );
  }
}

/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;

/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text: string): string {
  const firstLine =
    normalizeOptionalString(text.split("\n").find((line) => normalizeOptionalString(line))) ?? "";
  return firstLine.slice(0, DISCORD_THREAD_NAME_LIMIT) || new Date().toISOString().slice(0, 16);
}

/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeType(channelType?: number): boolean {
  return channelType === ChannelType.GuildForum || channelType === ChannelType.GuildMedia;
}

function toDiscordSendResult(
  result: DiscordChannelMessageResult,
  fallbackChannelId: string,
): DiscordSendResult {
  return {
    messageId: result.id || "unknown",
    channelId: result.channel_id ?? fallbackChannelId,
  };
}

async function resolveDiscordSendTarget(
  to: string,
  opts: DiscordSendOpts,
): Promise<{ rest: RequestClient; request: DiscordClientRequest; channelId: string }> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send target resolution");
  const { rest, request } = createDiscordClient({ ...opts, cfg });
  const recipient = await parseAndResolveRecipient(to, cfg, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  return { rest, request, channelId };
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts,
): Promise<DiscordSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send");
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId: accountInfo.accountId,
  });
  const effectiveTableMode = opts.tableMode ?? tableMode;
  const chunkMode = opts.chunkMode ?? resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const maxLinesPerMessage = opts.maxLinesPerMessage ?? accountInfo.config.maxLinesPerMessage;
  const textLimit =
    typeof opts.textLimit === "number" && Number.isFinite(opts.textLimit)
      ? Math.max(1, Math.min(Math.floor(opts.textLimit), 2000))
      : undefined;
  const mediaMaxBytes =
    typeof accountInfo.config.mediaMaxMb === "number"
      ? accountInfo.config.mediaMaxMb * 1024 * 1024
      : DEFAULT_DISCORD_MEDIA_MAX_MB * 1024 * 1024;
  const textWithTables = convertMarkdownTables(text ?? "", effectiveTableMode);
  const textWithMentions = rewriteDiscordKnownMentions(textWithTables, {
    accountId: accountInfo.accountId,
  });
  const { token, rest, request } = createDiscordClient({ ...opts, cfg });
  const recipient = await parseAndResolveRecipient(to, cfg, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  // Forum/Media channels reject POST /messages; auto-create a thread post instead.
  const channelType = await resolveDiscordChannelType(rest, channelId);

  if (isForumLikeType(channelType)) {
    const threadName = deriveForumThreadName(textWithTables);
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
    const silentFlags = opts.silent ? 1 << 12 : undefined;
    const starterPayload: MessagePayloadObject = buildDiscordMessagePayload({
      text: starterContent,
      components: starterComponents,
      embeds: starterEmbeds,
      flags: silentFlags,
    });
    let threadRes: { id: string; message?: { id: string; channel_id: string } };
    try {
      threadRes = (await request(
        () =>
          rest.post(Routes.threads(channelId), {
            body: {
              name: threadName,
              message: stripUndefinedFields(serializePayload(starterPayload)),
            },
          }) as Promise<{ id: string; message?: { id: string; channel_id: string } }>,
        "forum-thread",
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
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);

    try {
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia(
          rest,
          threadId,
          mediaCaption ?? "",
          opts.mediaUrl,
          opts.filename,
          opts.mediaLocalRoots,
          opts.mediaReadFile,
          mediaMaxBytes,
          undefined,
          request,
          maxLinesPerMessage,
          undefined,
          undefined,
          chunkMode,
          opts.silent,
          textLimit,
        );
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: afterMediaChunks,
          request,
          maxLinesPerMessage,
          chunkMode,
          maxChars: textLimit,
          silent: opts.silent,
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
    return toDiscordSendResult(
      {
        id: messageId,
        channel_id: resultChannelId,
      },
      channelId,
    );
  }

  let result: { id: string; channel_id: string } | { id: string | null; channel_id: string };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        textWithMentions,
        opts.mediaUrl,
        opts.filename,
        opts.mediaLocalRoots,
        opts.mediaReadFile,
        mediaMaxBytes,
        opts.replyTo,
        request,
        maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent,
        textLimit,
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        textWithMentions,
        opts.replyTo,
        request,
        maxLinesPerMessage,
        opts.components,
        opts.embeds,
        chunkMode,
        opts.silent,
        textLimit,
      );
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
  return toDiscordSendResult(result, channelId);
}

type DiscordWebhookSendOpts = {
  cfg: OpenClawConfig;
  webhookId: string;
  webhookToken: string;
  accountId?: string;
  threadId?: string | number;
  replyTo?: string;
  username?: string;
  avatarUrl?: string;
  wait?: boolean;
};

function resolveWebhookExecutionUrl(params: {
  webhookId: string;
  webhookToken: string;
  threadId?: string | number;
  wait?: boolean;
}) {
  const baseUrl = new URL(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}`,
  );
  baseUrl.searchParams.set("wait", params.wait === false ? "false" : "true");
  if (params.threadId !== undefined && params.threadId !== null && params.threadId !== "") {
    baseUrl.searchParams.set("thread_id", String(params.threadId));
  }
  return baseUrl.toString();
}

export async function sendWebhookMessageDiscord(
  text: string,
  opts: DiscordWebhookSendOpts,
): Promise<DiscordSendResult> {
  const webhookId = normalizeOptionalString(opts.webhookId) ?? "";
  const webhookToken = normalizeOptionalString(opts.webhookToken) ?? "";
  if (!webhookId || !webhookToken) {
    throw new Error("Discord webhook id/token are required");
  }

  const replyTo = normalizeOptionalString(opts.replyTo) ?? "";
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
  const { account, proxyFetch } = resolveDiscordClientAccountContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const rewrittenText = rewriteDiscordKnownMentions(text, {
    accountId: account.accountId,
  });

  const response = await (proxyFetch ?? fetch)(
    resolveWebhookExecutionUrl({
      webhookId,
      webhookToken,
      threadId: opts.threadId,
      wait: opts.wait,
    }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: rewrittenText,
        username: normalizeOptionalString(opts.username),
        avatar_url: normalizeOptionalString(opts.avatarUrl),
        ...(messageReference ? { message_reference: messageReference } : {}),
      }),
    },
  );
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(
      `Discord webhook send failed (${response.status}${raw ? `: ${raw.slice(0, 200)}` : ""})`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    channel_id?: string;
  };
  try {
    recordChannelActivity({
      channel: "discord",
      accountId: account.accountId,
      direction: "outbound",
    });
  } catch {
    // Best-effort telemetry only.
  }
  return {
    messageId: payload.id || "unknown",
    channelId: payload.channel_id ? payload.channel_id : opts.threadId ? String(opts.threadId) : "",
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  const { rest, request, channelId, rewrittenContent } = await resolveDiscordStructuredSendContext(
    to,
    opts,
  );
  const stickers = normalizeStickerIds(stickerIds);
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: rewrittenContent || undefined,
          sticker_ids: stickers,
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "sticker",
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId);
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  const { rest, request, channelId, rewrittenContent } = await resolveDiscordStructuredSendContext(
    to,
    opts,
  );
  if (poll.durationSeconds !== undefined) {
    throw new Error("Discord polls do not support durationSeconds; use durationHours");
  }
  const payload = normalizeDiscordPollInput(poll);
  const flags = opts.silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: rewrittenContent || undefined,
          poll: payload,
          ...(flags ? { flags } : {}),
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "poll",
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId);
}

async function resolveDiscordStructuredSendContext(
  to: string,
  opts: DiscordSendOpts & { content?: string },
): Promise<{
  rest: RequestClient;
  request: DiscordClientRequest;
  channelId: string;
  rewrittenContent?: string;
}> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord structured send");
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  const rewrittenContent = content
    ? rewriteDiscordKnownMentions(content, {
        accountId: accountInfo.accountId,
      })
    : undefined;
  return { rest, request, channelId, rewrittenContent };
}

type VoiceMessageOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
  silent?: boolean;
};

async function materializeVoiceMessageInput(mediaUrl: string): Promise<{ filePath: string }> {
  // Security: reuse the standard media loader so we apply SSRF guards + allowed-local-root checks.
  // Then write to a private temp file so ffmpeg/ffprobe never sees the original URL/path string.
  const media = await loadWebMediaRaw(mediaUrl, maxBytesForKind("audio"));
  const extFromName = media.fileName ? path.extname(media.fileName) : "";
  const extFromMime = media.contentType ? extensionForMime(media.contentType) : "";
  const ext = extFromName || extFromMime || ".bin";
  const tempDir = resolvePreferredOpenClawTmpDir();
  const filePath = path.join(tempDir, `voice-src-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(filePath, media.buffer, { mode: 0o600 });
  return { filePath };
}

/**
 * Send a voice message to Discord.
 *
 * Voice messages are a special Discord feature that displays audio with a waveform
 * visualization. They require OGG/Opus format and cannot include text content.
 *
 * @param to - Recipient (user ID for DM or channel ID)
 * @param audioPath - Path to local audio file (will be converted to OGG/Opus if needed)
 * @param opts - Send options
 */
export async function sendVoiceMessageDiscord(
  to: string,
  audioPath: string,
  opts: VoiceMessageOpts,
): Promise<DiscordSendResult> {
  const { filePath: localInputPath } = await materializeVoiceMessageInput(audioPath);
  let oggPath: string | null = null;
  let oggCleanup = false;
  let token: string | undefined;
  let rest: RequestClient | undefined;
  let channelId: string | undefined;
  const cfg = requireRuntimeConfig(opts.cfg, "Discord voice send");

  try {
    const accountInfo = resolveDiscordAccount({
      cfg,
      accountId: opts.accountId,
    });
    const client = createDiscordClient({ ...opts, cfg });
    token = client.token;
    rest = client.rest;
    const request = client.request;
    const recipient = await parseAndResolveRecipient(to, cfg, opts.accountId);
    channelId = (await resolveChannelId(rest, recipient, request)).channelId;

    // Convert to OGG/Opus if needed
    const ogg = await ensureOggOpus(localInputPath);
    oggPath = ogg.path;
    oggCleanup = ogg.cleanup;

    // Get voice message metadata (duration and waveform)
    const metadata = await getVoiceMessageMetadata(oggPath);

    // Read the audio file
    const audioBuffer = await fs.readFile(oggPath);

    // Send the voice message
    const result = await sendDiscordVoiceMessage(
      rest,
      channelId,
      audioBuffer,
      metadata,
      opts.replyTo,
      request,
      opts.silent,
      token,
    );

    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound",
    });

    return toDiscordSendResult(result, channelId);
  } catch (err) {
    if (channelId && rest && token) {
      throw await buildDiscordSendError(err, {
        channelId,
        cfg,
        rest,
        token,
        hasMedia: true,
      });
    }
    throw err;
  } finally {
    await unlinkIfExists(oggCleanup ? oggPath : null);
    await unlinkIfExists(localInputPath);
  }
}
