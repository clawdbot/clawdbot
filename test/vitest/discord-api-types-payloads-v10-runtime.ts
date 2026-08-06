// Discord payload types runtime helper loads discord-api-types payloads at runtime.
import { createRequire } from "node:module";
import type * as DiscordPayloadApiTypes from "discord-api-types/payloads/v10";

const requireDiscordPayloadApiTypes = createRequire(import.meta.url);
const discordPayloadApiTypes = requireDiscordPayloadApiTypes(
  "discord-api-types/payloads/v10",
) as typeof DiscordPayloadApiTypes;

export default discordPayloadApiTypes;
export const { PollLayoutType } = discordPayloadApiTypes;
