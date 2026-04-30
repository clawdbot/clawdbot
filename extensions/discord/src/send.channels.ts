import type { APIChannel } from "discord-api-types/v10";
import {
  createGuildChannel,
  deleteChannel,
  deleteChannelPermission,
  editChannel,
  moveGuildChannels,
  putChannelPermission,
} from "./internal/discord.js";
import { resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordChannelCreate,
  DiscordChannelEdit,
  DiscordChannelMove,
  DiscordChannelPermissionSet,
  DiscordReactOpts,
} from "./send.types.js";

export async function createChannelDiscord(
  payload: DiscordChannelCreate,
  opts: DiscordReactOpts,
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = {
    name: payload.name,
  };
  if (payload.type !== undefined) {
    body.type = payload.type;
  }
  if (payload.parentId) {
    body.parent_id = payload.parentId;
  }
  if (payload.topic) {
    body.topic = payload.topic;
  }
  if (payload.position !== undefined) {
    body.position = payload.position;
  }
  if (payload.nsfw !== undefined) {
    body.nsfw = payload.nsfw;
  }
  return await createGuildChannel(rest, payload.guildId, {
    body,
  });
}

export async function editChannelDiscord(
  payload: DiscordChannelEdit,
  opts: DiscordReactOpts,
): Promise<APIChannel> {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = {};
  if (payload.name !== undefined) {
    body.name = payload.name;
  }
  if (payload.topic !== undefined) {
    body.topic = payload.topic;
  }
  if (payload.position !== undefined) {
    body.position = payload.position;
  }
  if (payload.parentId !== undefined) {
    body.parent_id = payload.parentId;
  }
  if (payload.nsfw !== undefined) {
    body.nsfw = payload.nsfw;
  }
  if (payload.rateLimitPerUser !== undefined) {
    body.rate_limit_per_user = payload.rateLimitPerUser;
  }
  if (payload.archived !== undefined) {
    body.archived = payload.archived;
  }
  if (payload.locked !== undefined) {
    body.locked = payload.locked;
  }
  if (payload.autoArchiveDuration !== undefined) {
    body.auto_archive_duration = payload.autoArchiveDuration;
  }
  if (payload.availableTags !== undefined) {
    body.available_tags = payload.availableTags.map((t) => ({
      ...(t.id !== undefined && { id: t.id }),
      name: t.name,
      ...(t.moderated !== undefined && { moderated: t.moderated }),
      ...(t.emoji_id !== undefined && { emoji_id: t.emoji_id }),
      ...(t.emoji_name !== undefined && { emoji_name: t.emoji_name }),
    }));
  }
  return await editChannel(rest, payload.channelId, {
    body,
  });
}

export async function deleteChannelDiscord(channelId: string, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  await deleteChannel(rest, channelId);
  return { ok: true, channelId };
}

export async function moveChannelDiscord(payload: DiscordChannelMove, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  const body: Array<Record<string, unknown>> = [
    {
      id: payload.channelId,
      ...(payload.parentId !== undefined && { parent_id: payload.parentId }),
      ...(payload.position !== undefined && { position: payload.position }),
    },
  ];
  await moveGuildChannels(rest, payload.guildId, { body });
  return { ok: true };
}

export async function setChannelPermissionDiscord(
  payload: DiscordChannelPermissionSet,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = {
    type: payload.targetType,
  };
  if (payload.allow !== undefined) {
    body.allow = payload.allow;
  }
  if (payload.deny !== undefined) {
    body.deny = payload.deny;
  }
  await putChannelPermission(rest, payload.channelId, payload.targetId, { body });
  return { ok: true };
}

export async function removeChannelPermissionDiscord(
  channelId: string,
  targetId: string,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  await deleteChannelPermission(rest, channelId, targetId);
  return { ok: true };
}
