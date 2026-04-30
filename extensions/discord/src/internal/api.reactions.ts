import { Routes } from "discord-api-types/v10";
import type { RequestQuery } from "./rest-scheduler.js";
import type { RequestClient } from "./rest.js";

export async function createOwnMessageReaction(
  rest: RequestClient,
  channelId: string,
  messageId: string,
  encodedEmoji: string,
): Promise<void> {
  await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encodedEmoji));
}

export async function deleteOwnMessageReaction(
  rest: RequestClient,
  channelId: string,
  messageId: string,
  encodedEmoji: string,
): Promise<void> {
  await rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, encodedEmoji));
}

export async function listMessageReactionUsers(
  rest: RequestClient,
  channelId: string,
  messageId: string,
  encodedEmoji: string,
  query?: RequestQuery,
): Promise<Array<{ id: string; username?: string; discriminator?: string }>> {
  return (await rest.get(
    Routes.channelMessageReaction(channelId, messageId, encodedEmoji),
    query,
  )) as Array<{
    id: string;
    username?: string;
    discriminator?: string;
  }>;
}
