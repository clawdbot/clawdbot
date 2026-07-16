import { buildChannelConfigSchema, TelegramConfigSchema } from "../config-api.js";
import { telegramChannelConfigUiHints } from "./config-ui-hints.js";

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema, {
  uiHints: telegramChannelConfigUiHints,
});
