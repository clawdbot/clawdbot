import { buildChannelConfigSchema, GoogleChatConfigSchema } from "../config-api.js";

export const GoogleChatChannelConfigSchema = buildChannelConfigSchema(GoogleChatConfigSchema);
