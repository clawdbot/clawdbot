// Signal helper module supports config schema behavior.
import { buildChannelConfigSchema, SignalConfigSchema } from "../config-api.js";
import { signalChannelConfigUiHints } from "./config-ui-hints.js";

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema, {
  uiHints: signalChannelConfigUiHints,
});
