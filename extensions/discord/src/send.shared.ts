// Discord plugin module implements send.shared behavior.
import { PollLayoutType } from "discord-api-types/payloads/v10";
import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import type { APIChannel } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizePollDurationHours,
  normalizePollInput,
  type OutboundMediaAccess,
  type PollInput,
} from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { createDiscordClient, resolveDiscordRest, type DiscordClientOpts } from "./client.js";
import {
  createChannelMessage,
  createUserDmChannel,
  getChannel,
  RequestClient,
} from "./internal/discord.js";
import { parseAndResolveRecipient } from "./recipient-resolution.js";
import { resolveDiscordReplyMessageId, type DiscordReplyReference } from "./reply-reference.js";
import type { DiscordRetryRunner } from "./retry.js";
import { fetchChannelPermissionsDiscord, isThreadChannelType } from "./send.permissions.js";
import { DiscordSendError } from "./send.types.js";

const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 32 * 24;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_CANNOT_DM = 50007;
const DISCORD_UPLOAD_TOO_LARGE = 40005;
const DISCORD_UPLOAD_TOO_LARGE_STATUS = 413;
const DISCORD_UPLOAD_TOO_LARGE_NOTICE =
  "Attachment skipped: Discord rejected the file as too large.";

type DiscordRequest = DiscordRetryRunner;

export {
  buildDiscordMessagePayload,
  buildDiscordMessageRequest,
  createDiscordMessageNonce,
  resolveDiscordMessageFlags,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  stripUndefinedFields,
  SUPPRESS_EMBEDS_FLAG,
  SUPPRESS_NOTIFICATIONS_FLAG,
  type DiscordSendComponentFactory,
  type DiscordAllowedMentions,
  type DiscordSendComponents,
  type DiscordSendEmbeds,
} from "./send.message-request.js";
import {
  buildDiscordMessageRequest,
  resolveDiscordMessageFlags,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  type DiscordAllowedMentions,
  type DiscordSendComponents,
  type DiscordSendEmbeds,
} from "./send.message-request.js";
type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

function normalizeReactionEmoji(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("emoji required");
  }
  const customMatch = trimmed.match(/^<a?:([^:>]+):(\d+)>$/);
  const identifier = customMatch
    ? `${customMatch[1]}:${customMatch[2]}`
    : trimmed.replace(/[\uFE0E\uFE0F]/g, "");
  return encodeURIComponent(identifier);
}

function normalizeStickerIds(raw: string[]) {
  const ids = normalizeStringEntries(raw);
  if (ids.length === 0) {
    throw new Error("At least one sticker id is required");
  }
  if (ids.length > DISCORD_MAX_STICKERS) {
    throw new Error("Discord supports up to 3 stickers per message");
  }
  return ids;
}

function normalizeEmojiName(raw: string, label: string) {
  const name = raw.trim();
  if (!name) {
    throw new Error(`${label} is required`);
  }
  return name;
}

function normalizeDiscordPollInput(input: PollInput): RESTAPIPoll {
  const poll = normalizePollInput(input, {
    maxOptions: DISCORD_POLL_MAX_ANSWERS,
  });
  const duration = normalizePollDurationHours(poll.durationHours, {
    defaultHours: 24,
    maxHours: DISCORD_POLL_MAX_DURATION_HOURS,
  });
  return {
    question: { text: poll.question },
    answers: poll.options.map((answer) => ({ poll_media: { text: answer } })),
    duration,
    allow_multiselect: poll.maxSelections > 1,
    layout_type: PollLayoutType.Default,
  };
}

