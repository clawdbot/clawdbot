import { RequestClient } from "@buape/carbon";
import { PollLayoutType } from "discord-api-types/payloads/v10";
import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import type {
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIGuildScheduledEvent,
  APIMessage,
  APIRole,
  APIVoiceState,
  RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";
import {
  ChannelType,
  PermissionFlagsBits,
  Routes,
} from "discord-api-types/v10";

import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import type { RetryConfig } from "../infra/retry.js";
import {
  createDiscordRetryRunner,
  type RetryRunner,
} from "../infra/retry-policy.js";
import {
  normalizePollDurationHours,
  normalizePollInput,
  type PollInput,
} from "../polls.js";
import { loadWebMedia, loadWebMediaRaw } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import { chunkDiscordText } from "./chunk.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
const DISCORD_MAX_STICKER_BYTES = 512 * 1024;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 32 * 24;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_CANNOT_DM = 50007;
type DiscordRequest = RetryRunner;

export class DiscordSendError extends Error {
  kind?: "missing-permissions" | "dm-blocked";
  channelId?: string;
  missingPermissions?: string[];

  constructor(message: string, opts?: Partial<DiscordSendError>) {
    super(message);
    this.name = "DiscordSendError";
    if (opts) Object.assign(this, opts);
  }

  override toString() {
    return this.message;
  }
}

const PERMISSION_ENTRIES = Object.entries(PermissionFlagsBits).filter(
  ([, value]) => typeof value === "bigint",
) as Array<[string, bigint]>;

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

type DiscordSendOpts = {
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  verbose?: boolean;
  rest?: RequestClient;
  replyTo?: string;
  retry?: RetryConfig;
};

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
};

export type DiscordReactOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  verbose?: boolean;
  retry?: RetryConfig;
};

export type DiscordReactionUser = {
  id: string;
  username?: string;
  tag?: string;
};

export type DiscordReactionSummary = {
  emoji: { id?: string | null; name?: string | null; raw: string };
  count: number;
  users: DiscordReactionUser[];
};

export type DiscordPermissionsSummary = {
  channelId: string;
  guildId?: string;
  permissions: string[];
  raw: string;
  isDm: boolean;
  channelType?: number;
};

export type DiscordMessageQuery = {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
};

export type DiscordMessageEdit = {
  content: string;
};

export type DiscordThreadCreate = {
  name: string;
  messageId?: string;
  autoArchiveMinutes?: number;
};

export type DiscordThreadList = {
  guildId: string;
  channelId?: string;
  includeArchived?: boolean;
  before?: string;
  limit?: number;
};

export type DiscordSearchQuery = {
  guildId: string;
  content: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
};

export type DiscordRoleChange = {
  guildId: string;
  userId: string;
  roleId: string;
};

export type DiscordModerationTarget = {
  guildId: string;
  userId: string;
  reason?: string;
};

export type DiscordTimeoutTarget = DiscordModerationTarget & {
  durationMinutes?: number;
  until?: string;
};

export type DiscordEmojiUpload = {
  guildId: string;
  name: string;
  mediaUrl: string;
  roleIds?: string[];
};

export type DiscordStickerUpload = {
  guildId: string;
  name: string;
  description: string;
  tags: string;
  mediaUrl: string;
};

export type DiscordChannelCreate = {
  guildId: string;
  name: string;
  type?: number;
  parentId?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
};

export type DiscordChannelEdit = {
  channelId: string;
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
};

export type DiscordChannelMove = {
  guildId: string;
  channelId: string;
  parentId?: string | null;
  position?: number;
};

export type DiscordChannelPermissionSet = {
  channelId: string;
  targetId: string;
  targetType: 0 | 1;
  allow?: string;
  deny?: string;
};

