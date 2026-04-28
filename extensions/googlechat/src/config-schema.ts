import { buildChannelConfigSchema, GoogleChatConfigSchema } from "../runtime-api.js";

export const GoogleChatChannelConfigSchema = buildChannelConfigSchema(GoogleChatConfigSchema);