function getDiscordErrorCode(err: unknown) {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    "code" in err && err.code !== undefined
      ? err.code
      : "rawError" in err && err.rawError && typeof err.rawError === "object"
        ? (err.rawError as { code?: unknown }).code
        : undefined;
  if (typeof candidate === "number") {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function getDiscordErrorStatus(err: unknown) {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate =
    "status" in err && err.status !== undefined
      ? err.status
      : "statusCode" in err && err.statusCode !== undefined
        ? err.statusCode
        : undefined;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function isDiscordUploadTooLargeError(err: unknown) {
  return (
    getDiscordErrorCode(err) === DISCORD_UPLOAD_TOO_LARGE ||
    getDiscordErrorStatus(err) === DISCORD_UPLOAD_TOO_LARGE_STATUS
  );
}

function buildDiscordUploadTooLargeFallbackText(text: string) {
  return text.trim()
    ? `${text}\n\n[${DISCORD_UPLOAD_TOO_LARGE_NOTICE}]`
    : DISCORD_UPLOAD_TOO_LARGE_NOTICE;
}

async function buildDiscordSendError(
  err: unknown,
  ctx: {
    channelId: string;
    cfg: OpenClawConfig;
    rest: RequestClient;
    token: string;
    hasMedia: boolean;
  },
) {
  if (err instanceof DiscordSendError) {
    return err;
  }
  const code = getDiscordErrorCode(err);
  if (code === DISCORD_CANNOT_DM) {
    return new DiscordSendError(
      `discord dm failed: user blocks dms or privacy settings disallow it (code=${code})`,
      { kind: "dm-blocked", discordCode: code, status: getDiscordErrorStatus(err) },
    );
  }
  if (code !== DISCORD_MISSING_PERMISSIONS) {
    return err;
  }

  let missing: string[] = [];
  let probedChannelType: number | undefined;
  try {
    const permissions = await fetchChannelPermissionsDiscord(ctx.channelId, {
      rest: ctx.rest,
      token: ctx.token,
      cfg: ctx.cfg,
    });
    probedChannelType = permissions.channelType;
    const current = new Set(permissions.permissions);
    const required = ["ViewChannel", "SendMessages"];
    if (isThreadChannelType(probedChannelType)) {
      required.push("SendMessagesInThreads");
    }
    if (ctx.hasMedia) {
      required.push("AttachFiles");
    }
    missing = required.filter((permission) => !current.has(permission));
  } catch {
    /* ignore permission probe errors */
  }

  const status = getDiscordErrorStatus(err);
  const apiDetails = [`code=${code}`, status != null ? `status=${status}` : undefined]
    .filter(Boolean)
    .join(" ");
  const probedPermissions = ["ViewChannel", "SendMessages"];
  if (isThreadChannelType(probedChannelType)) {
    probedPermissions.push("SendMessagesInThreads");
  }
  if (ctx.hasMedia) {
    probedPermissions.push("AttachFiles");
  }
  const probeSummary = probedPermissions.join("/");
  const missingLabel = missing.length
    ? `discord missing permissions in channel ${ctx.channelId}: ${missing.join(", ")}`
    : `discord missing permissions in channel ${ctx.channelId}; permission probe did not identify missing ${probeSummary}`;
  return new DiscordSendError(
    `${missingLabel} (${apiDetails}). bot might be blocked by channel/thread overrides, archived thread state, reply target visibility, or app-role position`,
    {
      kind: "missing-permissions",
      channelId: ctx.channelId,
      missingPermissions: missing,
      discordCode: code,
      status,
    },
  );
}

async function resolveChannelId(
  rest: RequestClient,
  recipient: DiscordRecipient,
  request: DiscordRequest,
): Promise<{ channelId: string; dm?: boolean }> {
  if (recipient.kind === "channel") {
    return { channelId: recipient.id };
  }
  const dmChannel = (await request(
    () => createUserDmChannel(rest, recipient.id),
    "dm-channel",
  )) as { id: string };
  if (!dmChannel?.id) {
    throw new Error("Failed to create Discord DM channel");
  }
  return { channelId: dmChannel.id, dm: true };
}

async function resolveDiscordTargetChannelId(
  raw: string,
  opts: DiscordClientOpts & { cfg: OpenClawConfig },
): Promise<{ channelId: string; dm?: boolean }> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord target channel resolution");
  const recipient = await parseAndResolveRecipient(raw, cfg, opts.accountId, {
    defaultKind: "channel",
  });
  const { rest, request } = createDiscordClient(opts);
  return await resolveChannelId(rest, recipient, request);
}

export async function resolveDiscordChannel(
  rest: RequestClient,
  channelId: string,
): Promise<APIChannel | undefined> {
  try {
    return await getChannel(rest, channelId);
  } catch {
    return undefined;
  }
}

export function buildDiscordTextChunks(
  text: string,
  opts: { maxLinesPerMessage?: number; chunkMode?: ChunkMode; maxChars?: number } = {},
): string[] {
  if (!text) {
    return [];
  }
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: opts.maxChars ?? DISCORD_TEXT_LIMIT,
    maxLines: opts.maxLinesPerMessage,
    chunkMode: opts.chunkMode,
  });
  return resolveTextChunksWithFallback(text, chunks);
}

