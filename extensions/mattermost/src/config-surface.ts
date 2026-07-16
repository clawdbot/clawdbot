import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import { MattermostConfigSchema } from "./config-schema-core.js";

export const MattermostChannelConfigSchema = buildChannelConfigSchema(MattermostConfigSchema);
