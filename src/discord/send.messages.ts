import type { APIMessage } from "discord-api-types/v10";
import { Routes } from "discord-api-types/v10";
import { resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordMessageEdit,
  DiscordMessageQuery,
  DiscordReactOpts,
  DiscordSearchQuery,
  DiscordThreadCreate,
  DiscordThreadList,
} from "./send.types.js";

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
  return (await rest.get(Routes.channelMessages(channelId), params)) as APIMessage[];
}

export async function fetchMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts = {},
): Promise<APIMessage> {
  const rest = resolveDiscordRest(opts);
  return (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
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

  // Forum channels require a message object for the initial post
  if (payload.message) {
    body.message = {
      content: payload.message.content,
      ...(payload.message.embeds?.length ? { embeds: payload.message.embeds } : {}),
    };
  }

  // Forum tags
  if (payload.appliedTags?.length) {
    body.applied_tags = payload.appliedTags;
  }

  // For forum channels without messageId, use the channel threads endpoint
  // For regular channels with messageId, use the message-based thread endpoint
  const route = Routes.threads(channelId, payload.messageId);
  return await rest.post(route, { body });
}

export async function listThreadsDiscord(payload: DiscordThreadList, opts: DiscordReactOpts = {}) {
  const rest = resolveDiscordRest(opts);
  if (payload.includeArchived) {
    if (!payload.channelId) {
      throw new Error("channelId required to list archived threads");
    }
    const params: Record<string, string | number> = {};
    if (payload.before) params.before = payload.before;
    if (payload.limit) params.limit = payload.limit;
    return await rest.get(Routes.channelThreads(payload.channelId, "public"), params);
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
  return await rest.get(`/guilds/${query.guildId}/messages/search?${params.toString()}`);
}
