// Discord plugin module implements send.messages behavior.
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import {
  createChannelMessage,
  createThread,
  deleteChannelMessage,
  editChannelMessage,
  getChannel,
  getChannelMessage,
  listChannelArchivedThreads,
  listGuildActiveThreads,
  listChannelMessages,
  listChannelPins,
  pinChannelMessage,
  searchGuildMessages,
  unpinChannelMessage,
} from "./internal/discord.js";
import { resolveDiscordRest } from "./send.shared.js";
import type {
  DiscordMessageEdit,
  DiscordMessageQuery,
  DiscordReactOpts,
  DiscordSearchQuery,
  DiscordThreadCreate,
  DiscordThreadList,
} from "./send.types.js";

function formatDiscordThreadInitialMessageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDiscordResponseArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Unexpected Discord response for ${label}: expected array.`);
  }
  return value as T[];
}

function assertDiscordResponseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Unexpected Discord response for ${label}: expected object.`);
  }
  return value as Record<string, unknown>;
}

function resolveDefaultThreadAutoArchiveDuration(channel?: APIChannel): number | undefined {
  if (!channel || !("default_auto_archive_duration" in channel)) {
    return undefined;
  }
  return channel.default_auto_archive_duration;
}

export class DiscordThreadInitialMessageError extends Error {
  readonly initialMessageError: string;
  readonly thread: APIChannel;

  constructor(thread: APIChannel, error: unknown) {
    const initialMessageError = formatDiscordThreadInitialMessageError(error);
    super(
      `Discord thread was created, but sending the initial message failed: ${initialMessageError}`,
    );
    this.name = "DiscordThreadInitialMessageError";
    this.initialMessageError = initialMessageError;
    this.thread = thread;
  }
}

export async function readMessagesDiscord(
  channelId: string,
  query: DiscordMessageQuery | undefined,
  opts: DiscordReactOpts,
): Promise<APIMessage[]> {
  const messageQuery = query ?? {};
  const rest = resolveDiscordRest(opts);
  const limit =
    typeof messageQuery.limit === "number" && Number.isFinite(messageQuery.limit)
      ? Math.min(Math.max(Math.floor(messageQuery.limit), 1), 100)
      : undefined;
  const params: Record<string, string | number> = {};
  if (limit) {
    params.limit = limit;
  }
  if (messageQuery.before) {
    params.before = messageQuery.before;
  }
  if (messageQuery.after) {
    params.after = messageQuery.after;
  }
  if (messageQuery.around) {
    params.around = messageQuery.around;
  }
  return assertDiscordResponseArray<APIMessage>(
    await listChannelMessages(rest, channelId, params),
    "message read",
  );
}

export async function fetchMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts,
): Promise<APIMessage> {
  const rest = resolveDiscordRest(opts);
  return await getChannelMessage(rest, channelId, messageId);
}

export async function editMessageDiscord(
  channelId: string,
  messageId: string,
  payload: DiscordMessageEdit,
  opts: DiscordReactOpts,
): Promise<APIMessage> {
  const rest = resolveDiscordRest(opts);
  return await editChannelMessage(rest, channelId, messageId, {
    body: {
      content: payload.content,
      ...(payload.flags !== undefined ? { flags: payload.flags } : {}),
    },
  });
}

export async function deleteMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  await deleteChannelMessage(rest, channelId, messageId);
  return { ok: true };
}

export async function pinMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  await pinChannelMessage(rest, channelId, messageId);
  return { ok: true };
}

export async function unpinMessageDiscord(
  channelId: string,
  messageId: string,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  await unpinChannelMessage(rest, channelId, messageId);
  return { ok: true };
}

export async function listPinsDiscord(
  channelId: string,
  opts: DiscordReactOpts,
): Promise<APIMessage[]> {
  const rest = resolveDiscordRest(opts);
  return await listChannelPins(rest, channelId);
}

export async function createThreadDiscord(
  channelId: string,
  payload: DiscordThreadCreate,
  opts: DiscordReactOpts,
) {
  const rest = resolveDiscordRest(opts);
  const body: Record<string, unknown> = { name: payload.name };
  if (!payload.messageId && payload.type !== undefined) {
    body.type = payload.type;
  }
  let channel: APIChannel | undefined;
  if (!payload.messageId) {
    try {
      channel = await getChannel(rest, channelId);
    } catch {
      // Channel metadata only enriches standalone creation; Discord still validates it.
    }
  }
  // Discord clients preselect the parent default, but REST thread creation needs
  // it explicitly. Keep a caller override authoritative when one was supplied.
  const archiveDuration =
    payload.autoArchiveMinutes ?? resolveDefaultThreadAutoArchiveDuration(channel);
  if (archiveDuration !== undefined) {
    body.auto_archive_duration = archiveDuration;
  }
  const isForumLike =
    channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
  if (isForumLike) {
    const starterContent = payload.content?.trim() ? payload.content : payload.name;
    body.message = { content: starterContent };
    if (payload.appliedTags?.length) {
      body.applied_tags = payload.appliedTags;
    }
  }
  // When creating a standalone thread (no messageId) in a non-forum channel,
  // default to public thread (type 11). Discord defaults to private (type 12)
  // which is unexpected for most users. (#14147)
  if (!payload.messageId && !isForumLike && body.type === undefined) {
    body.type = ChannelType.PublicThread;
  }
  const thread = await createThread(rest, channelId, { body }, payload.messageId);

  // For non-forum channels, send the initial message separately after thread creation.
  // Forum channels handle this via the `message` field in the request body.
  if (!isForumLike && payload.content?.trim() && "id" in thread) {
    try {
      await createChannelMessage(rest, thread.id, {
        body: { content: payload.content },
      });
    } catch (error) {
      throw new DiscordThreadInitialMessageError(thread, error);
    }
  }

  return thread;
}

export async function listThreadsDiscord(payload: DiscordThreadList, opts: DiscordReactOpts) {
  const rest = resolveDiscordRest(opts);
  if (payload.includeArchived) {
    if (!payload.channelId) {
      throw new Error("channelId required to list archived threads");
    }
    const params: Record<string, string | number> = {};
    if (payload.before) {
      params.before = payload.before;
    }
    if (payload.limit) {
      params.limit = payload.limit;
    }
    return await listChannelArchivedThreads(rest, payload.channelId, params);
  }
  return await listGuildActiveThreads(rest, payload.guildId);
}

export async function searchMessagesDiscord(query: DiscordSearchQuery, opts: DiscordReactOpts) {
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
  return assertDiscordResponseObject(
    await searchGuildMessages(rest, query.guildId, params),
    "message search",
  );
}
