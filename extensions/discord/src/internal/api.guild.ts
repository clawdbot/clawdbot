import {
  Routes,
  type APIChannel,
  type APIGuild,
  type APIGuildMember,
  type APIGuildScheduledEvent,
  type APIRole,
  type APIVoiceState,
  type RESTPostAPIGuildScheduledEventJSONBody,
} from "discord-api-types/v10";
import type { RequestClient, RequestData } from "./rest.js";

export async function getGuild(rest: RequestClient, guildId: string): Promise<APIGuild> {
  return (await rest.get(Routes.guild(guildId))) as APIGuild;
}

export async function createGuildChannel(
  rest: RequestClient,
  guildId: string,
  data: RequestData,
): Promise<APIChannel> {
  return (await rest.post(Routes.guildChannels(guildId), data)) as APIChannel;
}

export async function moveGuildChannels(
  rest: RequestClient,
  guildId: string,
  data: RequestData,
): Promise<void> {
  await rest.patch(Routes.guildChannels(guildId), data);
}

export async function getGuildMember(
  rest: RequestClient,
  guildId: string,
  userId: string,
): Promise<APIGuildMember> {
  return (await rest.get(Routes.guildMember(guildId, userId))) as APIGuildMember;
}

export async function listGuildRoles(rest: RequestClient, guildId: string): Promise<APIRole[]> {
  return (await rest.get(Routes.guildRoles(guildId))) as APIRole[];
}

export async function listGuildChannels(
  rest: RequestClient,
  guildId: string,
): Promise<APIChannel[]> {
  return (await rest.get(Routes.guildChannels(guildId))) as APIChannel[];
}

export async function putChannelPermission(
  rest: RequestClient,
  channelId: string,
  targetId: string,
  data: RequestData,
): Promise<void> {
  await rest.put(Routes.channelPermission(channelId, targetId), data);
}

export async function deleteChannelPermission(
  rest: RequestClient,
  channelId: string,
  targetId: string,
): Promise<void> {
  await rest.delete(Routes.channelPermission(channelId, targetId));
}

export async function listGuildActiveThreads(
  rest: RequestClient,
  guildId: string,
): Promise<unknown> {
  return await rest.get(Routes.guildActiveThreads(guildId));
}

export async function getGuildVoiceState(
  rest: RequestClient,
  guildId: string,
  userId: string,
): Promise<APIVoiceState> {
  return (await rest.get(Routes.guildVoiceState(guildId, userId))) as APIVoiceState;
}

export async function listGuildScheduledEvents(
  rest: RequestClient,
  guildId: string,
): Promise<APIGuildScheduledEvent[]> {
  return (await rest.get(Routes.guildScheduledEvents(guildId))) as APIGuildScheduledEvent[];
}

export async function createGuildScheduledEvent(
  rest: RequestClient,
  guildId: string,
  body: RESTPostAPIGuildScheduledEventJSONBody,
): Promise<APIGuildScheduledEvent> {
  return (await rest.post(Routes.guildScheduledEvents(guildId), {
    body,
  })) as APIGuildScheduledEvent;
}

export async function timeoutGuildMember(
  rest: RequestClient,
  guildId: string,
  userId: string,
  data: RequestData,
): Promise<APIGuildMember> {
  return (await rest.patch(Routes.guildMember(guildId, userId), data)) as APIGuildMember;
}

export async function addGuildMemberRole(
  rest: RequestClient,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await rest.put(Routes.guildMemberRole(guildId, userId, roleId));
}

export async function removeGuildMemberRole(
  rest: RequestClient,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await rest.delete(Routes.guildMemberRole(guildId, userId, roleId));
}

export async function removeGuildMember(
  rest: RequestClient,
  guildId: string,
  userId: string,
  data?: RequestData,
): Promise<void> {
  await rest.delete(Routes.guildMember(guildId, userId), data);
}

export async function createGuildBan(
  rest: RequestClient,
  guildId: string,
  userId: string,
  data?: RequestData,
): Promise<void> {
  await rest.put(Routes.guildBan(guildId, userId), data);
}

export async function listGuildEmojis(rest: RequestClient, guildId: string): Promise<unknown> {
  return await rest.get(Routes.guildEmojis(guildId));
}

export async function createGuildEmoji(
  rest: RequestClient,
  guildId: string,
  data: RequestData,
): Promise<unknown> {
  return await rest.post(Routes.guildEmojis(guildId), data);
}

export async function createGuildSticker(
  rest: RequestClient,
  guildId: string,
  data: RequestData,
): Promise<unknown> {
  return await rest.post(Routes.guildStickers(guildId), data);
}
