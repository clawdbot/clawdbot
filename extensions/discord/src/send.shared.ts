import {
  Embed,
  RequestClient,
  serializePayload,
  type MessagePayloadFile,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "@buape/carbon";
import { PollLayoutType } from "discord-api-types/payloads/v10";
import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import { Routes, type APIChannel, type APIEmbed } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizePollDurationHours,
  normalizePollInput,
  type PollInput,
} from "openclaw/plugin-sdk/media-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import type { RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { createDiscordClient, resolveDiscordRest } from "./client.js";
import { fetchChannelPermissionsDiscord, isThreadChannelType } from "./send.permissions.js";
import { DiscordSendError } from "./send.types.js";

const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 32 * 24;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_CANNOT_DM = 50007;

type DiscordRequest = RetryRunner;

export type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
export type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
export type DiscordSendEmbeds = Array<APIEmbed | Embed>;
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
  const ids = raw.map((entry) => entry.trim()).filter(Boolean);
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
      "discord dm failed: user blocks dms or privacy settings disallow it",
      { kind: "dm-blocked" },
    );
  }
  if (code !== DISCORD_MISSING_PERMISSIONS) {
    return err;
  }

  let missing: string[] = [];
  try {
    const permissions = await fetchChannelPermissionsDiscord(ctx.channelId, {
      rest: ctx.rest,
      token: ctx.token,
      cfg: ctx.cfg,
    });
    const current = new Set(permissions.permissions);
    const required = ["ViewChannel", "SendMessages"];
    if (isThreadChannelType(permissions.channelType)) {
      required.push("SendMessagesInThreads");
    }
    if (ctx.hasMedia) {
      required.push("AttachFiles");
    }
    missing = required.filter((permission) => !current.has(permission));
  } catch {
    /* ignore permission probe errors */
  }

  const missingLabel = missing.length
    ? `missing permissions in channel ${ctx.channelId}: ${missing.join(", ")}`
    : `missing permissions in channel ${ctx.channelId}`;
  return new DiscordSendError(
    `${missingLabel}. bot might be muted or blocked by role/channel overrides`,
    {
      kind: "missing-permissions",
      channelId: ctx.channelId,
      missingPermissions: missing,
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
    () =>
      rest.post(Routes.userChannels(), {
        body: { recipient_id: recipient.id },
      }) as Promise<{ id: string }>,
    "dm-channel",
  )) as { id: string };
  if (!dmChannel?.id) {
    throw new Error("Failed to create Discord DM channel");
  }
  return { channelId: dmChannel.id, dm: true };
}

export async function resolveDiscordChannelType(
  rest: RequestClient,
  channelId: string,
): Promise<number | undefined> {
  try {
    const channel = (await rest.get(Routes.channel(channelId))) as APIChannel | undefined;
    return channel?.type;
  } catch {
    return undefined;
  }
}

// Discord message flag for silent/suppress notifications
export const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;

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

function hasV2Components(components?: TopLevelComponents[]): boolean {
  return Boolean(components?.some((component) => "isV2" in component && component.isV2));
}

export function resolveDiscordSendComponents(params: {
  components?: DiscordSendComponents;
  text: string;
  isFirst: boolean;
}): TopLevelComponents[] | undefined {
  if (!params.components || !params.isFirst) {
    return undefined;
  }
  return typeof params.components === "function"
    ? params.components(params.text)
    : params.components;
}

function normalizeDiscordEmbeds(embeds?: DiscordSendEmbeds): Embed[] | undefined {
  if (!embeds?.length) {
    return undefined;
  }
  return embeds.map((embed) => (embed instanceof Embed ? embed : new Embed(embed)));
}

export function resolveDiscordSendEmbeds(params: {
  embeds?: DiscordSendEmbeds;
  isFirst: boolean;
}): Embed[] | undefined {
  if (!params.embeds || !params.isFirst) {
    return undefined;
  }
  return normalizeDiscordEmbeds(params.embeds);
}

export function buildDiscordMessagePayload(params: {
  text: string;
  components?: TopLevelComponents[];
  embeds?: Embed[];
  flags?: number;
  files?: MessagePayloadFile[];
}): MessagePayloadObject {
  const payload: MessagePayloadObject = {};
  const hasV2 = hasV2Components(params.components);
  const trimmed = params.text.trim();
  if (!hasV2 && trimmed) {
    payload.content = params.text;
  }
  if (params.components?.length) {
    payload.components = params.components;
  }
  if (!hasV2 && params.embeds?.length) {
    payload.embeds = params.embeds;
  }
  if (params.flags !== undefined) {
    payload.flags = params.flags;
  }
  if (params.files?.length) {
    payload.files = params.files;
  }
  return payload;
}