function resolveToken(params: {
  explicit?: string;
  accountId: string;
  fallbackToken?: string;
}) {
  const explicit = normalizeDiscordToken(params.explicit);
  if (explicit) return explicit;
  const fallback = normalizeDiscordToken(params.fallbackToken);
  if (!fallback) {
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function resolveRest(token: string, rest?: RequestClient) {
  return rest ?? new RequestClient(token);
}

type DiscordClientOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function createDiscordClient(opts: DiscordClientOpts, cfg = loadConfig()) {
  const account = resolveDiscordAccount({ cfg, accountId: opts.accountId });
  const token = resolveToken({
    explicit: opts.token,
    accountId: account.accountId,
    fallbackToken: account.token,
  });
  const rest = resolveRest(token, opts.rest);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordClient(opts).rest;
}

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

function parseRecipient(raw: string): DiscordRecipient {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Discord sends");
  }
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return { kind: "user", id: mentionMatch[1] };
  }
  if (trimmed.startsWith("user:")) {
    return { kind: "user", id: trimmed.slice("user:".length) };
  }
  if (trimmed.startsWith("channel:")) {
    return { kind: "channel", id: trimmed.slice("channel:".length) };
  }
  if (trimmed.startsWith("discord:")) {
    return { kind: "user", id: trimmed.slice("discord:".length) };
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1);
    if (!/^\d+$/.test(candidate)) {
      throw new Error(
        "Discord DMs require a user id (use user:<id> or a <@id> mention)",
      );
    }
    return { kind: "user", id: candidate };
  }
  if (/^\d+$/.test(trimmed)) {
    throw new Error(
      `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    );
  }
  return { kind: "channel", id: trimmed };
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

function addPermissionBits(base: bigint, add?: string) {
  if (!add) return base;
  return base | BigInt(add);
}

function removePermissionBits(base: bigint, deny?: string) {
  if (!deny) return base;
  return base & ~BigInt(deny);
}

function bitfieldToPermissions(bitfield: bigint) {
  return PERMISSION_ENTRIES.filter(([, value]) => (bitfield & value) === value)
    .map(([name]) => name)
    .sort();
}

function getDiscordErrorCode(err: unknown) {
  if (!err || typeof err !== "object") return undefined;
  const candidate =
    "code" in err && err.code !== undefined
      ? err.code
      : "rawError" in err && err.rawError && typeof err.rawError === "object"
        ? (err.rawError as { code?: unknown }).code
        : undefined;
  if (typeof candidate === "number") return candidate;
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    return Number(candidate);
  }
  return undefined;
}

function isThreadChannelType(channelType?: number) {
  return (
    channelType === ChannelType.GuildNewsThread ||
    channelType === ChannelType.GuildPublicThread ||
    channelType === ChannelType.GuildPrivateThread
  );
}

async function buildDiscordSendError(
  err: unknown,
  ctx: {
    channelId: string;
    rest: RequestClient;
    token: string;
    hasMedia: boolean;
  },
) {
  if (err instanceof DiscordSendError) return err;
  const code = getDiscordErrorCode(err);
  if (code === DISCORD_CANNOT_DM) {
    return new DiscordSendError(
      "discord dm failed: user blocks dms or privacy settings disallow it",
      { kind: "dm-blocked" },
    );
  }
  if (code !== DISCORD_MISSING_PERMISSIONS) return err;

  let missing: string[] = [];
  try {
    const permissions = await fetchChannelPermissionsDiscord(ctx.channelId, {
      rest: ctx.rest,
      token: ctx.token,
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

async function sendDiscordText(
  rest: RequestClient,
  channelId: string,
  text: string,
  replyTo: string | undefined,
  request: DiscordRequest,
  maxLinesPerMessage?: number,
) {
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord sends");
  }
  const messageReference = replyTo
    ? { message_id: replyTo, fail_if_not_exists: false }
    : undefined;
  const chunks = chunkDiscordText(text, {
    maxChars: DISCORD_TEXT_LIMIT,
    maxLines: maxLinesPerMessage,
  });
  if (chunks.length === 1) {
    const res = (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body: { content: chunks[0], message_reference: messageReference },
        }) as Promise<{ id: string; channel_id: string }>,
      "text",
    )) as { id: string; channel_id: string };
    return res;
  }
  let last: { id: string; channel_id: string } | null = null;
  let isFirst = true;
  for (const chunk of chunks) {
    last = (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body: {
            content: chunk,
            message_reference: isFirst ? messageReference : undefined,
          },
        }) as Promise<{ id: string; channel_id: string }>,
      "text",
    )) as { id: string; channel_id: string };
    isFirst = false;
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
  replyTo: string | undefined,
  request: DiscordRequest,
  maxLinesPerMessage?: number,
) {
  const media = await loadWebMedia(mediaUrl);
  const chunks = text
    ? chunkDiscordText(text, {
        maxChars: DISCORD_TEXT_LIMIT,
        maxLines: maxLinesPerMessage,
      })
    : [];
  const caption = chunks[0] ?? "";
  const messageReference = replyTo
    ? { message_id: replyTo, fail_if_not_exists: false }
    : undefined;
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: caption || undefined,
          message_reference: messageReference,
          files: [
            {
              data: media.buffer,
              name: media.fileName ?? "upload",
            },
          ],
        },
      }) as Promise<{ id: string; channel_id: string }>,
    "media",
  )) as { id: string; channel_id: string };
  for (const chunk of chunks.slice(1)) {
    if (!chunk.trim()) continue;
    await sendDiscordText(
      rest,
      channelId,
      chunk,
      undefined,
      request,
      maxLinesPerMessage,
    );
  }
  return res;
}

function buildReactionIdentifier(emoji: {
  id?: string | null;
  name?: string | null;
}) {
  if (emoji.id && emoji.name) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name ?? "";
}

function formatReactionEmoji(emoji: {
  id?: string | null;
  name?: string | null;
}) {
  return buildReactionIdentifier(emoji);
}

async function fetchBotUserId(rest: RequestClient) {
  const me = (await rest.get(Routes.user("@me"))) as { id?: string };
  if (!me?.id) {
    throw new Error("Failed to resolve bot user id");
  }
  return me.id;
}

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
  const { token, rest, request } = createDiscordClient(opts, cfg);
  const recipient = parseRecipient(to);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  let result:
    | { id: string; channel_id: string }
    | { id: string | null; channel_id: string };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia(
        rest,
        channelId,
        text,
        opts.mediaUrl,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
      );
    } else {
      result = await sendDiscordText(
        rest,
        channelId,
        text,
        opts.replyTo,
        request,
        accountInfo.config.maxLinesPerMessage,
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
  const recipient = parseRecipient(to);
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
  const recipient = parseRecipient(to);
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

export async function reactMessageDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts = {},
) {
  const cfg = loadConfig();
  const { rest, request } = createDiscordClient(opts, cfg);
  const encoded = normalizeReactionEmoji(emoji);
  await request(
    () =>
      rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encoded)),
    "react",
  );
  return { ok: true };
}

export async function removeReactionDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const encoded = normalizeReactionEmoji(emoji);
  await rest.delete(
    Routes.channelMessageOwnReaction(channelId, messageId, encoded),
  );
  return { ok: true };
}

export async function removeOwnReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
): Promise<{ ok: true; removed: string[] }> {
  const rest = resolveDiscordRest(opts);
  const message = (await rest.get(
    Routes.channelMessage(channelId, messageId),
  )) as {
    reactions?: Array<{ emoji: { id?: string | null; name?: string | null } }>;
  };
  const identifiers = new Set<string>();
  for (const reaction of message.reactions ?? []) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (identifier) identifiers.add(identifier);
  }
  if (identifiers.size === 0) return { ok: true, removed: [] };
  const removed: string[] = [];
  await Promise.allSettled(
    Array.from(identifiers, (identifier) => {
      removed.push(identifier);
      return rest.delete(
        Routes.channelMessageOwnReaction(
          channelId,
          messageId,
          normalizeReactionEmoji(identifier),
        ),
      );
    }),
  );
  return { ok: true, removed };
}

export async function fetchReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts & { limit?: number } = {},
): Promise<DiscordReactionSummary[]> {
  const rest = resolveDiscordRest(opts);
  const message = (await rest.get(
    Routes.channelMessage(channelId, messageId),
  )) as {
    reactions?: Array<{
      count: number;
      emoji: { id?: string | null; name?: string | null };
    }>;
  };
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return [];
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.floor(opts.limit), 1), 100)
      : 100;

  const summaries: DiscordReactionSummary[] = [];
  for (const reaction of reactions) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (!identifier) continue;
    const encoded = encodeURIComponent(identifier);
    const users = (await rest.get(
      Routes.channelMessageReaction(channelId, messageId, encoded),
      { limit },
    )) as Array<{ id: string; username?: string; discriminator?: string }>;
    summaries.push({
      emoji: {
        id: reaction.emoji.id ?? null,
        name: reaction.emoji.name ?? null,
        raw: formatReactionEmoji(reaction.emoji),
      },
      count: reaction.count,
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        tag:
          user.username && user.discriminator
            ? `${user.username}#${user.discriminator}`
            : user.username,
      })),
    });
  }
  return summaries;
}

