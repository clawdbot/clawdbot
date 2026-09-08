// Resolve Discord API runtime values within their owning workspace package.
import { createRequire } from "node:module";
import type * as DiscordApiTypes from "discord-api-types/v10";

const requireDiscordApiTypes = createRequire(import.meta.url);
const discordApiTypes = requireDiscordApiTypes("discord-api-types/v10") as typeof DiscordApiTypes;

export default discordApiTypes;
export const {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonStyle,
  ChannelType,
  ComponentType,
  GatewayCloseCodes,
  GatewayDispatchEvents,
  GatewayIntentBits,
  GatewayOpcodes,
  InteractionContextType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  PermissionFlagsBits,
  PresenceUpdateStatus,
  Routes,
  StickerFormatType,
  TextInputStyle,
} = discordApiTypes;