export function stripUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function toDiscordFileBlob(data: Blob | Uint8Array): Blob {
  if (data instanceof Blob) {
    return data;
  }
  const arrayBuffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(arrayBuffer).set(data);
  return new Blob([arrayBuffer]);
}

async function sendDiscordText(
  rest: RequestClient,
  channelId: string,
  text: string,
  replyTo: string | undefined,
  request: DiscordRequest,
  maxLinesPerMessage?: number,
  components?: DiscordSendComponents,
  embeds?: DiscordSendEmbeds,
  chunkMode?: ChunkMode,
  silent?: boolean,
) {
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord sends");
  }
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
  const flags = silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
  const chunks = buildDiscordTextChunks(text, { maxLinesPerMessage, chunkMode });
  const sendChunk = async (chunk: string, isFirst: boolean) => {
    const chunkComponents = resolveDiscordSendComponents({
      components,
      text: chunk,
      isFirst,
    });
    const chunkEmbeds = resolveDiscordSendEmbeds({ embeds, isFirst });
    const payload = buildDiscordMessagePayload({
      text: chunk,
      components: chunkComponents,
      embeds: chunkEmbeds,
      flags,
    });
    const body = stripUndefinedFields({
      ...serializePayload(payload),
      ...(messageReference ? { message_reference: messageReference } : {}),
    });
    return (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body,
        }) as Promise<{ id: string; channel_id: string }>,
      "text",
    )) as { id: string; channel_id: string };
  };
  if (chunks.length === 1) {
    return await sendChunk(chunks[0], true);
  }
  let last: { id: string; channel_id: string } | null = null;
  for (const [index, chunk] of chunks.entries()) {
    last = await sendChunk(chunk, index === 0);
  }
  if (!last) {
    throw new Error("Discord send failed (empty chunk result)");
  }
  return last;
}

async function sendDiscordMedia(
  rest: RequestClient,
  channelId: string,
  text: string,
  mediaUrl: string,
  filename: string | undefined,
  mediaLocalRoots: readonly string[] | undefined,
  mediaReadFile: ((filePath: string) => Promise<Buffer>) | undefined,
  maxBytes: number | undefined,
  replyTo: string | undefined,
  request: DiscordRequest,
  maxLinesPerMessage?: number,
  components?: DiscordSendComponents,
  embeds?: DiscordSendEmbeds,
  chunkMode?: ChunkMode,
  silent?: boolean,
) {
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({ maxBytes, mediaLocalRoots, mediaReadFile }),
  );
  const requestedFileName = filename?.trim();
  const resolvedFileName =
    requestedFileName ||
    media.fileName ||
    (media.contentType ? `upload${extensionForMime(media.contentType) ?? ""}` : "") ||
    "upload";
  const chunks = text ? buildDiscordTextChunks(text, { maxLinesPerMessage, chunkMode }) : [];
  const caption = chunks[0] ?? "";
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
  const flags = silent ? SUPPRESS_NOTIFICATIONS_FLAG : undefined;
  const fileData = toDiscordFileBlob(media.buffer);
  const captionComponents = resolveDiscordSendComponents({
    components,
    text: caption,
    isFirst: true,
  });
  const captionEmbeds = resolveDiscordSendEmbeds({ embeds, isFirst: true });
  const payload = buildDiscordMessagePayload({
    text: caption,
    components: captionComponents,
    embeds: captionEmbeds,
    flags,
    files: [
      {
        data: fileData,
        name: resolvedFileName,
      },
    ],
  });
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: stripUndefinedFields({
          ...serializePayload(payload),
          ...(messageReference ? { message_reference: messageReference } : {}),
        }),
      }) as Promise<{ id: string; channel_id: string }>,
    "media",
  )) as { id: string; channel_id: string };
  for (const chunk of chunks.slice(1)) {
    if (!chunk.trim()) {
      continue;
    }
    await sendDiscordText(
      rest,
      channelId,
      chunk,
      replyTo,
      request,
      maxLinesPerMessage,
      undefined,
      undefined,
      chunkMode,
      silent,
    );
  }
  return res;
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
  resolveDiscordRest,
  sendDiscordMedia,
  sendDiscordText,
};
