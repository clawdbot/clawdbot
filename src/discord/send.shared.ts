import { RequestClient } from "@buape/carbon";
import { PollLayoutType } from "discord-api-types/payloads/v10";
import type { RESTAPIPoll } from "discord-api-types/rest/v10";
import { Routes } from "discord-api-types/v10";

import { loadConfig } from "../config/config.js";
import type { RetryConfig } from "../infra/retry.js";
import { createDiscordRetryRunner, type RetryRunner } from "../infra/retry-policy.js";
import { normalizePollDurationHours, normalizePollInput, type PollInput } from "../polls.js";
import { loadWebMedia } from "../web/media.js";
import { resolveDiscordAccount } from "./accounts.js";
import type { ChunkMode } from "../auto-reply/chunk.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { fetchChannelPermissionsDiscord, isThreadChannelType } from "./send.permissions.js";
import { DiscordSendError } from "./send.types.js";
import { parseDiscordTarget, resolveDiscordTarget } from "./targets.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_MAX_STICKERS = 3;
const DISCORD_POLL_MAX_ANSWERS = 10;
const DISCORD_POLL_MAX_DURATION_HOURS = 32 * 24;
const DISCORD_MISSING_PERMISSIONS = 50013;
const DISCORD_CANNOT_DM = 50007;

type DiscordRequest = RetryRunner;

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

type DiscordClientOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

function resolveToken(params: { explicit?: string; accountId: string; fallbackToken?: string }) {
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
  const target = parseDiscordTarget(raw, {
    ambiguousMessage: `Ambiguous Discord recipient "${raw.trim()}". Use "user:${raw.trim()}" for DMs or "channel:${raw.trim()}" for channel messages.`,
  });
  if (!target) {
    throw new Error("Recipient is required for Discord sends");
  }
  return { kind: target.kind, id: target.id };
}

/**
 * Parse and resolve Discord recipient, including username lookup.
 * This enables sending DMs by username (e.g., "john.doe") by querying
 * the Discord directory to resolve usernames to user IDs.
 *
 * @param raw - The recipient string (username, ID, or known format)
 * @param accountId - Discord account ID to use for directory lookup
 * @returns Parsed DiscordRecipient with resolved user ID if applicable
 */
export async function parseAndResolveRecipient(
  raw: string,
  accountId?: string,
): Promise<DiscordRecipient> {
  const cfg = loadConfig();
  const accountInfo = resolveDiscordAccount({ cfg, accountId });

  // First try to resolve using directory lookup (handles usernames)
  const trimmed = raw.trim();
  const parseOptions = {
    ambiguousMessage: `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
  };

  const resolved = await resolveDiscordTarget(
    raw,
    {
      cfg,
      accountId: accountInfo.accountId,
    },
    parseOptions,
  );

  if (resolved) {
    return { kind: resolved.kind, id: resolved.id };
  }

  // Fallback to standard parsing (for channels, etc.)
  const parsed = parseDiscordTarget(raw, parseOptions);

  if (!parsed) {
    throw new Error("Recipient is required for Discord sends");
  }

  return { kind: parsed.kind, id: parsed.id };
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
  embeds?: unknown[],
  chunkMode?: ChunkMode,
) {
  if (!text.trim()) {
    throw new Error("Message must be non-empty for Discord sends");
  }
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: DISCORD_TEXT_LIMIT,
    maxLines: maxLinesPerMessage,
    chunkMode,
  });
  if (!chunks.length && text) chunks.push(text);
  if (chunks.length === 1) {
    const res = (await request(
      () =>
        rest.post(Routes.channelMessages(channelId), {
          body: {
            content: chunks[0],
            message_reference: messageReference,
            ...(embeds?.length ? { embeds } : {}),
          },
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
            ...(isFirst && embeds?.length ? { embeds } : {}),
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
  embeds?: unknown[],
  chunkMode?: ChunkMode,
) {
  const media = await loadWebMedia(mediaUrl);
  const chunks = text
    ? chunkDiscordTextWithMode(text, {
        maxChars: DISCORD_TEXT_LIMIT,
        maxLines: maxLinesPerMessage,
        chunkMode,
      })
    : [];
  if (!chunks.length && text) chunks.push(text);
  const caption = chunks[0] ?? "";
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
  const res = (await request(
    () =>
      rest.post(Routes.channelMessages(channelId), {
        body: {
          content: caption || undefined,
          message_reference: messageReference,
          ...(embeds?.length ? { embeds } : {}),
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
      undefined,
      chunkMode,
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
  parseRecipient,
  resolveChannelId,
  resolveDiscordRest,
  sendDiscordMedia,
  sendDiscordText,
};