export async function fetchChannelPermissionsDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<DiscordPermissionsSummary> {
  const rest = resolveDiscordRest(opts);
  const channel = (await rest.get(Routes.channel(channelId))) as APIChannel;
  const channelType = "type" in channel ? channel.type : undefined;
  const guildId = "guild_id" in channel ? channel.guild_id : undefined;
  if (!guildId) {
    return {
      channelId,
      permissions: [],
      raw: "0",
      isDm: true,
      channelType,
    };
  }

  const botId = await fetchBotUserId(rest);
  const [guild, member] = await Promise.all([
    rest.get(Routes.guild(guildId)) as Promise<APIGuild>,
    rest.get(Routes.guildMember(guildId, botId)) as Promise<APIGuildMember>,
  ]);

  const rolesById = new Map<string, APIRole>(
    (guild.roles ?? []).map((role) => [role.id, role]),
  );
  const everyoneRole = rolesById.get(guildId);
  let base = 0n;
  if (everyoneRole?.permissions) {
    base = addPermissionBits(base, everyoneRole.permissions);
  }
  for (const roleId of member.roles ?? []) {
    const role = rolesById.get(roleId);
    if (role?.permissions) {
      base = addPermissionBits(base, role.permissions);
    }
  }

  let permissions = base;
  const overwrites =
    "permission_overwrites" in channel
      ? (channel.permission_overwrites ?? [])
      : [];
  for (const overwrite of overwrites) {
    if (overwrite.id === guildId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  for (const overwrite of overwrites) {
    if (member.roles?.includes(overwrite.id)) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }
  for (const overwrite of overwrites) {
    if (overwrite.id === botId) {
      permissions = removePermissionBits(permissions, overwrite.deny ?? "0");
      permissions = addPermissionBits(permissions, overwrite.allow ?? "0");
    }
  }

  return {
    channelId,
    guildId,
    permissions: bitfieldToPermissions(permissions),
    raw: permissions.toString(),
    isDm: false,
    channelType,
  };
}

export async function readMessagesDiscord(
  channelId: string,
  query: DiscordMessageQuery = {},
  opts: DiscordReactOpts = {},
): Promise<APIMessage[]> {
  const rest = resolveDiscordRest(opts);
  const limit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.min(Math.max(Math.floor(query.limit), 1), 100)
      : undefined;
  const params: Record<string, string | number> = {};
  if (limit) params.limit = limit;
  if (query.before) params.before = query.before;
  if (query.after) params.after = query.after;
  if (query.around) params.around = query.around;
  return (await rest.get(
    Routes.channelMessages(channelId),
    params,
  )) as APIMessage[];
}

export async function fetchMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
): Promise<APIMessage> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(
    Routes.channelMessage(channelId, messageId),
  )) as APIMessage;
}

