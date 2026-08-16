// Discord plugin module implements send.messages behavior.
import type { APIChannel, APIMessage } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
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
import { parseDiscordRetryAfterBodySeconds } from "./retry-after.js";
import {
  classifyDiscordDeliveryFailure,
  recordDiscordMessageCreateAmbiguity,
  type DiscordRetryRunner,
} from "./retry.js";
import {
  buildDiscordTextChunks,
  createDiscordClient,
  resolveDiscordRest,
  sendDiscordText,
} from "./send.shared.js";
import type {
  DiscordMessageEdit,
  DiscordMessageQuery,
  DiscordReactOpts,
  DiscordSearchQuery,
  DiscordThreadCreate,
  DiscordThreadList,
} from "./send.types.js";

const DISCORD_THREAD_TRANSPORT_ONLY_MAX_LINES = Number.MAX_SAFE_INTEGER;

type DiscordThreadInitialMessageDelivery = Readonly<{
  starterMessageDelivered: boolean;
  deliveredChunkCount: number;
  deliveredMessageIds: readonly string[];
  failedChunkDelivery: "not_delivered" | "unknown";
  failedChunkIndex: number;
  totalChunkCount: number;
}>;

function resolveDiscordThreadStarterMessageId(thread: APIChannel): string {
  const starterMessage = "message" in thread ? thread.message : undefined;
  if (
    starterMessage &&
    typeof starterMessage === "object" &&
    "id" in starterMessage &&
    typeof starterMessage.id === "string"
  ) {
    return starterMessage.id;
  }
  return thread.id;
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

function describeDiscordThreadInitialMessageFailure(
  delivery?: DiscordThreadInitialMessageDelivery,
): string {
  if (delivery?.failedChunkDelivery === "unknown") {
    return delivery.deliveredChunkCount > 0
      ? "Discord thread was created, but delivery of the remaining initial content could not be confirmed"
      : "Discord thread was created, but initial message delivery could not be confirmed";
  }
  return delivery && delivery.deliveredChunkCount > 0
    ? "Discord thread was created, but its initial content was only partially delivered"
    : "Discord thread was created, but sending the initial message failed";
}

export class DiscordThreadInitialMessageError extends Error {
  readonly initialMessageDelivery?: DiscordThreadInitialMessageDelivery;
  readonly initialMessageError: string;
  readonly initialMessageWarning: string;
  readonly thread: APIChannel;

  constructor(
    thread: APIChannel,
    error: unknown,
    initialMessageDelivery?: DiscordThreadInitialMessageDelivery,
  ) {
    const initialMessageError = formatErrorMessage(error);
    const initialMessageWarning =
      describeDiscordThreadInitialMessageFailure(initialMessageDelivery);
    super(`${initialMessageWarning}: ${initialMessageError}`, { cause: error });
    this.name = "DiscordThreadInitialMessageError";
    this.initialMessageDelivery = initialMessageDelivery
      ? {
          ...initialMessageDelivery,
          deliveredMessageIds: [...initialMessageDelivery.deliveredMessageIds],
        }
      : undefined;
    this.initialMessageError = initialMessageError;
    this.initialMessageWarning = initialMessageWarning;
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
  const { rest, request } = createDiscordClient(opts);
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
  const initialMessageContent = isForumLike
    ? payload.content?.trim()
      ? payload.content
      : payload.name
    : payload.content?.trim()
      ? payload.content
      : "";
  const initialMessageChunks = buildDiscordTextChunks(initialMessageContent, {
    maxLinesPerMessage: DISCORD_THREAD_TRANSPORT_ONLY_MAX_LINES,
  });
  if (isForumLike) {
    const starterContent = initialMessageChunks[0] ?? payload.name;
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

  // Forum creation accepts exactly one starter message, so keep the first chunk in the
  // create request and deliver any remainder after Discord returns the new thread.
  const followupChunks = isForumLike ? initialMessageChunks.slice(1) : initialMessageChunks;
  if (followupChunks.length && "id" in thread) {
    const deliveredMessageIds = isForumLike ? [resolveDiscordThreadStarterMessageId(thread)] : [];
    let deliveredChunkCount = isForumLike ? 1 : 0;
    const firstFollowupChunkIndex = isForumLike ? 1 : 0;
    for (const [followupIndex, content] of followupChunks.entries()) {
      let chunkMayHaveDelivered = false;
      const trackedRequest: DiscordRetryRunner = (fn, label, options) =>
        request(
          async () => {
            try {
              return await fn();
            } catch (error) {
              chunkMayHaveDelivered ||= classifyDiscordDeliveryFailure(error) === "ambiguous";
              throw error;
            }
          },
          label,
          options,
        );
      try {
        const result = await sendDiscordText({
          rest,
          request: trackedRequest,
          channelId: thread.id,
          text: content,
          maxLinesPerMessage: DISCORD_THREAD_TRANSPORT_ONLY_MAX_LINES,
        });
        deliveredMessageIds.push(...result.platformMessageIds);
        deliveredChunkCount += 1;
      } catch (error) {
        const finalFailure = classifyDiscordDeliveryFailure(error);
        const failedChunkDelivery =
          chunkMayHaveDelivered || finalFailure === "ambiguous" || finalFailure === "unknown"
            ? "unknown"
            : "not_delivered";
        if (failedChunkDelivery === "unknown") {
          recordDiscordMessageCreateAmbiguity(error);
        }
        throw new DiscordThreadInitialMessageError(thread, error, {
          starterMessageDelivered: isForumLike,
          deliveredChunkCount,
          deliveredMessageIds,
          failedChunkDelivery,
          failedChunkIndex: firstFollowupChunkIndex + followupIndex,
          totalChunkCount: initialMessageChunks.length,
        });
      }
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
  const result = assertDiscordResponseObject(
    await searchGuildMessages(rest, query.guildId, params),
    "message search",
  );
  // Discord returns HTTP 202 with code 110000 while the guild search index is warming.
  if (result.code === 110000) {
    const message =
      typeof result.message === "string" && result.message.trim()
        ? result.message.trim()
        : "Discord search index is not yet available";
    const retryAfter = parseDiscordRetryAfterBodySeconds(result.retry_after);
    const retryHint = retryAfter === undefined ? "" : ` (retry after ${retryAfter}s)`;
    throw new Error(`Discord message search unavailable: ${message}${retryHint}`);
  }
  if (!Array.isArray(result.messages)) {
    throw new Error("Unexpected Discord response for message search: expected messages array.");
  }
  return result;
}