export type DiscordSendProgress = (
  result: { id: string; channel_id: string },
  kind: "text" | "media",
  replyToId?: string,
) => Promise<void> | void;

type DiscordTextSendParams = {
  rest: RequestClient;
  channelId: string;
  text: string;
  request: DiscordRequest;
  reply?: DiscordReplyReference;
  maxLinesPerMessage?: number;
  components?: DiscordSendComponents;
  embeds?: DiscordSendEmbeds;
  allowedMentions?: DiscordAllowedMentions;
  chunkMode?: ChunkMode;
  silent?: boolean;
  suppressEmbeds?: boolean;
  maxChars?: number;
  onResult?: DiscordSendProgress;
};

async function sendDiscordText(params: DiscordTextSendParams) {
  const {
    rest,
    channelId,
    text,
    request,
    reply,
    maxLinesPerMessage,
    components,
    embeds,
    allowedMentions,
    chunkMode,
    silent,
    suppressEmbeds,
    maxChars,
    onResult,
  } = params;
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord sends");
  }
  const chunks = buildDiscordTextChunks(text, { maxLinesPerMessage, chunkMode, maxChars });
  const sendChunk = async (chunk: string, isFirst: boolean) => {
    const chunkReplyTo = resolveDiscordReplyMessageId(reply, isFirst);
    const chunkComponents = resolveDiscordSendComponents({
      components,
      text: chunk,
      isFirst,
    });
    const chunkEmbeds = resolveDiscordSendEmbeds({ embeds, isFirst });
    const flags = resolveDiscordMessageFlags({
      silent,
      suppressEmbeds: suppressEmbeds && !chunkEmbeds?.length,
    });
    const body = buildDiscordMessageRequest({
      endpoint: "create-message",
      text: chunk,
      components: chunkComponents,
      embeds: chunkEmbeds,
      allowedMentions,
      flags,
      replyTo: chunkReplyTo,
    });
    const result = (await request(
      () => createChannelMessage<{ id: string; channel_id: string }>(rest, channelId, { body }),
      "text",
      { safety: "nonce-protected-create" },
    )) as { id: string; channel_id: string };
    return { result, replyToId: chunkReplyTo };
  };
  if (chunks.length === 1) {
    const { result, replyToId } = await sendChunk(chunks[0], true);
    await onResult?.(result, "text", replyToId);
    return { ...result, platformMessageIds: result.id ? [result.id] : [] };
  }
  const platformMessageIds: string[] = [];
  let last: { id: string; channel_id: string } | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const sent = await sendChunk(chunk, index === 0);
    last = sent.result;
    await onResult?.(last, "text", sent.replyToId);
    if (last.id) {
      platformMessageIds.push(last.id);
    }
  }
  if (!last) {
    throw new Error("Discord send failed (empty chunk result)");
  }
  return { ...last, platformMessageIds };
}

type DiscordMediaSendParams = DiscordTextSendParams & {
  mediaUrl: string;
  filename?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
};