export async function editMessageDiscord(
  channelId: string,
  messageId: string,
  payload: DiscordMessageEdit,
  opts: DiscordReactOpts = {},
): Promise<APIMessage> {
  const rest = resolveDiscordRest(opts);
  return (await rest.patch(Routes.channelMessage(channelId, messageId), {
    body: { content: payload.content },
  })) as APIMessage;
}

export async function deleteMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channelMessage(channelId, messageId));
  return { ok: true };
}

export async function pinMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.put(Routes.channelPin(channelId, messageId));
  return { ok: true };
}

export async function unpinMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channelPin(channelId, messageId));
  return { ok: true };
}

export async function listPinsDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<APIMessage[]> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(Routes.channelPins(channelId))) as APIMessage[];
}

export async function createThreadDiscord(
  channelId: string,
  payload: DiscordThreadCreate,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = { name: payload.name };
  if (payload.autoArchiveMinutes) {
    body.auto_archive_duration = payload.autoArchiveMinutes;
  }
  const route = Routes.threads(channelId, payload.messageId);
  return await rest.post(route, { body });
}

export async function listThreadsDiscord(
  payload: DiscordThreadList,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  if (payload.includeArchived) {
    if (!payload.channelId) {
      throw new Error("channelId required to list archived threads");
    }
    const params: Record<string, string | number> = {};
    if (payload.before) params.before = payload.before;
    if (payload.limit) params.limit = payload.limit;
    return await rest.get(
      Routes.channelThreads(payload.channelId, "public"),
      params,
    );
  }
  return await rest.get(Routes.guildActiveThreads(payload.guildId));
}

