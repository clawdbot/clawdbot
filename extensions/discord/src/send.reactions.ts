// Discord plugin module implements send.reactions behavior.
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
import type { DiscordReactionSummary, DiscordReactOpts } from "./send.types.js";

function resolveDiscordReactionClient(opts: DiscordReactOpts) {
  if (opts.rest && opts.cfg && opts.accountId) {
    return createDiscordClient(opts);
  }
  if (!opts.cfg) {
    throw new Error(
      "Discord reactions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Discord reactions");
  return createDiscordClient({ ...opts, cfg });
}

export async function reactMessageDiscord(
  channelId: string,
  messageId: string,
  emoji: string,
  opts: DiscordReactOpts,
) {
  const { rest, request } = resolveDiscordReactionClient(opts);
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
  const { rest, request } = resolveDiscordReactionClient(opts);
  const encoded = normalizeReactionEmoji(emoji);
  await request(
    () => deleteOwnMessageReaction(rest, channelId, messageId, encoded),
    "reaction-remove",
  );
  return { ok: true };
}

export async function removeOwnReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts,
): Promise<{ ok: true; removed: string[] }> {
  const { rest, request } = resolveDiscordReactionClient(opts);
  const message = await request(
    () => getChannelMessage(rest, channelId, messageId),
    "reaction-list",
  );
  const identifiers = new Set<string>();
  for (const reaction of message.reactions ?? []) {
    const identifier = reaction.me ? buildReactionIdentifier(reaction.emoji) : undefined;
    if (identifier) {
      identifiers.add(identifier);
    }
  }
  if (identifiers.size === 0) {
    return { ok: true, removed: [] };
  }
  const removed = Array.from(identifiers);
  // Promise.all so a rejected delete propagates: allSettled would swallow the
  // failure and falsely report every identifier as removed.
  await Promise.all(
    removed.map((identifier) =>
      request(
        () =>
          deleteOwnMessageReaction(rest, channelId, messageId, normalizeReactionEmoji(identifier)),
        "reaction-remove",
      ),
    ),
  );
  return { ok: true, removed };
}

export async function fetchReactionsDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts & { limit?: number },
): Promise<DiscordReactionSummary[]> {
  const { rest, request } = resolveDiscordReactionClient(opts);
  const message = await request(
    () => getChannelMessage(rest, channelId, messageId),
    "reaction-list",
  );
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
    const users = await request(
      () => listMessageReactionUsers(rest, channelId, messageId, encoded, { limit }),
      "reaction-users",
    );
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
