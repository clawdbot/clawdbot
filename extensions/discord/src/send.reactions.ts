import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  createOwnMessageReaction,
  deleteOwnMessageReaction,
  getChannelMessage,
  listMessageReactionUsers,
} from "./internal/discord.js";
import {
  buildReactionIdentifier,
  createDiscordClient,
  formatReactionEmoji,
  normalizeReactionEmoji,
} from "./send.shared.js";
import type {
  DiscordReactionRuntimeContext,
  DiscordReactionSummary,
  DiscordReactOpts,
} from "./send.types.js";

function createDiscordReactionRuntimeClient(opts: DiscordReactionRuntimeContext) {
  return createDiscordClient(opts);
}

function resolveDiscordReactionClient(opts: DiscordReactOpts) {
  if (!opts.cfg) {
    throw new Error(
      "Discord reactions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Discord reactions");
  return createDiscordClient({ ...opts, cfg });
}

function isDiscordReactionRuntimeContext(
  opts: DiscordReactOpts,
): opts is DiscordReactionRuntimeContext {
  return Boolean(opts.rest && opts.cfg && opts.accountId);
}

export async function reactMessageDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts,
) {
  const { rest, request } = isDiscordReactionRuntimeContext(opts)
    ? createDiscordReactionRuntimeClient(opts)
    : resolveDiscordReactionClient(opts);
  const encoded = normalizeReactionEmoji(emoji);
  await request(() => createOwnMessageReaction(rest, channelId, messageId, encoded), "react");
  return { ok: true };
}

export async function removeReactionDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts,
) {
  const { rest } = isDiscordReactionRuntimeContext(opts)
    ? createDiscordReactionRuntimeClient(opts)
    : resolveDiscordReactionClient(opts);
  const encoded = normalizeReactionEmoji(emoji);
  await deleteOwnMessageReaction(rest, channelId, messageId, encoded);
  return { ok: true };
}

export async function removeOwnReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts,
): Promise<{ ok: true; removed: string[] }> {
  const { rest } = isDiscordReactionRuntimeContext(opts)
    ? createDiscordReactionRuntimeClient(opts)
    : resolveDiscordReactionClient(opts);
  const message = (await getChannelMessage(rest, channelId, messageId)) as {
    reactions?: Array<{ emoji: { id?: string | null; name?: string | null } }>;
  };
  const identifiers = new Set<string>();
  for (const reaction of message.reactions ?? []) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (identifier) {
      identifiers.add(identifier);
    }
  }
  if (identifiers.size === 0) {
    return { ok: true, removed: [] };
  }
  const removed: string[] = [];
  await Promise.allSettled(
    Array.from(identifiers, (identifier) => {
      removed.push(identifier);
      return deleteOwnMessageReaction(
        rest,
        channelId,
        messageId,
        normalizeReactionEmoji(identifier),
      );
    }),
  );
  return { ok: true, removed };
}

export async function fetchReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts & { limit?: number },
): Promise<DiscordReactionSummary[]> {
  const { rest } = isDiscordReactionRuntimeContext(opts)
    ? createDiscordReactionRuntimeClient(opts)
    : resolveDiscordReactionClient(opts);
  const message = (await getChannelMessage(rest, channelId, messageId)) as {
    reactions?: Array<{
      count: number;
      emoji: { id?: string | null; name?: string | null };
    }>;
  };
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) {
    return [];
  }
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.min(Math.max(Math.floor(opts.limit), 1), 100)
      : 100;

  const summaries: DiscordReactionSummary[] = [];
  for (const reaction of reactions) {
    const identifier = buildReactionIdentifier(reaction.emoji);
    if (!identifier) {
      continue;
    }
    const encoded = encodeURIComponent(identifier);
    const users = await listMessageReactionUsers(rest, channelId, messageId, encoded, {
      limit,
    });
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
