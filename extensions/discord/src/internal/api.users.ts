import { Routes, type APIChannel, type APIUser } from "discord-api-types/v10";
import type { RequestClient } from "./rest.js";

export async function getCurrentUser(rest: RequestClient): Promise<APIUser> {
  return (await rest.get(Routes.user("@me"))) as APIUser;
}

export async function getUser(rest: RequestClient, userId: string): Promise<APIUser> {
  return (await rest.get(Routes.user(userId))) as APIUser;
}

export async function createUserDmChannel(
  rest: RequestClient,
  recipientId: string,
): Promise<Pick<APIChannel, "id">> {
  return (await rest.post(Routes.userChannels(), {
    body: { recipient_id: recipientId },
  })) as Pick<APIChannel, "id">;
}