async function sendDiscordMedia(params: DiscordMediaSendParams) {
  const {
    rest,
    channelId,
    text,
    mediaUrl,
    filename,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    maxBytes,
    reply,
    request,
    maxLinesPerMessage,
    components,
    embeds,
    allowedMentions,
    chunkMode,
    silent,
    suppressEmbeds,
    maxChars,
    onResult,
  } = params;
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({ maxBytes, mediaAccess, mediaLocalRoots, mediaReadFile }),
  );
  const requestedFileName = filename?.trim();
  const resolvedFileName =
    requestedFileName ||
    media.fileName ||
    (media.contentType ? `upload${extensionForMime(media.contentType) ?? ""}` : "") ||
    "upload";
  const chunks = text
    ? buildDiscordTextChunks(text, { maxLinesPerMessage, chunkMode, maxChars })
    : [];
  const caption = chunks[0] ?? "";
  const captionComponents = resolveDiscordSendComponents({
    components,
    text: caption,
    isFirst: true,
  });
  const captionEmbeds = resolveDiscordSendEmbeds({ embeds, isFirst: true });
  const flags = resolveDiscordMessageFlags({
    silent,
    suppressEmbeds: suppressEmbeds && !captionEmbeds?.length,
  });
  const body = buildDiscordMessageRequest({
    endpoint: "create-message",
    text: caption,
    components: captionComponents,
    embeds: captionEmbeds,
    allowedMentions,
    flags,
    replyTo: resolveDiscordReplyMessageId(reply, true),
    files: [
      {
        data: media.buffer,
        name: resolvedFileName,
      },
    ],
  });
  let res: { id: string; channel_id: string };
  try {
    res = (await request(
      () => createChannelMessage<{ id: string; channel_id: string }>(rest, channelId, { body }),
      "media",
      { safety: "nonce-protected-create" },
    )) as { id: string; channel_id: string };
  } catch (err) {
    if (!isDiscordUploadTooLargeError(err)) {
      throw err;
    }
    // The multipart request is all-or-nothing. Retry the portable text only;
    // attachment-coupled embeds/components may be invalid or misleading without it.
    return sendDiscordText({
      rest,
      channelId,
      text: buildDiscordUploadTooLargeFallbackText(text),
      reply,
      request,
      maxLinesPerMessage,
      chunkMode,
      silent,
      suppressEmbeds,
      allowedMentions,
      maxChars,
      onResult,
    });
  }
  await onResult?.(res, "media", reply?.messageId);
  const platformMessageIds = res.id ? [res.id] : [];
  const followupReply = reply?.scope === "all" ? reply : undefined;
  for (const chunk of chunks.slice(1)) {
    if (!chunk.trim()) {
      continue;
    }
    const followup = await sendDiscordText({
      rest,
      channelId,
      text: chunk,
      reply: followupReply,
      request,
      maxLinesPerMessage,
      chunkMode,
      silent,
      suppressEmbeds,
      allowedMentions,
      maxChars,
      onResult,
    });
    for (const id of followup.platformMessageIds) {
      if (id) {
        platformMessageIds.push(id);
      }
    }
  }
  return { ...res, platformMessageIds };
}

function buildReactionIdentifier(emoji: { id?: string | null; name?: string | null }) {
  if (emoji.id && emoji.name) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name ?? "";
}

function formatReactionEmoji(emoji: { id?: string | null; name?: string | null }) {
  return buildReactionIdentifier(emoji);
}

export {
  buildDiscordSendError,
  buildReactionIdentifier,
  createDiscordClient,
  formatReactionEmoji,
  normalizeDiscordPollInput,
  normalizeEmojiName,
  normalizeReactionEmoji,
  normalizeStickerIds,
  resolveChannelId,
  resolveDiscordTargetChannelId,
  resolveDiscordRest,
  sendDiscordMedia,
  sendDiscordText,
};
