// Discord plugin module implements api.messages behavior.
import {
  Routes,
  type APIChannel,
  type APIMessage,
  type APIThreadMember,
  type RESTGetAPIChannelMessagesPinsResult,
} from "discord-api-types/v10";
import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient, RequestData } from "./rest.js";

const DISCORD_MAX_CHANNEL_PINS = 250;
const DISCORD_PIN_PAGE_SIZE = 50;

export async function getChannel(rest: RequestClient, channelId: string): Promise<APIChannel> {
  return (await rest.get(Routes.channel(channelId))) as APIChannel;
}

export async function getThreadMember(
  rest: RequestClient,
  threadId: string,
  userId: string,
): Promise<APIThreadMember> {
  return (await rest.get(Routes.threadMembers(threadId, userId))) as APIThreadMember;
}

export async function editChannel(
  rest: RequestClient,
  channelId: string,
  data: RequestData,
): Promise<APIChannel> {
  return (await rest.patch(Routes.channel(channelId), data)) as APIChannel;
}

export async function deleteChannel(rest: RequestClient, channelId: string): Promise<void> {
  await rest.delete(Routes.channel(channelId));
}

export async function listChannelMessages(
  rest: RequestClient,
  channelId: string,
  query?: RequestQuery,
): Promise<APIMessage[]> {
  return (await rest.get(Routes.channelMessages(channelId), query)) as APIMessage[];
}

export async function getChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
): Promise<APIMessage> {
  return (await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage;
}

export async function createChannelMessage<T extends object = APIMessage>(
  rest: RequestClient,
  channelId: string,
  data: RequestData,
): Promise<T> {
  return (await rest.post(Routes.channelMessages(channelId), data)) as T;
}

export async function editChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
  data: RequestData,
): Promise<APIMessage> {
  return (await rest.patch(Routes.channelMessage(channelId, messageId), data)) as APIMessage;
}

export async function deleteChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
): Promise<void> {
  await rest.delete(Routes.channelMessage(channelId, messageId));
}

export async function pinChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
): Promise<void> {
  await rest.put(Routes.channelMessagesPin(channelId, messageId));
}

export async function unpinChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
): Promise<void> {
  await rest.delete(Routes.channelMessagesPin(channelId, messageId));
}

export async function listChannelPins(
  rest: RequestClient,
  channelId: string,
): Promise<APIMessage[]> {
  const messages: APIMessage[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  // Discord caps each page at 50 pins but may return fewer, so only the total bounds pages.
  for (let pageCount = 0; pageCount < DISCORD_MAX_CHANNEL_PINS; pageCount += 1) {
    const response = await rest.get(Routes.channelMessagesPins(channelId), {
      limit: DISCORD_PIN_PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Discord returned an invalid channel pin response");
    }

    const page = response as RESTGetAPIChannelMessagesPinsResult;
    if (
      !Array.isArray(page.items) ||
      page.items.length > DISCORD_PIN_PAGE_SIZE ||
      typeof page.has_more !== "boolean"
    ) {
      throw new Error("Discord returned an invalid channel pin response");
    }
    for (const pin of page.items) {
      if (
        !pin ||
        typeof pin !== "object" ||
        typeof pin.pinned_at !== "string" ||
        !pin.pinned_at.trim() ||
        !pin.message ||
        typeof pin.message !== "object" ||
        Array.isArray(pin.message)
      ) {
        throw new Error("Discord returned an invalid channel pin");
      }
      messages.push(pin.message);
    }
    if (messages.length > DISCORD_MAX_CHANNEL_PINS) {
      throw new Error(`Discord channel pin pagination exceeded ${DISCORD_MAX_CHANNEL_PINS} pins`);
    }
    if (!page.has_more) {
      return messages;
    }

    // Pin pagination uses the last pin timestamp, not the message snowflake.
    const nextCursor = page.items.at(-1)?.pinned_at.trim();
    if (!nextCursor) {
      throw new Error("Discord channel pin pagination returned a missing cursor");
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Discord channel pin pagination returned a repeated cursor");
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  throw new Error(`Discord channel pin pagination exceeded ${DISCORD_MAX_CHANNEL_PINS} pins`);
}

export async function sendChannelTyping(rest: RequestClient, channelId: string): Promise<void> {
  await rest.post(Routes.channelTyping(channelId));
}

export async function createThread<T extends object = APIChannel>(
  rest: RequestClient,
  channelId: string,
  data: RequestData,
  messageId?: string,
): Promise<T> {
  const route = messageId ? Routes.threads(channelId, messageId) : Routes.threads(channelId);
  return (await rest.post(route, data)) as T;
}

export async function listChannelArchivedThreads(
  rest: RequestClient,
  channelId: string,
  query?: RequestQuery,
): Promise<unknown> {
  return await rest.get(Routes.channelThreads(channelId, "public"), query);
}

export async function searchGuildMessages(
  rest: RequestClient,
  guildId: string,
  params: URLSearchParams,
): Promise<unknown> {
  return await rest.get(`/guilds/${guildId}/messages/search?${params.toString()}`);
}
