// Telegram API module exposes the plugin public contract.
export { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
export { TelegramConfigSchema } from "./src/config-schema.js";
export {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./src/command-config.js";
