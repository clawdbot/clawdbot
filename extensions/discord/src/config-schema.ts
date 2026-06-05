// Discord helper module supports config schema behavior.
import { buildChannelConfigSchema, DiscordConfigSchema } from "../config-api.js";
import { discordChannelConfigUiHints } from "./config-ui-hints.js";

export const DiscordChannelConfigSchema = buildChannelConfigSchema(DiscordConfigSchema, {
  uiHints: discordChannelConfigUiHints,
});
