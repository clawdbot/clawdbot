import { createRequire } from "node:module";
import type * as DiscordGatewayApiTypes from "discord-api-types/gateway/v10";

const requireDiscordGatewayApiTypes = createRequire(import.meta.url);
const discordGatewayApiTypes = requireDiscordGatewayApiTypes(
  "discord-api-types/gateway/v10",
) as typeof DiscordGatewayApiTypes;

export default discordGatewayApiTypes;
export const {
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  GatewayOpcodes,
  GatewayVersion,
  VoiceChannelEffectSendAnimationType,
} = discordGatewayApiTypes;
