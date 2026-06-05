// Slack helper module supports config schema behavior.
import { buildChannelConfigSchema, SlackConfigSchema } from "../config-api.js";
import { slackChannelConfigUiHints } from "./config-ui-hints.js";

export const SlackChannelConfigSchema = buildChannelConfigSchema(SlackConfigSchema, {
  uiHints: slackChannelConfigUiHints,
});