export async function searchMessagesDiscord(
  query: DiscordSearchQuery,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const params = new URLSearchParams();
  params.set("content", query.content);
  if (query.channelIds?.length) {
    for (const channelId of query.channelIds) {
      params.append("channel_id", channelId);
    }
  }
  if (query.authorIds?.length) {
    for (const authorId of query.authorIds) {
      params.append("author_id", authorId);
    }
  }
  if (query.limit) {
    const limit = Math.min(Math.max(Math.floor(query.limit), 1), 25);
    params.set("limit", String(limit));
  }
  return await rest.get(
    `/guilds/${query.guildId}/messages/search?${params.toString()}`,
  );
}

export async function listGuildEmojisDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  return await rest.get(Routes.guildEmojis(guildId));
}

export async function uploadEmojiDiscord(
  payload: DiscordEmojiUpload,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const media = await loadWebMediaRaw(
    payload.mediaUrl,
    DISCORD_MAX_EMOJI_BYTES,
  );
  const contentType = media.contentType?.toLowerCase();
  if (
    !contentType ||
    !["image/png", "image/jpeg", "image/jpg", "image/gif"].includes(contentType)
  ) {
    throw new Error("Discord emoji uploads require a PNG, JPG, or GIF image");
  }
  const image = `data:${contentType};base64,${media.buffer.toString("base64")}`;
  const roleIds = (payload.roleIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  return await rest.post(Routes.guildEmojis(payload.guildId), {
    body: {
      name: normalizeEmojiName(payload.name, "Emoji name"),
      image,
      roles: roleIds.length ? roleIds : undefined,
    },
  });
}

export async function uploadStickerDiscord(
  payload: DiscordStickerUpload,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const media = await loadWebMediaRaw(
    payload.mediaUrl,
    DISCORD_MAX_STICKER_BYTES,
  );
  const contentType = media.contentType?.toLowerCase();
  if (
    !contentType ||
    !["image/png", "image/apng", "application/json"].includes(contentType)
  ) {
    throw new Error(
      "Discord sticker uploads require a PNG, APNG, or Lottie JSON file",
    );
  }
  return await rest.post(Routes.guildStickers(payload.guildId), {
    body: {
      name: normalizeEmojiName(payload.name, "Sticker name"),
      description: normalizeEmojiName(
        payload.description,
        "Sticker description",
      ),
      tags: normalizeEmojiName(payload.tags, "Sticker tags"),
      files: [
        {
          data: media.buffer,
          name: media.fileName ?? "sticker",
          contentType,
        },
      ],
    },
  });
}

export async function fetchMemberInfoDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts = {},
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(
    Routes.guildMember(guildId, userId),
  )) as APIGuildMember;
}

export async function fetchRoleInfoDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
): Promise<APIRole[]> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
}

export async function addRoleDiscord(
  payload: DiscordRoleChange,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.put(
    Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId),
  );
  return { ok: true };
}

export async function removeRoleDiscord(
  payload: DiscordRoleChange,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(
    Routes.guildMemberRole(payload.guildId, payload.userId, payload.roleId),
  );
  return { ok: true };
}

export async function fetchChannelInfoDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(Routes.channel(channelId))) as APIChannel;
}

export async function listGuildChannelsDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
): Promise<APIChannel[]> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(Routes.guildChannels(guildId))) as APIChannel[];
}

export async function fetchVoiceStatusDiscord(
  guildId: string,
  userId: string,
  opts: DiscordReactOpts = {},
): Promise<APIVoiceState> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(
    Routes.guildVoiceState(guildId, userId),
  )) as APIVoiceState;
}

export async function listScheduledEventsDiscord(
  guildId: string,
  opts: DiscordReactOpts = {},
): Promise<APIGuildScheduledEvent[]> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(
    Routes.guildScheduledEvents(guildId),
  )) as APIGuildScheduledEvent[];
}

