import { Routes, type APIChannel, type APIMessage } from "discord-api-types/v10";
import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient, RequestData } from "./rest.js";

export async function getChannel(rest: RequestClient, channelId: string): Promise<APIChannel> {
  return (await rest.get(Routes.channel(channelId))) as APIChannel;
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
  await rest.put(Routes.channelPin(channelId, messageId));
}

export async function unpinChannelMessage(
  rest: RequestClient,
  channelId: string,
  messageId: string,
): Promise<void> {
  await rest.delete(Routes.channelPin(channelId, messageId));
}

export async function listChannelPins(
  rest: RequestClient,
  channelId: string,
): Promise<APIMessage[]> {
  return (await rest.get(Routes.channelPins(channelId))) as APIMessage[];
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
