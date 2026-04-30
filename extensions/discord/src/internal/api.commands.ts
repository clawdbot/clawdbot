import { Routes, type APIApplicationCommand } from "discord-api-types/v10";
import type { RequestClient } from "./rest.js";

export async function listApplicationCommands(
  rest: RequestClient,
  clientId: string,
): Promise<APIApplicationCommand[]> {
  return (await rest.get(Routes.applicationCommands(clientId))) as APIApplicationCommand[];
}

export async function createApplicationCommand(
  rest: RequestClient,
  clientId: string,
  body: unknown,
): Promise<unknown> {
  return await rest.post(Routes.applicationCommands(clientId), { body });
}

export async function editApplicationCommand(
  rest: RequestClient,
  clientId: string,
  commandId: string,
  body: unknown,
): Promise<unknown> {
  return await rest.patch(Routes.applicationCommand(clientId, commandId), { body });
}

export async function deleteApplicationCommand(
  rest: RequestClient,
  clientId: string,
  commandId: string,
): Promise<void> {
  await rest.delete(Routes.applicationCommand(clientId, commandId));
}

export async function overwriteApplicationCommands(
  rest: RequestClient,
  clientId: string,
  body: unknown,
): Promise<void> {
  await rest.put(Routes.applicationCommands(clientId), { body });
}

export async function overwriteGuildApplicationCommands(
  rest: RequestClient,
  clientId: string,
  guildId: string,
  body: unknown,
): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
}