export async function createScheduledEventDiscord(
  guildId: string,
  payload: RESTPostAPIGuildScheduledEventJSONBody,
  opts: DiscordReactOpts = {},
): Promise<APIGuildScheduledEvent> {
  const rest = resolveDiscordRest(opts);
  return (await rest.post(Routes.guildScheduledEvents(guildId), {
    body: payload,
  })) as APIGuildScheduledEvent;
}

export async function timeoutMemberDiscord(
  payload: DiscordTimeoutTarget,
  opts: DiscordReactOpts = {},
): Promise<APIGuildMember> {
  const rest = resolveDiscordRest(opts);
  let until = payload.until;
  if (!until && payload.durationMinutes) {
    const ms = payload.durationMinutes * 60 * 1000;
    until = new Date(Date.now() + ms).toISOString();
  }
  return (await rest.patch(
    Routes.guildMember(payload.guildId, payload.userId),
    {
      body: { communication_disabled_until: until ?? null },
      headers: payload.reason
        ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
        : undefined,
    },
  )) as APIGuildMember;
}

export async function kickMemberDiscord(
  payload: DiscordModerationTarget,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.guildMember(payload.guildId, payload.userId), {
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  return { ok: true };
}

export async function banMemberDiscord(
  payload: DiscordModerationTarget & { deleteMessageDays?: number },
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const deleteMessageDays =
    typeof payload.deleteMessageDays === "number" &&
    Number.isFinite(payload.deleteMessageDays)
      ? Math.min(Math.max(Math.floor(payload.deleteMessageDays), 0), 7)
      : undefined;
  await rest.put(Routes.guildBan(payload.guildId, payload.userId), {
    body:
      deleteMessageDays !== undefined
        ? { delete_message_days: deleteMessageDays }
        : undefined,
    headers: payload.reason
      ? { "X-Audit-Log-Reason": encodeURIComponent(payload.reason) }
      : undefined,
  });
  return { ok: true };
}

// Channel management functions

export async function createChannelDiscord(
  payload: DiscordChannelCreate,
  opts: DiscordReactOpts = {},
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = {
    name: payload.name,
  };
  if (payload.type !== undefined) body.type = payload.type;
  if (payload.parentId) body.parent_id = payload.parentId;
  if (payload.topic) body.topic = payload.topic;
  if (payload.position !== undefined) body.position = payload.position;
  if (payload.nsfw !== undefined) body.nsfw = payload.nsfw;
  return (await rest.post(Routes.guildChannels(payload.guildId), {
    body,
  })) as APIChannel;
}

export async function editChannelDiscord(
  payload: DiscordChannelEdit,
  opts: DiscordReactOpts = {},
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = {};
  if (payload.name !== undefined) body.name = payload.name;
  if (payload.topic !== undefined) body.topic = payload.topic;
  if (payload.position !== undefined) body.position = payload.position;
  if (payload.parentId !== undefined) body.parent_id = payload.parentId;
  if (payload.nsfw !== undefined) body.nsfw = payload.nsfw;
  if (payload.rateLimitPerUser !== undefined)
    body.rate_limit_per_user = payload.rateLimitPerUser;
  return (await rest.patch(Routes.channel(payload.channelId), {
    body,
  })) as APIChannel;
}

export async function deleteChannelDiscord(
  channelId: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(Routes.channel(channelId));
  return { ok: true, channelId };
}

export async function moveChannelDiscord(
  payload: DiscordChannelMove,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const body: Array<Record<string, unknown>> = [
    {
      id: payload.channelId,
      ...(payload.parentId !== undefined && { parent_id: payload.parentId }),
      ...(payload.position !== undefined && { position: payload.position }),
    },
  ];
  await rest.patch(Routes.guildChannels(payload.guildId), { body });
  return { ok: true };
}

export async function setChannelPermissionDiscord(
  payload: DiscordChannelPermissionSet,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = {
    type: payload.targetType,
  };
  if (payload.allow !== undefined) body.allow = payload.allow;
  if (payload.deny !== undefined) body.deny = payload.deny;
  await rest.put(
    `/channels/${payload.channelId}/permissions/${payload.targetId}`,
    { body },
  );
  return { ok: true };
}

export async function removeChannelPermissionDiscord(
  channelId: string,
  targetId: string,
  opts: DiscordReactOpts = {},
) {
  const rest = resolveDiscordRest(opts);
  await rest.delete(`/channels/${channelId}/permissions/${targetId}`);
  return { ok: true };
}
