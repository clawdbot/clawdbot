import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Signal helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const signalChannelConfigUiHints = {
  "": {
    label: "Signal",
    help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Signal",
    dmPolicy: { channelKey: "signal" },
    configWrites: true,
  }),
  account: {
    label: "Signal Account",
    help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
  },
  configPath: {
    label: "Signal CLI Config Path",
    help: "Optional directory passed to signal-cli via --config when the service needs a non-default signal-cli data path.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
