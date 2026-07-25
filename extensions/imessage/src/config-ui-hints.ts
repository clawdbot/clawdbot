import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Imessage helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const iMessageChannelConfigUiHints = {
  "": {
    label: "iMessage",
    help: "iMessage channel provider configuration for CLI integration and DM access policy handling. Use explicit CLI paths when runtime environments have non-standard binary locations.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "iMessage",
    dmPolicy: { channelKey: "imessage" },
    configWrites: true,
  }),
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  cliPath: {
    label: "iMessage CLI Path",
    help: "Filesystem path to the iMessage bridge CLI binary used for send/receive operations. Set explicitly when the binary is not on PATH in service runtime environments.",
  },
  sendTransport: {
    label: "iMessage Send Transport",
    help: 'Preferred imsg RPC send transport for normal outbound replies. "auto" uses the IMCore bridge when available, "bridge" requires it, and "applescript" forces Messages automation.',
  },
} satisfies Record<string, ChannelConfigUiHint>;
