// Msteams helper module supports config schema behavior.
import { buildChannelConfigSchema, MSTeamsConfigSchema } from "../config-api.js";
import { msTeamsChannelConfigUiHints } from "./config-ui-hints.js";

export const MSTeamsChannelConfigSchema = buildChannelConfigSchema(MSTeamsConfigSchema, {
  uiHints: msTeamsChannelConfigUiHints,
});
