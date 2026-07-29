// Googlechat helper module supports config schema behavior.
import { buildChannelConfigSchema, GoogleChatConfigSchema } from "../config-api.js";

export const GoogleChatChannelConfigSchema = buildChannelConfigSchema(GoogleChatConfigSchema);
